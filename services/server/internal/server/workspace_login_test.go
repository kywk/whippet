package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestWLA2LoginEvidence(t *testing.T) {
	const target = "https://orders.example"
	good := json.RawMessage(`{"observedOrigin":"https://orders.example","guest":"denied","submitted":true,"authenticated":"selector_visible"}`)
	for _, test := range []struct {
		name, status string
		raw          json.RawMessage
		resolved     bool
		want, reason string
	}{
		{"verified", "succeeded", good, true, "succeeded", ""},
		{"no credential resolution", "succeeded", good, false, "failed", "invalid_evidence"},
		{"wrong site", "succeeded", json.RawMessage(strings.ReplaceAll(string(good), "orders", "support")), true, "failed", "invalid_evidence"},
		{"form only", "succeeded", json.RawMessage(`{"submitted":true}`), true, "failed", "invalid_evidence"},
		{"rejection", "failed", json.RawMessage(`{"reason":"login_rejected"}`), true, "failed", "login_rejected"},
		{"unsafe failure", "failed", json.RawMessage(`{"reason":"login_rejected","password":"synthetic"}`), true, "failed", "invalid_evidence"},
		{"timeout", "timed_out", nil, false, "timed_out", "timed_out"},
	} {
		t.Run(test.name, func(t *testing.T) {
			status, reason := loginResultDisposition(Result{Status: test.status, LoginVerification: test.raw}, target, test.resolved)
			if status != test.want || reason != test.reason {
				t.Fatalf("got %s/%s, want %s/%s", status, reason, test.want, test.reason)
			}
		})
	}
}

func TestWLA3LegacyAccountProjection(t *testing.T) {
	id, other := NewID(), NewID()
	config := WorkspaceConfig{
		Targets: []WorkspaceOrigin{{Origin: "https://orders.example"}},
		LoginRoles: []WorkspaceRole{
			{RoleID: &id, Name: "會員", LoginMethod: "form", LoginOrigin: "https://orders.example"},
			{RoleID: &other, Name: "會員", LoginMethod: "form", LoginOrigin: "https://auth.example"},
		},
	}
	setSavedWorkspaceTestDefaults(&config)
	first, second := config.TestAccounts[0], config.TestAccounts[1]
	if stringValue(first.AccountID) != id || len(first.Sites) != 1 || first.Sites[0].EntryURL != nil ||
		stringValue(second.AccountID) != other || len(second.Sites) != 0 || config.Targets[0].TestScope != testScopeUnknown {
		t.Fatal("legacy account identity or target mapping changed")
	}
	binding := LoginBinding{AccountID: id, TargetOrigin: config.Targets[0].Origin, SecretRef: NewID(), SecretVersion: 1}
	snapshot := WorkspaceContext{
		WorkspaceID: NewID(),
		RoleRefs:    []RoleRef{{RoleID: id, SecretRef: &binding.SecretRef, SecretVersion: &binding.SecretVersion, Configured: true}},
	}
	setAccountSnapshot(&snapshot, &config, []LoginBinding{binding})
	public := scrubExternalContext(&snapshot)
	if public.SchemaVersion != "2" || public.AccountBindings != nil || public.RoleRefs[0].SecretRef != nil ||
		public.RoleRefs[0].SecretVersion != nil || public.TestAccounts[0].AccountID != id ||
		snapshot.RoleRefs[0].SecretRef == nil || len(snapshot.AccountBindings) != 1 {
		t.Fatal("MCP projection leaked private binding references or changed its source snapshot")
	}
	if raw := jsonText(Run{WorkspaceContext: &snapshot}); strings.Contains(raw, "accountBindings") {
		t.Fatal("public Run exposes a trusted account binding")
	}
}

func TestWorkspaceAuthorRetainsFrozenLegacyAccount(t *testing.T) {
	const target = "https://orders.example"
	roleID, workspaceID := NewID(), NewID()
	legacy := WorkspaceConfig{
		Name: "訂單", Purpose: "讀取訂單", BackgroundSummary: "保留既有測試帳號", TimeoutMS: 60000,
		Targets:    []WorkspaceOrigin{{Name: "訂單", Origin: target}},
		LoginRoles: []WorkspaceRole{{RoleID: &roleID, Name: "會員", LoginMethod: "form", LoginOrigin: target}},
	}
	setSavedWorkspaceTestDefaults(&legacy)
	w := Workspace{ID: workspaceID, Lifecycle: "active", ScopeStatus: "confirmed", Settings: &legacy, Roles: []RoleRef{{RoleID: roleID}}}
	snapshot, _ := selectedContext(w, true)
	for _, test := range []struct {
		name     string
		previous *WorkspaceInterviewProposal
		scope    *WorkspaceContext
		want     bool
	}{
		{name: "first proposal from v8", scope: snapshot, want: true},
		{name: "follow-up where only the scope offers the alias", previous: &WorkspaceInterviewProposal{}, scope: snapshot, want: true},
		{name: "account offered by the previous proposal",
			previous: &WorkspaceInterviewProposal{Content: WorkspaceConfig{TestAccounts: legacy.TestAccounts}}, want: true},
		{name: "live UUID absent from the interview snapshot"},
		{name: "configuration alias absent from the frozen role references", scope: &WorkspaceContext{WorkspaceID: workspaceID, Config: snapshot.Config}},
		{name: "scope from another workspace", scope: &WorkspaceContext{WorkspaceID: NewID(), RoleRefs: snapshot.RoleRefs}},
	} {
		t.Run(test.name, func(t *testing.T) {
			workspace := w
			if test.previous != nil {
				workspace.CurrentProposal = &WorkspaceProposal{Status: "pending"}
			}
			proposed := legacy
			proposed.LoginRoles = nil
			output, err := decodeWorkspaceAuthorOutput([]byte(jsonText(workspaceAuthorOutput{Message: "保留原帳號", Proposal: &proposed})))
			if err != nil {
				t.Fatal(err)
			}
			err = bindWorkspaceAuthorProposal(workspace, test.previous, test.scope, output)
			if !test.want {
				if err == nil {
					t.Fatal("accepted an account from outside the frozen interview inputs")
				}
				return
			}
			if err != nil {
				t.Fatalf("rejecting original account UUID from the frozen scope: %v", err)
			}
			config, err := normalizeConfig(*output.Proposal, true)
			if err != nil {
				t.Fatalf("applying the proposal rejected its retained UUID: %v", err)
			}
			if len(config.TestAccounts) != 1 || stringValue(config.TestAccounts[0].AccountID) != roleID ||
				len(config.LoginRoles) != 1 || stringValue(config.LoginRoles[0].RoleID) != roleID {
				t.Fatal("account and legacy alias no longer share the original UUID")
			}
			readiness := workspaceSiteReadiness(&config, true)[0]
			if readiness.Ready || stringValue(readiness.Reason) != "scope_choice_required" {
				t.Fatal("a historical alias supplied missing site scope or login evidence")
			}
			config.Targets[0].TestScope = testScopeAuthenticated
			readiness = workspaceSiteReadiness(&config, true)[0]
			if readiness.Ready || stringValue(readiness.Reason) != "login_verification_required" {
				t.Fatal("a historical alias qualified as a verified site login")
			}
		})
	}
}
