package server

import (
	"strings"
	"testing"
)

func TestWLA1ProposalConfig(t *testing.T) {
	const payload = `{"message":"候選設定","proposal":{
		"name":"商店","purpose":"驗測","backgroundSummary":"商店背景","timeoutMs":60000,
		"targets":[{"name":"商店","purpose":"會員","origin":"https://shop.example","testScope":"both"}],
		"dependencies":[{"name":"登入","purpose":"login","origin":"https://auth.example"}],
		"testAccounts":[{"accountId":null,"name":"會員","role":"會員","purpose":"訂單","sites":[{
			"targetOrigin":"https://SHOP.example:443/","loginMethod":"form","entryUrl":"https://auth.example/login",
			"form":{"usernameSelector":"#user","passwordSelector":"#password","submitSelector":"#login"},
			"success":{"url":"https://shop.example/orders","visibleSelector":"#orders"}
		}]}]}}`
	out, err := decodeWorkspaceAuthorOutput([]byte(payload))
	if err != nil || out.Proposal.Targets[0].TestScope != testScopeBoth || out.Proposal.TestAccounts[0].Sites[0].TargetOrigin != "https://shop.example" {
		t.Fatalf("invalid site/account normalization: %+v %v", out, err)
	}
	config := out.Proposal
	if err := assignWorkspaceTestAccounts(config, nil); err != nil || !ValidID(stringValue(config.TestAccounts[0].AccountID)) {
		t.Fatalf("allocate account ID: %v", err)
	}
	previous := &WorkspaceInterviewProposal{Content: *config}
	if err := assignWorkspaceTestAccounts(config, previous); err != nil {
		t.Fatalf("reuse previously offered account ID: %v", err)
	}
	if err := assignWorkspaceTestAccounts(config, nil); err == nil {
		t.Fatal("accepted account ID absent from the interview snapshot")
	}
	pending := workspaceSiteReadiness(config, false)[0]
	if pending.Ready || stringValue(pending.Reason) != "login_verification_required" || stringValue(pending.Accounts[0].Reason) != "scope_confirmation_required" {
		t.Fatalf("unconfirmed login readiness: %+v", pending)
	}
	pending = workspaceSiteReadiness(config, true)[0]
	if pending.Ready || stringValue(pending.Accounts[0].Reason) != "credentials_required" {
		t.Fatalf("login readiness after confirming scope: %+v", pending)
	}
	scope := workspaceScopeConfig(config)
	if raw := jsonText(scope); strings.Contains(raw, "testScope") || strings.Contains(raw, "testAccounts") || workspaceScopeHash(*scope) != workspaceScopeHash(*config) {
		t.Fatalf("v8 scope projection drifted: %s", raw)
	}
	for _, test := range []struct{ name, old, value string }{
		{"unknown scope", `"both"`, `"private"`},
		{"null scope", `"both"`, `null`},
		{"duplicate scope", `"testScope":"both"`, `"testScope":"guest","testScope":"both"`},
		{"wrong case", `"testScope":"both"`, `"testScope":"guest","TestScope":"both"`},
		{"unknown account field", `"purpose":"訂單"`, `"purpose":"訂單","credential":"synthetic"`},
		{"missing account ID", `"accountId":null,`, ""},
		{"null account purpose", `"purpose":"訂單"`, `"purpose":null`},
		{"entry on an unrelated origin", `"https://auth.example/login"`, `"https://other.example/login"`},
		{"success on a different origin", `"https://shop.example/orders"`, `"https://auth.example/orders"`},
		{"unknown login selector field", `"submitSelector":"#login"`, `"submitSelector":"#login","password":"synthetic"`},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := decodeWorkspaceAuthorOutput([]byte(strings.Replace(payload, test.old, test.value, 1))); err == nil {
				t.Fatal("invalid proposal accepted")
			}
		})
	}
}
