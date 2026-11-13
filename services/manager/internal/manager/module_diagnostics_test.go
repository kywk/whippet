package manager

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

const m109Safe = `{"selfTestPassedCount":1,"selfTestFailedCount":1,"checkpointCreated":true,"checkpointPresentAtFinalize":true,"checkpointRetainedAfterSecretGuard":true,"terminalClass":"LIMIT"}`

func TestM109WhitelistSingleTerminal(t *testing.T) {
	d := newM109Diagnostic()
	for _, raw := range []string{strings.Replace(m109Safe, `"LIMIT"`, `"SECRET_SENTINEL"`, 1), strings.Replace(m109Safe, `"selfTestPassedCount":1`, `"selfTestPassedCount":null`, 1), strings.Replace(m109Safe, `"selfTestPassedCount":1`, `"selfTestPassedCount":99`, 1), strings.Replace(m109Safe, `{`, `{"extra":"SECRET_SENTINEL",`, 1), strings.Replace(m109Safe, `{`, `{"terminalClass":"LIMIT",`, 1), m109Safe + "SECRET_SENTINEL", strings.Repeat("x", 4097)} {
		if !d.consume(m109Prefix+raw) || d.WorkerObserved {
			t.Fatal("invalid diagnostic accepted")
		}
	}
	d.consume(m109Prefix + m109Safe)
	d.consume(m109Prefix + strings.Replace(m109Safe, "LIMIT", "COMPLETED", 1))
	if !d.WorkerObserved || d.Worker.TerminalClass != "LIMIT" {
		t.Fatal("multiple terminals")
	}
	raw, _ := json.Marshal(d)
	if strings.Contains(string(raw), "SECRET_SENTINEL") {
		t.Fatal("leak")
	}
}
func TestM109SidecarExclusiveNoSymlink(t *testing.T) {
	root := t.TempDir()
	id := newID()
	d := newM109Diagnostic()
	d.consume(m109Prefix + m109Safe)
	if err := writeM109(root, id, d); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "diagnostics", id+".json")
	raw, _ := os.ReadFile(path)
	if len(raw) > 4096 {
		t.Fatal("size")
	}
	if err := writeM109(root, id, d); err == nil {
		t.Fatal("overwrite")
	}
	outside := t.TempDir()
	root2 := t.TempDir()
	os.Symlink(outside, filepath.Join(root2, "diagnostics"))
	if writeM109(root2, newID(), d) == nil {
		t.Fatal("followed directory link")
	}
	target := filepath.Join(outside, "sentinel")
	os.WriteFile(target, []byte("unchanged"), 0600)
	linked := newID()
	os.Symlink(target, filepath.Join(root, "diagnostics", linked+".json"))
	if writeM109(root, linked, d) == nil {
		t.Fatal("followed file link")
	}
	got, _ := os.ReadFile(target)
	if string(got) != "unchanged" {
		t.Fatal("changed target")
	}
}
func TestM109ParserOnOffAndFlag(t *testing.T) {
	r := record{Kind: "author"}
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "output"), 0700)
	for _, body := range []string{`{"status":"failed","error":"SECRET_SENTINEL"}`, `{"status":"succeeded"}`, `not json`} {
		os.WriteFile(filepath.Join(dir, "output/result.json"), []byte(body), 0600)
		a, aa := collectAttemptResult(r, dir, execution{ExitCode: 0})
		d := newM109Diagnostic()
		b, bb := collectAttemptResult(r, dir, execution{ExitCode: 0}, d)
		if !reflect.DeepEqual(a, b) || !reflect.DeepEqual(aa, bb) {
			t.Fatal("diagnostics changed result")
		}
		raw, _ := json.Marshal(d)
		if strings.Contains(string(raw), "SECRET_SENTINEL") {
			t.Fatal("error leaked")
		}
	}
	cli := dockerCLI{cfg: Config{WorkerImage: "fixture"}}
	for _, flag := range []string{"", "0", "1"} {
		t.Setenv("WHIPPET_M109_DIAGNOSTICS", flag)
		args := strings.Join(cli.createArgs(r, "/work"), " ")
		if strings.Contains(args, "WHIPPET_M109_DIAGNOSTICS=1") != (flag == "1") {
			t.Fatal("flag mismatch")
		}
		if strings.Contains(strings.Join(cli.createArgs(record{Kind: "run"}, "/work"), " "), "WHIPPET_M109") {
			t.Fatal("regular run flag")
		}
	}
}
func TestM109LifecycleDisabledAndWriterFailure(t *testing.T) {
	for _, mode := range []string{"off", "on", "blocked"} {
		t.Run(mode, func(t *testing.T) {
			if mode == "off" {
				t.Setenv("WHIPPET_M109_DIAGNOSTICS", "0")
			} else {
				t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
			}
			m, _, ctx := lifecycleManager(t, 1)
			r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "collecting", Reclaimed: true, ResultMessageID: newID(), Result: &Result{Status: "failed", Error: "synthetic failure"}}
			if mode == "blocked" {
				os.WriteFile(filepath.Join(m.cfg.WorkDir, "diagnostics"), []byte("keep"), 0600)
			}
			if err := m.store(r); err != nil {
				t.Fatal(err)
			}
			m.runAttempt(ctx, ctx, r, nil)
			saved := journalRecord(m, r.AttemptID)
			if saved.Phase != "complete" || saved.Result.Status != "failed" || saved.Result.Error != "synthetic failure" {
				t.Fatal("diagnostics altered lifecycle")
			}
			_, err := os.Stat(filepath.Join(m.cfg.WorkDir, "diagnostics", r.AttemptID+".json"))
			if (err == nil) != (mode == "on") {
				t.Fatal("sidecar gate")
			}
		})
	}
}

