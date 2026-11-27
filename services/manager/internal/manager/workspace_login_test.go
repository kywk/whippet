package manager

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loginVerificationDispatch() (Dispatch, loginBinding) {
	config := m8Config()
	config["dependencies"] = []any{map[string]string{"name": "共用登入", "purpose": "login", "origin": "https://auth.example.test"}}
	binding := loginBinding{AccountID: newID(), TargetOrigin: "https://example.test", LoginConfigVersion: newID(),
		EntryURL: "https://auth.example.test/login", SecretRef: newID(), SecretVersion: 3,
		Form:    json.RawMessage(`{"usernameSelector":"#user","passwordSelector":"#password","submitSelector":"button"}`),
		Success: json.RawMessage(`{"url":"https://example.test/private","visibleSelector":"#account"}`)}
	d := Dispatch{Kind: workspaceLoginVerificationKind, ScriptOrigin: "legacy", TimeoutMS: 30_000, WorkspaceID: newID(), TestID: json.RawMessage("null")}
	d.WorkspaceContext, _ = json.Marshal(map[string]any{"schemaVersion": "1", "workspaceId": d.WorkspaceID, "settingsRevision": 4, "config": config, "roleRefs": []any{}})
	d.LoginVerification, _ = json.Marshal(map[string]any{"proposalId": newID(), "baseRevision": 4, "contextRevision": 5, "scopeHash": strings.Repeat("a", 64), "binding": binding})
	return d, binding
}

func TestWLA2DispatchJournalAndTrustedEvidence(t *testing.T) {
	d, _ := loginVerificationDispatch()
	env := message("manager-test", "dispatch", newID(), newID(), d)
	var decoded Dispatch
	if err := json.Unmarshal(env.Payload, &decoded); err != nil || validDispatch(decoded) != nil {
		t.Fatalf("valid verification dispatch rejected: %v", err)
	}
	for _, extra := range []string{`"author":null`, `"files":[]`, `"retest":null`, `"script":"arbitrary"`, `"loginVerification":null`} {
		if json.Unmarshal([]byte(strings.TrimSuffix(string(env.Payload), "}")+","+extra+"}"), &decoded) == nil {
			t.Fatalf("accepted invalid dispatch field %s", extra)
		}
	}
	m, _, _ := lifecycleManager(t, 1)
	r := record{RunID: env.RunID, AttemptID: env.AttemptID, Kind: d.Kind, ScriptOrigin: d.ScriptOrigin, TimeoutMS: d.TimeoutMS,
		Phase: "running", ResultMessageID: newID(), WorkspaceID: d.WorkspaceID, TestID: d.TestID, WorkspaceContext: d.WorkspaceContext,
		LoginVerification: d.LoginVerification, CredentialsUsed: true}
	if err := m.prepare(r, d); err != nil {
		t.Fatal(err)
	}
	if err := m.store(r); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil || string(loaded[r.AttemptID].LoginVerification) != string(d.LoginVerification) {
		t.Fatalf("journal lost the verification binding: %v", err)
	}
	if args := (dockerCLI{cfg: m.cfg}).createArgs(r, m.taskDir(r)); args[len(args)-1] != "dist/login/verification-main.js" {
		t.Fatal("verification did not select the dedicated entry point")
	}
	output := filepath.Join(m.taskDir(r), "output")
	if err := os.Mkdir(output, 0700); err != nil {
		t.Fatal(err)
	}
	const proof = `{"status":"succeeded","loginVerification":{"observedOrigin":"https://example.test","guest":"denied","submitted":true,"authenticated":"selector_visible"}}`
	for _, tc := range []struct {
		name, raw, status, reason string
		exit                      int
		credentialsUsed           bool
	}{
		{"verified", proof, "succeeded", "", 0, true},
		{"submit_only", `{"status":"succeeded","loginVerification":{"submitted":true}}`, "failed", "invalid_evidence", 0, true},
		{"wrong_origin", strings.ReplaceAll(proof, "https://example.test", "https://other.test"), "failed", "invalid_evidence", 0, true},
		{"process_failed", proof, "failed", "invalid_evidence", 1, true},
		{"no_resolver", proof, "failed", "invalid_evidence", 0, false},
		{"rejected", `{"status":"failed","loginVerification":{"reason":"login_rejected"}}`, "failed", "login_rejected", 1, true},
		{"cancelled", `{"status":"cancelled"}`, "cancelled", "", 130, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(output, "result.json"), []byte(tc.raw), 0600); err != nil {
				t.Fatal(err)
			}
			attempt := r
			attempt.CredentialsUsed = tc.credentialsUsed
			result, artifacts := collectAttemptResult(attempt, m.taskDir(r), execution{ExitCode: tc.exit})
			if result.Status != tc.status || len(artifacts) != 0 || (tc.reason != "" && string(result.LoginVerification) != string(failedVerification(tc.reason).LoginVerification)) {
				t.Fatalf("unexpected result: %v", result)
			}
		})
	}
	terminal := r
	terminal.Reclaimed, terminal.CancelRequested, terminal.Phase = true, true, "complete"
	var success Result
	_ = json.Unmarshal([]byte(proof), &success)
	terminal.Result = &success
	if err := m.store(terminal); err != nil {
		t.Fatal(err)
	}
	loaded, err = loadRecords(m.cfg.WorkDir)
	if err != nil || loaded[r.AttemptID].Result.Status != "cancelled" || len(loaded[r.AttemptID].Result.LoginVerification) != 0 {
		t.Fatal("cancellation retained successful evidence", err)
	}
}

