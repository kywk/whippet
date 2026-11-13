//go:build integration && m10bridge

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Test-only observation: never emits request bytes, argument keys/values or errors.
// The real handler receives identical bytes and retains all authorization/guards.
func bridgeRequestClass(raw []byte, registry *ToolRegistry) (string, string) {
	var q HarnessToolRequest
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if len(raw) > maxHarnessFrameBytes || d.Decode(&q) != nil || d.Decode(new(any)) != io.EOF {
		return "OTHER", "ENVELOPE"
	}
	name := "OTHER"
	switch q.Name {
	case "catalog_search", "catalog_next_page", "catalog_get", "propose_plan":
		name = q.Name
	}
	if !ValidID(q.CallID) {
		return name, "CALL_ID"
	}
	tool, ok := registry.tool(q.Name)
	if !ok || tool.Side != "server" {
		return name, "TOOL"
	}
	if _, err := validateToolArguments(tool, q.Arguments); err != nil {
		return name, "ARGUMENT_SCHEMA"
	}
	if _, _, err := decodeHarnessRequest(raw, registry); err != nil {
		return name, "REQUEST_GUARD"
	}
	return name, "DECODE_ACCEPTED"
}

type bridgeStatusWriter struct {
	http.ResponseWriter
	status int
}

func (w *bridgeStatusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func observeBridgeTools(t *testing.T, next http.Handler, registry *ToolRegistry, workspace string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/tools") {
			next.ServeHTTP(w, r)
			return
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, maxHarnessFrameBytes+1))
		if err != nil || len(raw) > maxHarnessFrameBytes {
			// Preserve unread bytes and the original reader's behavior.
			r.Body = struct {
				io.Reader
				io.Closer
			}{io.MultiReader(bytes.NewReader(raw), r.Body), r.Body}
			next.ServeHTTP(w, r)
			return
		}
		r.Body = struct {
			io.Reader
			io.Closer
		}{bytes.NewReader(raw), r.Body}
		name, reason := bridgeRequestClass(raw, registry)
		status := &bridgeStatusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(status, r)
		if status.status == 400 && reason == "DECODE_ACCEPTED" {
			reason = "STORE_SEMANTIC"
		}
		t.Logf("serverToolDiagnostic tool=%s reason=%s status=%d", name, reason, status.status)
	})
}

func TestM106BridgeRequestDiagnostics(t *testing.T) {
	r, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, args, want string }{
		{"catalog_search", `{"query":"setup","limit":1,"cursor":null}`, "ARGUMENT_SCHEMA"},
		{"catalog_search", `{"query":"setup","limit":1}`, "DECODE_ACCEPTED"},
		{"catalog_search", `{"query":"setup","limit":"1","cursor":null}`, "ARGUMENT_SCHEMA"},
		{"catalog_search", `{"query":"setup","limit":1,"cursor":""}`, "ARGUMENT_SCHEMA"},
		{"catalog_get", `{"moduleVersionId":"not-uuid"}`, "ARGUMENT_SCHEMA"},
		{"catalog_get", `{"moduleVersionId":"00000000-0000-4000-8000-000000000001"}`, "DECODE_ACCEPTED"},
	} {
		raw, _ := json.Marshal(HarnessToolRequest{CallID: NewID(), Name: tc.name, Arguments: json.RawMessage(tc.args)})
		name, reason := bridgeRequestClass(raw, r)
		if name != tc.name || reason != tc.want {
			t.Fatalf("classification mismatch: %s %s", name, reason)
		}
		_, _, err := decodeHarnessRequest(raw, r)
		if (err == nil) != (tc.want == "DECODE_ACCEPTED") {
			t.Fatal("diagnosis changed acceptance")
		}
	}
}
