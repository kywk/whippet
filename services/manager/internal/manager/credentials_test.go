package manager

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestM8BScriptOriginPassesInputAndJournalAndNeverDefaultsToManual(t *testing.T) {
	m, _, _ := lifecycleManager(t, 1)
	for _, source := range []string{"manual", "ai", ""} {
		d := m8Dispatch(t)
		d.ScriptOrigin = source
		r := record{RunID: newID(), AttemptID: newID(), Kind: "author", Phase: "accepted", ResultMessageID: newID(), TimeoutMS: 180000, Author: d.Author, WorkspaceID: d.WorkspaceID, TestID: d.TestID, WorkspaceContext: d.WorkspaceContext, ScriptOrigin: source}
		if err := m.store(r); err != nil {
			t.Fatal(err)
		}
		if err := m.prepare(r, d); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
		if err != nil {
			t.Fatal(err)
		}
		var input WorkerInput
		if json.Unmarshal(raw, &input) != nil || input.ScriptOrigin != normalizedScriptOrigin(source) {
			t.Fatal("input lost trusted script origin")
		}
		records, err := loadRecords(m.cfg.WorkDir)
		if err != nil || records[r.AttemptID].ScriptOrigin != normalizedScriptOrigin(source) {
			t.Fatal("journal lost source or guessed manual", err)
		}
	}
}

func credentialFixture(t *testing.T) (record, credentialRequest, credentialValues) {
	t.Helper()
	d := m8Dispatch(t)
	role, ref := newID(), newID()
	config := m8Config()
	config["loginRoles"] = []any{map[string]any{"roleId": role, "name": "合成角色", "loginMethod": "form", "loginOrigin": "https://example.test"}}
	d.WorkspaceContext, _ = json.Marshal(map[string]any{"schemaVersion": "1", "workspaceId": d.WorkspaceID, "settingsRevision": 1, "config": config, "roleRefs": []any{map[string]any{"roleId": role, "secretRef": ref, "secretVersion": 1, "configured": true}}})
	r := record{RunID: newID(), AttemptID: newID(), WorkspaceID: d.WorkspaceID, WorkspaceContext: d.WorkspaceContext}
	q := credentialRequest{Kind: "credential_request", RequestID: newID(), AttemptID: r.AttemptID, RoleID: role, SecretRef: ref, SecretVersion: 1}
	v := credentialValues{r.WorkspaceID, r.RunID, r.AttemptID, role, ref, 1, "https://example.test", "synthetic-user", "synthetic-secret"}
	return r, q, v
}
func TestM8BCredentialResolveRequiresTLSOwnerOriginNoStoreAndRejectsRedirect(t *testing.T) {
	r, q, v := credentialFixture(t)
	mode := "good"
	calls := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		calls++
		if req.Header.Get("Authorization") != "Bearer synthetic-token" {
			t.Error("missing manager auth")
		}
		w.Header().Set("Cache-Control", "no-store")
		switch mode {
		case "redirect":
			w.Header().Set("Location", "/other")
			w.WriteHeader(302)
			return
		case "wrong":
			v.WorkspaceID = newID()
		case "nostore":
			w.Header().Del("Cache-Control")
		}
		json.NewEncoder(w).Encode(v)
	}))
	defer server.Close()
	cfg := Config{ServerURL: server.URL, Token: "synthetic-token"}
	values, err := resolveCredentials(context.Background(), cfg, r, q, server.Client())
	if err != nil || values.Password != "synthetic-secret" {
		t.Fatal("TLS resolve failed", err)
	}
	for _, bad := range []string{"redirect", "nostore", "wrong"} {
		mode = bad
		if _, err := resolveCredentials(context.Background(), cfg, r, q, server.Client()); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	if calls != 4 {
		t.Fatal("redirect retried")
	}
	cfg.ServerURL = strings.Replace(cfg.ServerURL, "https:", "http:", 1)
	if _, err := resolveCredentials(context.Background(), cfg, r, q, server.Client()); err == nil {
		t.Fatal("accepted plaintext")
	}
}
func TestM8BCredentialStdoutIsConsumedAndCancelledRequestNeverReceivesValues(t *testing.T) {
	r, q, _ := credentialFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var input bytes.Buffer
	logs := 0
	channel := credentialChannel{ctx: ctx, cfg: Config{ServerURL: "https://invalid.test"}, r: r, input: &input, client: newHTTPClient()}
	writer := lineWriter{emit: func(string, string) { logs++ }, intercept: channel.handle}
	data, _ := json.Marshal(q)
	writer.Write(append(data[:len(data)/2], []byte{}...))
	writer.Write(append(data[len(data)/2:], '\n'))
	if logs != 0 || input.Len() != 0 {
		t.Fatal("credential frame escaped metadata channel or late value sent")
	}
}
func TestM8BRealZIPAndHTMLRedactionPreservesFailureStats(t *testing.T) {
	var zipped bytes.Buffer
	w := zip.NewWriter(&zipped)
	entry, _ := w.Create("report.json")
	entry.Write([]byte(`{"stats":{"expected":0,"unexpected":1},"errors":[{"message":"secret 1"}]}`))
	w.Close()
	html := []byte(`<script>const stable='1';</script><template>data:application/zip;base64,` + base64.StdEncoding.EncodeToString(zipped.Bytes()) + `</template>`)
	cleaned, err := scrubCredentialBytes(html, secretReplacer([]string{"1"}), 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cleaned), "stable='1'") {
		t.Fatal("native JS shell modified")
	}
	match := embeddedReportZIP.FindSubmatch(cleaned)
	raw, _ := base64.StdEncoding.DecodeString(string(match[1]))
	reader, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	file, _ := reader.File[0].Open()
	body, _ := io.ReadAll(file)
	file.Close()
	var value struct {
		Stats  struct{ Expected, Unexpected int }
		Errors []struct{ Message string }
	}
	if json.Unmarshal(body, &value) != nil || value.Stats.Unexpected != 1 || value.Stats.Expected != 0 || !strings.Contains(value.Errors[0].Message, "[redacted]") {
		t.Fatal("redaction changed real failure", string(body))
	}
}