func TestWLA23ResolversBindAccountAttemptAndLease(t *testing.T) {
	d, binding := loginVerificationDispatch()
	r := record{RunID: newID(), AttemptID: newID(), Kind: d.Kind, WorkspaceID: d.WorkspaceID, WorkspaceContext: d.WorkspaceContext, LoginVerification: d.LoginVerification}
	q := credentialRequest{RequestID: newID(), AttemptID: r.AttemptID, AccountID: binding.AccountID, TargetOrigin: binding.TargetOrigin, SecretRef: binding.SecretRef, SecretVersion: binding.SecretVersion}
	values := credentialValues{WorkspaceID: r.WorkspaceID, RunID: r.RunID, AttemptID: r.AttemptID, AccountID: q.AccountID, TargetOrigin: q.TargetOrigin,
		SecretRef: q.SecretRef, SecretVersion: q.SecretVersion, LoginOrigin: "https://auth.example.test", Username: "synthetic-user", Password: "synthetic-secret"}
	cfg := Config{ServerURL: "https://manager-server.example.test", Token: "synthetic-manager"}
	calls := 0
	reply := func(value any) *http.Response {
		raw, _ := json.Marshal(value)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(raw))), Header: http.Header{"Cache-Control": {"no-store"}}}
	}
	client := &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		calls++
		data, _ := io.ReadAll(req.Body)
		if req.URL.Path != "/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/credentials/resolve" ||
			!exactWorkspaceObject(data, "accountId", "targetOrigin", "secretRef", "secretVersion") || req.Header.Get("Authorization") != "Bearer synthetic-manager" {
			t.Fatal("attempt resolver sent unexpected identity")
		}
		return reply(values), nil
	})}
	if _, err := resolveCredentials(context.Background(), cfg, r, q, client); err != nil {
		t.Fatal(err)
	}
	wrong := q
	wrong.TargetOrigin = "https://other.test"
	if _, err := resolveCredentials(context.Background(), cfg, r, wrong, client); err == nil || calls != 1 {
		t.Fatal("wrong target reached resolver")
	}
	values.AttemptID = newID()
	if _, err := resolveCredentials(context.Background(), cfg, r, q, client); err == nil {
		t.Fatal("accepted a response from a different attempt")
	}
	lease := sessionRecord{SessionID: newID(), LeaseID: newID(), WorkspaceID: r.WorkspaceID}
	sq := sessionCredentialRequest{SessionID: lease.SessionID, LeaseID: lease.LeaseID, CallID: newID(), AccountID: binding.AccountID, Target: binding.TargetOrigin}
	sv := sessionCredentialValues{SessionID: lease.SessionID, LeaseID: lease.LeaseID, WorkspaceID: lease.WorkspaceID, CallID: sq.CallID,
		AccountID: sq.AccountID, Target: sq.Target, LoginOrigin: values.LoginOrigin, Username: values.Username, Password: values.Password}
	client.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		data, _ := io.ReadAll(req.Body)
		if !exactWorkspaceObject(data, "callId", "accountId", "targetOrigin") {
			t.Fatal("lease resolver sent unexpected identity")
		}
		return reply(sv), nil
	})
	if _, err := resolveSessionCredentials(context.Background(), cfg, lease, sq, sv.LoginOrigin, client); err != nil {
		t.Fatal(err)
	}
	sv.CallID = newID()
	if _, err := resolveSessionCredentials(context.Background(), cfg, lease, sq, sv.LoginOrigin, client); err == nil {
		t.Fatal("accepted a response from a different lease call")
	}
}
