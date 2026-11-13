package manager

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// Fixed enums only: provider HTTP status is not available in the frozen Worker.
func liveWorkerClass(raw []byte) string {
	var v struct {
		Error string `json:"error"`
	}
	if len(raw) > 4096 || json.Unmarshal(raw, &v) != nil {
		return "UNKNOWN"
	}
	codes := map[string]string{"timed_out": "TIMEOUT", "cancelled": "CANCELLED", "limit": "BUDGET_OR_SIZE_LIMIT", "provider_failed": "PROVIDER_FAILED", "invalid_response": "RESPONSE_SCHEMA_OR_GUARD", "invalid_input": "INPUT_SCHEMA", "tool_failed": "TOOL_REJECTED", "sensitive_output": "SENSITIVE_OUTPUT_GUARD", "skill_unavailable": "SKILL_SNAPSHOT", "security_unavailable": "SECURITY_GUARD"}
	for code, class := range codes {
		if v.Error == "Author task "+code+"; provider and browser details are hidden" {
			return class
		}
	}
	return "UNKNOWN"
}
func liveWorkerFileClass(work string) string {
	f, e := os.Open(filepath.Join(work, "output", "result.json"))
	if e != nil {
		return "UNKNOWN"
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 4097))
	if e != nil {
		return "UNKNOWN"
	}
	return liveWorkerClass(b)
}

type liveHTTPObservation struct {
	mu         sync.Mutex
	base       http.RoundTripper
	ok, failed int
	statuses   map[int]int
	codes      map[string]int
	names      map[string]int
}

func liveHTTPCode(raw []byte) string {
	var v struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &v) != nil {
		return "UNKNOWN"
	}
	switch v.Error.Code {
	case "invalid_request", "protected_transport_required", "unauthorized", "history_unavailable", "conflict", "not_found", "internal_error":
		return v.Error.Code
	}
	return "UNKNOWN"
}
func (o *liveHTTPObservation) RoundTrip(r *http.Request) (*http.Response, error) {
	name := "OTHER"
	if r.GetBody != nil && bytes.HasSuffix([]byte(r.URL.Path), []byte("/tools")) {
		body, err := r.GetBody()
		if err == nil {
			var envelope struct {
				Name string `json:"name"`
			}
			if json.NewDecoder(io.LimitReader(body, moduleToolFrameLimit+1)).Decode(&envelope) == nil {
				switch envelope.Name {
				case "catalog_search", "catalog_get", "propose_plan":
					name = envelope.Name
				}
			}
			body.Close()
		}
	}
	resp, err := o.base.RoundTrip(r)
	if !bytes.HasSuffix([]byte(r.URL.Path), []byte("/tools")) {
		return resp, err
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.names == nil {
		o.names = map[string]int{}
	}
	o.names[name]++
	if err != nil {
		o.codes["UNKNOWN"]++
		return resp, err
	}
	if resp.StatusCode == 200 {
		o.ok++
	} else {
		o.failed++
		if resp.StatusCode >= 100 && resp.StatusCode <= 599 {
			o.statuses[resp.StatusCode]++
		}
		// Replay the inspected prefix exactly; preserve the production body and close.
		prefix, _ := io.ReadAll(io.LimitReader(resp.Body, 4097))
		resp.Body = &liveReplayBody{Reader: io.MultiReader(bytes.NewReader(prefix), resp.Body), Closer: resp.Body}
		code := "UNKNOWN"
		if len(prefix) <= 4096 {
			code = liveHTTPCode(prefix)
		}
		o.codes[code]++
	}
	return resp, err
}

type liveReplayBody struct {
	io.Reader
	io.Closer
}

func TestM106LiveDiagnosticWhitelist(t *testing.T) {
	for _, code := range []string{"timed_out", "limit", "provider_failed", "invalid_response", "tool_failed", "sensitive_output"} {
		raw, _ := json.Marshal(map[string]string{"error": "Author task " + code + "; provider and browser details are hidden"})
		if liveWorkerClass(raw) == "UNKNOWN" {
			t.Fatal("known code rejected")
		}
	}
	secret := "https://synthetic.invalid/SECRET_SENTINEL"
	for _, raw := range [][]byte{[]byte(secret), []byte(`{"error":"` + secret + `"}`), []byte(`{"error":"Author task limit; provider and browser details are hidden ` + secret + `"}`), bytes.Repeat([]byte("x"), 4097)} {
		if liveWorkerClass(raw) != "UNKNOWN" {
			t.Fatal("unknown accepted")
		}
	}
	if liveHTTPCode([]byte(`{"error":{"code":"unauthorized","message":"`+secret+`"}}`)) != "unauthorized" || liveHTTPCode([]byte(`{"error":{"code":"`+secret+`"}}`)) != "UNKNOWN" {
		t.Fatal("HTTP whitelist")
	}
}

type liveRoundTripFunc func(*http.Request) (*http.Response, error)

func (f liveRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestM106LiveDiagnosticTransport(t *testing.T) {
	secret := "https://synthetic.invalid/SECRET_SENTINEL"
	body := `{"error":{"code":"history_unavailable","message":"` + secret + `"}}`
	o := &liveHTTPObservation{statuses: map[int]int{}, codes: map[string]int{}, base: liveRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 409, Body: io.NopCloser(bytes.NewBufferString(body))}, nil
	})}
	req, _ := http.NewRequest("POST", "https://synthetic.invalid/runs/a/tools", nil)
	resp, e := o.RoundTrip(req)
	if e != nil {
		t.Fatal("transport failed")
	}
	got, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != body || o.failed != 1 || o.ok != 0 || o.codes["history_unavailable"] != 1 || o.statuses[409] != 1 {
		t.Fatal("response changed or counters incorrect")
	}
	safe, _ := json.Marshal(map[string]any{"codes": o.codes, "statuses": o.statuses})
	if bytes.Contains(safe, []byte(secret)) {
		t.Fatal("unsafe diagnostic")
	}
	o.base = liveRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewBufferString(body))}, nil
	})
	resp, _ = o.RoundTrip(req)
	got, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(got) != body || o.ok != 1 {
		t.Fatal("success changed")
	}
}

func TestM106LiveDiagnosticToolNames(t *testing.T) {
	for _, name := range []string{"catalog_search", "catalog_get", "propose_plan", "https://synthetic.invalid/SECRET_SENTINEL"} {
		raw, _ := json.Marshal(map[string]any{"name": name, "arguments": map[string]string{"query": "SECRET_SENTINEL"}})
		o := &liveHTTPObservation{statuses: map[int]int{}, codes: map[string]int{}, base: liveRoundTripFunc(func(r *http.Request) (*http.Response, error) {
			got, _ := io.ReadAll(r.Body)
			if !bytes.Equal(got, raw) {
				t.Fatal("request altered")
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(nil))}, nil
		})}
		req, _ := http.NewRequest("POST", "https://synthetic.invalid/tools", bytes.NewReader(raw))
		resp, _ := o.RoundTrip(req)
		resp.Body.Close()
		want := name
		if name == "https://synthetic.invalid/SECRET_SENTINEL" {
			want = "OTHER"
		}
		if o.names[want] != 1 {
			t.Fatal("name counter")
		}
		safe, _ := json.Marshal(o.names)
		if bytes.Contains(safe, []byte("SECRET_SENTINEL")) {
			t.Fatal("name leakage")
		}
	}
}
