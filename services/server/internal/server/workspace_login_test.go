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
