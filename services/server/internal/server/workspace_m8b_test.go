package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestM8BScopeAndIndependentCapabilities(t *testing.T) {
	w := Workspace{ID: NewID(), Lifecycle: "draft", Roles: []RoleRef{}}
	snapshot := workspaceContext(w)
	if _, _, err := executionBinding(w, "manual", snapshot); err != nil {
		t.Fatal("manual execution required targets/key")
	}
	for _, origin := range []string{"ai", "legacy", ""} {
		if _, _, err := executionBinding(w, origin, snapshot); !errors.Is(err, ErrScopeConfirmation) {
			t.Fatal("unknown or AI origin granted manual exemption")
		}
	}
	c := workspaceCapabilities(w, false, false)
	if !c.ManualExecution.Available || c.AIExecution.Available || c.AIExploration.Available || c.CredentialLogin.Available {
		t.Fatalf("independent gates: %+v", c)
	}
	config, err := normalizeConfig(m8Config(), true)
	if err != nil {
		t.Fatal(err)
	}
	w.Settings = &config
	w.Lifecycle = "active"
	w.ScopeStatus = "confirmed"
	snapshot = workspaceContext(w)
	if _, _, err := executionBinding(w, "ai", snapshot); err != nil {
		t.Fatal(err)
	}
	c = workspaceCapabilities(w, false, true)
	if !c.AIExecution.Available || !c.AIExploration.Available || !c.ManualExecution.Available || stringValue(c.CredentialLogin.Reason) != "secrets_unavailable" {
		t.Fatal("missing key locked unrelated execution")
	}
	old := *snapshot
	oldConfig := m8Config()
	oldConfig.Targets[0].Origin = "https://revoked.test"
	old.Config = &oldConfig
	if _, _, err := executionBinding(w, "ai", &old); !errors.Is(err, ErrScopeConfirmation) {
		t.Fatal("old AI snapshot silently gained new permission")
	}
	if _, _, err := executionBinding(w, "manual", &old); err != nil {
		t.Fatal("scope change restricted manual script")
	}
	w.Settings = nil
	w.Lifecycle = "draft"
	w.CurrentProposal = &WorkspaceProposal{ID: NewID(), BaseRevision: w.Revision, Status: "stale", ScopeConfirmed: true, Content: config, InvalidationReason: stringPointer("context_changed")}
	context, proposal := selectedContext(w, true)
	if context.Config == nil || proposal == nil {
		t.Fatal("follow-up lost confirmed candidate context")
	}
	if _, _, err := scopeBinding(w, context, proposal); err != nil {
		t.Fatal("confirmed candidate cannot explore")
	}
	roleID := NewID()
	w.CurrentProposal.Content.LoginRoles[0].RoleID = &roleID
	if !roleEligible(w, roleID) {
		t.Fatal("confirmed candidate role disappeared during follow-up exploration")
	}
	w.CurrentProposal.Status = "cancelled"
	if roleEligible(w, roleID) {
		t.Fatal("cancelled candidate grants new credential writes")
	}
	if _, _, err := scopeBinding(w, context, proposal); !errors.Is(err, ErrScopeConfirmation) {
		t.Fatal("cancelled candidate still authorized")
	}
}

func TestM8BPublicationOriginAndStrictAuthorOutput(t *testing.T) {
	id := NewID()
	d := draftState{Draft: Draft{TestID: NewID(), Revision: 1, Script: "fixed", ScriptOrigin: "manual", ValidationRunID: &id, WorkspaceSettings: &WorkspaceSettings{TimeoutMS: 60000}}, timeoutMS: 60000, hash: scriptHash("fixed")}
	proof := validationEvidence{id: id, testID: d.TestID, kind: "validation", status: "succeeded", revision: 1, script: d.Script, hash: d.hash, timeoutMS: 60000, settings: d.WorkspaceSettings, reportReady: true, scriptOrigin: "manual"}
	if err := checkPublication(1, true, d, proof); err != nil {
		t.Fatal(err)
	}
	proof.scriptOrigin = "ai"
	if err := checkPublication(1, true, d, proof); !errors.Is(err, ErrConflict) {
		t.Fatal("different-source evidence published")
	}
	for _, raw := range []string{`{"message":"x","script":"fixed","requestValidation":false,"scriptOrigin":"manual"}`, `{"message":"x","proposal":{},"scriptOrigin":"manual"}`} {
		if _, err := decodeAuthorOutput([]byte(raw)); err == nil {
			t.Fatal("model selected manual provenance")
		}
	}
}

type m8BResolveStore struct {
	Store
	calls   int
	manager string
	request CredentialRequest
}

func (s *m8BResolveStore) ResolveWorkspaceCredentials(_ context.Context, manager, run, attempt string, request CredentialRequest) (CredentialResolution, error) {
	s.calls++
	s.manager = manager
	s.request = request
	return CredentialResolution{WorkspaceID: NewID(), RunID: run, AttemptID: attempt, RoleID: request.RoleID, SecretRef: request.SecretRef, SecretVersion: request.SecretVersion, LoginOrigin: "https://login.example.test", Username: "synthetic-user", Password: "synthetic-password"}, nil
}
func TestM8BManagerResolveHTTP(t *testing.T) {
	store := &m8BResolveStore{}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(store, log)
	defer engine.Close()
	engine.session = &Session{managerID: "bound-manager", liveEpoch: NewID(), ready: true, peer: &recordPeer{}}
	handler := NewAPI(store, nil, engine, "synthetic-manager-token", log).Handler(nil)
	run, attempt, role, ref := NewID(), NewID(), NewID(), NewID()
	body := jsonText(CredentialRequest{role, ref, 1})
	request := func(secure, auth bool, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "http://localhost/api/manager/runs/"+run+"/attempts/"+attempt+"/credentials/resolve", strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("X-Forwarded-Proto", "https")
		if secure {
			r.TLS = &tls.ConnectionState{}
		}
		if auth {
			r.Header.Set("Authorization", "Bearer synthetic-manager-token")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	if w := request(true, false, body); w.Code != 401 {
		t.Fatal("resolve exposed to ordinary caller")
	}
	if w := request(false, true, body); w.Code != 400 || !strings.Contains(w.Body.String(), "protected_transport_required") {
		t.Fatal("resolve accepted plaintext loopback/header")
	}
	if w := request(true, true, `{"roleId":"`+role+`","secretRef":"`+ref+`","secretVersion":1,"workspaceId":"`+NewID()+`"}`); w.Code != 400 {
		t.Fatal("caller chose owner")
	}
	if store.calls != 0 {
		t.Fatal("rejected resolve reached storage")
	}
	w := request(true, true, body)
	var result CredentialResolution
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil || result.RunID != run || result.AttemptID != attempt || result.RoleID != role || result.SecretRef != ref || result.SecretVersion != 1 || result.Password != "synthetic-password" || w.Header().Get("Cache-Control") != "no-store" || store.manager != "bound-manager" {
		t.Fatalf("bound resolve response %d", w.Code)
	}
	engine.session.ready = false
	if w := request(true, true, body); w.Code != 409 || store.calls != 1 {
		t.Fatal("disconnected control session resolved credentials")
	}
}