type m109Runtime struct{}

func (m109Runtime) Remove(context.Context, record) error { return nil }
func (m109Runtime) Execute(_ context.Context, _ record, dir string, emit func(string, string)) execution {
	os.Mkdir(filepath.Join(dir, "output"), 0700)
	atomicJSON(filepath.Join(dir, "output/result.json"), Result{Status: "succeeded"})
	atomicJSON(filepath.Join(dir, "output/author.json"), map[string]any{"message": "synthetic", "requestValidation": false})
	emit("log", m109Prefix+strings.Replace(m109Safe, "LIMIT", "COMPLETED", 1))
	return execution{ExitCode: 0}
}
func TestM109ArtifactUploadDisposition(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(strconv.FormatBool(failed), func(t *testing.T) {
			t.Setenv("WHIPPET_M109_DIAGNOSTICS", "1")
			m, _, parent := lifecycleManager(t, 1)
			ctx, cancel := context.WithCancel(parent)
			defer cancel()
			m.docker = m109Runtime{}
			m.http.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				if failed {
					cancel()
					return nil, errors.New("SECRET_SENTINEL")
				}
				return &http.Response{StatusCode: 201, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(""))}, nil
			})
			r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "accepted", TimeoutMS: 180000, ResultMessageID: newID()}
			if err := m.store(r); err != nil {
				t.Fatal(err)
			}
			dispatch := authorDispatch()
			m.runAttempt(ctx, ctx, r, &dispatch)
			raw, err := os.ReadFile(filepath.Join(m.cfg.WorkDir, "diagnostics", r.AttemptID+".json"))
			if err != nil {
				t.Fatal(err)
			}
			var got m109Diagnostic
			if json.Unmarshal(raw, &got) != nil {
				t.Fatal("diagnostic parse")
			}
			if !got.WorkerObserved || !got.Manager.AuthorParserAccepted || !got.Manager.UploadAttempted || got.Manager.UploadAccepted == failed {
				t.Fatal("incorrect observations")
			}
			expected := "ACCEPTED"
			if failed {
				expected = "UPLOAD_FAILED"
			}
			if got.Manager.Disposition != expected || strings.Contains(string(raw), "SECRET_SENTINEL") {
				t.Fatal("disposition or leakage")
			}
		})
	}
}

func TestM109V2StrictVersions(t *testing.T) {
	v2 := strings.Replace(m109Safe, "{", `{"schemaVersion":2,"lastSelfTestFailureClass":"TEST_FAILED",`, 1)
	for _, raw := range []string{m109Safe, v2} {
		d := newM109Diagnostic()
		d.consume(m109Prefix + raw)
		if !d.WorkerObserved {
			t.Fatal("valid version rejected")
		}
		body, _ := json.Marshal(d)
		if raw == m109Safe {
			if d.SchemaVersion != 1 || strings.Contains(string(body), "lastSelfTestFailureClass") {
				t.Fatal("v1 shape changed")
			}
		} else {
			if d.SchemaVersion != 2 || d.Worker.LastSelfTestFailureClass != "TEST_FAILED" {
				t.Fatal("v2 lost")
			}
			if strings.Count(string(body), "schemaVersion") != 1 {
				t.Fatal("nested version leaked")
			}
		}
	}
	for _, raw := range []string{
		strings.Replace(v2, `"schemaVersion":2,`, "", 1),
		strings.Replace(v2, `"schemaVersion":2`, `"schemaVersion":1`, 1),
		strings.Replace(v2, `"schemaVersion":2`, `"schemaVersion":null`, 1),
		strings.Replace(v2, `"lastSelfTestFailureClass":"TEST_FAILED",`, "", 1),
		strings.Replace(v2, "TEST_FAILED", "ASSERTION", 1),
		strings.Replace(v2, "TEST_FAILED", "TIMEOUT SECRET_SENTINEL", 1),
		strings.Replace(v2, `"TEST_FAILED"`, `null`, 1),
		strings.Replace(v2, `{`, `{"schemaVersion":2,`, 1),
		strings.Replace(v2, `{`, `{"extra":"SECRET_SENTINEL",`, 1),
	} {
		d := newM109Diagnostic()
		d.consume(m109Prefix + raw)
		if d.WorkerObserved {
			t.Fatal("invalid payload accepted")
		}
		body, _ := json.Marshal(d)
		if strings.Contains(string(body), "SECRET_SENTINEL") {
			t.Fatal("leak")
		}
	}
	for _, category := range []string{"INVALID_SPEC", "GUARD", "TIMEOUT", "CANCELLED", "TEST_FAILED", "UNKNOWN"} {
		value, ok := decodeM109([]byte(strings.Replace(v2, "TEST_FAILED", category, 1)))
		if !ok || value.LastSelfTestFailureClass != category {
			t.Fatal("enum rejected")
		}
	}
}

func TestM109InvalidResponseTerminal(t *testing.T) {
	v1 := strings.Replace(m109Safe, "LIMIT", "INVALID_RESPONSE", 1)
	v2 := strings.Replace(v1, "{", `{"schemaVersion":2,"lastSelfTestFailureClass":"UNKNOWN",`, 1)
	for _, raw := range []string{v1, v2} {
		value, ok := decodeM109([]byte(raw))
		if !ok || value.TerminalClass != "INVALID_RESPONSE" {
			t.Fatal("fixed enum rejected")
		}
		for _, bad := range []string{"MODEL_RESPONSE_INVALID", "INVALID_RESPONSE SECRET_SENTINEL"} {
			if _, ok := decodeM109([]byte(strings.Replace(raw, "INVALID_RESPONSE", bad, 1))); ok {
				t.Fatal("unknown enum accepted")
			}
		}
	}
}
