//go:build integration

package server

import (
	"bytes"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

func TestM8BServerLifecycle(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	p.Secrets, err = NewSecretVault(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{37}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	p.CredentialTLS = true
	const manager = "m8b-isolated-manager"
	if err := p.RegisterManager(ctx, manager, 1); err != nil {
		t.Fatal(err)
	}
	claim := func(id string) *Assignment {
		t.Helper()
		a, err := p.Claim(ctx, manager, 1)
		if err != nil || a == nil || a.ID != id {
			t.Fatalf("claim %s: %+v %v", id, a, err)
		}
		return a
	}
	upload := func(a *Assignment, name, body string) {
		t.Helper()
		f, err := files.Save(a.ID, a.AttemptID, name, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		if err = p.SaveArtifact(ctx, f); err != nil {
			t.Fatal(err)
		}
	}
	finish := func(a *Assignment, status string) {
		t.Helper()
		if err := p.Complete(ctx, manager, a.ID, a.AttemptID, Result{Status: status}); err != nil {
			t.Fatal(err)
		}
		if err := p.ReleaseSlots(ctx, manager, nil); err != nil {
			t.Fatal(err)
		}
	}
	completeAuthor := func(a *Assignment, body string) {
		t.Helper()
		upload(a, "author.json", body)
		finish(a, "succeeded")
		if err := p.Complete(ctx, manager, a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatal("result replay", err)
		}
	}
	reports := func(a *Assignment) {
		t.Helper()
		upload(a, "report.html", "<!doctype html><h1>real fixture report</h1>")
		upload(a, "results.json", `{"stats":{"expected":1,"unexpected":0,"flaky":0,"skipped":0,"duration":1},"errors":[]}`)
	}
	workspace, err := p.CreateWorkspace(ctx, "來源與角色測試")
	if err != nil {
		t.Fatal(err)
	}
	other, err := p.CreateWorkspace(ctx, "其他工作區")
	if err != nil {
		t.Fatal(err)
	}
	if !workspace.Capabilities.ManualExecution.Available || workspace.Capabilities.AIExecution.Available || !workspace.ExecutionAvailable || workspace.UnavailableReason != nil {
		t.Fatal("unconfirmed Workspace locked manual runner")
	}
	test, err := p.CreateTest(ctx, workspace.ID, "manual", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	d := *session.Draft
	if d.ScriptOrigin != "legacy" {
		t.Fatal("empty draft fabricated manual origin")
	}
	const script = `import {test,expect} from '@playwright/test'; test('manual',async({page})=>{for(const word of ['ok']){await page.setContent('<h1>'+word+'</h1>');await expect(page.getByRole('heading')).toHaveText(word);}});`
	d, err = p.SaveDraft(ctx, test.ID, session.ID, d.Revision, script)
	if err != nil || d.ScriptOrigin != "manual" {
		t.Fatal("manual origin", err)
	}
	unchanged, err := p.SaveDraft(ctx, test.ID, session.ID, d.Revision, script)
	if err != nil || unchanged.Revision != d.Revision || unchanged.ScriptOrigin != "manual" {
		t.Fatal("no-op changed source")
	}
	validation, err := p.ValidateDraft(ctx, test.ID, session.ID, d.Revision)
	if err != nil || validation.ScriptOrigin != "manual" {
		t.Fatal("manual validation needs targets", err)
	}
	a := claim(validation.ID)
	reports(a)
	finish(a, "succeeded")
	summary, err := p.CreateSummary(ctx, test.ID, session.ID, d.Revision, validation.ID)
	if err != nil {
		t.Fatal("summary", err)
	}
	a = claim(summary.ID)
	if a.ScriptOrigin != "manual" || hasBrowserTools(a.Author) {
		t.Fatal("summary source/browser")
	}
	completeAuthor(a, `{"message":"摘要","description":"已驗證人工腳本","backgroundSummary":"完整Playwright fixture"}`)
	if _, err := p.Publish(ctx, test.ID, session.ID, d.Revision+1, summary.ID, true); !errors.Is(err, ErrConflict) {
		t.Fatal("old revision published", err)
	}
	version, err := p.Publish(ctx, test.ID, session.ID, d.Revision, summary.ID, true)
	if err != nil || version.ScriptOrigin != "manual" {
		t.Fatal("manual publish", err)
	}
	same, err := p.Publish(ctx, test.ID, session.ID, d.Revision, summary.ID, true)
	if err != nil || same.ID != version.ID {
		t.Fatal("publish replay")
	}
	formal, err := p.CreateRun(ctx, test.ID)
	if err != nil || formal.ScriptOrigin != "manual" {
		t.Fatal("manual formal run", err)
	}
	a = claim(formal.ID)
	finish(a, "cancelled")
	resumed, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil || resumed.Draft.ScriptOrigin != "manual" {
		t.Fatal("version source not inherited", err)
	}
	author, err := p.CreateAuthor(ctx, test.ID, resumed.ID, "修改人工腳本並驗證", resumed.Draft.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a = claim(author.Run.ID)
	if hasBrowserTools(a.Author) {
		t.Fatal("manual input granted AI browser without scope")
	}
	hasValidation := false
	for _, tool := range a.Author.AllowedTools {
		hasValidation = hasValidation || tool == "request_validation"
	}
	if !hasValidation {
		t.Fatal("unchanged manual validation capability missing")
	}
	completeAuthor(a, jsonText(map[string]any{"message": "候選", "script": script + "\n// AI edit", "requestValidation": true}))
	edited, err := p.Draft(ctx, test.ID)
	if err != nil || edited.ScriptOrigin != "ai" || edited.ValidationRunID != nil {
		t.Fatal("AI edit inherited manual validation exemption", err)
	}
	var validationCount int
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1 AND kind='validation'`, test.ID).Scan(&validationCount); err != nil || validationCount != 1 {
		t.Fatal("AI queued unauthorized validation")
	}
	edited, err = p.SaveDraft(ctx, test.ID, resumed.ID, edited.Revision, edited.Script)
	if err != nil || edited.ScriptOrigin != "ai" {
		t.Fatal("manual no-op washed AI source")
	}
	edited, err = p.SaveDraft(ctx, test.ID, resumed.ID, edited.Revision, edited.Script+"\n// actual manual edit")
	if err != nil || edited.ScriptOrigin != "manual" {
		t.Fatal("real manual edit not recognized")
	}

	interview := func(id string, config WorkspaceConfig) WorkspaceProposal {
		t.Helper()
		w, err := p.Workspace(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		c, err := p.WorkspaceConversation(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		s, err := p.CreateWorkspaceAuthor(ctx, id, "建立設定", w.Revision, c.ContextRevision)
		if err != nil {
			t.Fatal(err)
		}
		a := claim(s.Run.ID)
		completeAuthor(a, jsonText(workspaceAuthorOutput{Message: "候選設定", Proposal: &config}))
		w, err = p.Workspace(ctx, id)
		if err != nil || w.CurrentProposal == nil {
			t.Fatal("interview proposal", err)
		}
		return *w.CurrentProposal
	}
	config := m8Config()
	proposal := interview(workspace.ID, config)
	role := *proposal.Content.LoginRoles[0].RoleID
	ref, err := p.SaveWorkspaceCredentials(ctx, workspace.ID, role, 0, credentialValues{"synthetic-user", "synthetic-password"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.ActWorkspaceProposal(ctx, workspace.ID, proposal.ID, "confirm-scope", 1); err != nil {
		t.Fatal(err)
	}
	c, err := p.WorkspaceConversation(ctx, workspace.ID)
	if err != nil {
		t.Fatal(err)
	}
	exploring, err := p.CreateWorkspaceAuthor(ctx, workspace.ID, "探索已確認登入頁", 1, c.ContextRevision)
	if err != nil {
		t.Fatal(err)
	}
	a = claim(exploring.Run.ID)
	if !hasBrowserTools(a.Author) || a.WorkspaceContext.Config == nil || a.scopeProposalID == nil || *a.scopeProposalID != proposal.ID {
		t.Fatal("confirmed candidate not fixed into author snapshot")
	}
	live, err := p.LiveTarget(ctx, a.ID)
	if err != nil || live.WorkspaceID != workspace.ID || live.TestID != "" {
		t.Fatal("workspace author browser not live", err)
	}
	request := CredentialRequest{role, *ref.SecretRef, *ref.SecretVersion}
	value, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, a.AttemptID, request)
	if err != nil || value.WorkspaceID != workspace.ID || value.RunID != a.ID || value.AttemptID != a.AttemptID || value.LoginOrigin != "https://login.example.test" || value.Password != "synthetic-password" {
		t.Fatal("bound credential resolution", err)
	}
	if _, err := p.ResolveWorkspaceCredentials(ctx, "wrong-manager", a.ID, a.AttemptID, request); !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatal("wrong manager resolved")
	}
	if _, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, NewID(), request); !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatal("old attempt resolved")
	}
	foreign := request
	foreign.RoleID = NewID()
	if _, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, a.AttemptID, foreign); !errors.Is(err, ErrNotFound) {
		t.Fatal("unallowed role resolved")
	}
	if _, err := p.SaveWorkspaceCredentials(ctx, other.ID, role, 1, credentialValues{"synthetic", "synthetic"}); !errors.Is(err, ErrNotFound) {
		t.Fatal("role crossed workspace")
	}
	if _, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, a.AttemptID, request); err != nil {
		t.Fatal("same active attempt revalidation", err)
	}
	var resolvedCount int
	if err := p.DB.QueryRowContext(ctx, `SELECT cardinality(resolved_role_ids) FROM runs WHERE id=$1`, a.ID).Scan(&resolvedCount); err != nil || resolvedCount != 1 {
		t.Fatal("resolved-role replay duplicated tracking")
	}
	if _, err := p.RevokeWorkspaceCredentials(ctx, workspace.ID, role, 1); err != nil {
		t.Fatal(err)
	}
	cancelled, err := p.Run(ctx, a.ID)
	if err != nil || cancelled.Status != "cancelling" {
		t.Fatal("role revocation did not cancel active consumer")
	}
	if _, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, a.AttemptID, request); !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatal("revoked role resolved")
	}
	finish(a, "cancelled")
	proposal = interview(workspace.ID, proposal.Content)
	ref, err = p.SaveWorkspaceCredentials(ctx, workspace.ID, role, 1, credentialValues{"synthetic-user", "synthetic-new-password"})
	if err != nil || *ref.SecretVersion != 2 {
		t.Fatal("revoked credential version reused", err)
	}
	confirmed, _, err := p.ActWorkspaceProposal(ctx, workspace.ID, proposal.ID, "confirm", 1)
	if err != nil || !confirmed.Capabilities.CredentialLogin.Available {
		t.Fatal("confirmed role capability", err)
	}
	current, err := p.Draft(ctx, test.ID)
	if err != nil || current.ScriptOrigin != "manual" || current.ValidationRunID != nil || current.WorkspaceContext.RoleRefs[0].SecretVersion == nil || *current.WorkspaceContext.RoleRefs[0].SecretVersion != 2 {
		t.Fatal("role/config refresh changed source or kept old ref")
	}
	loginValidation, err := p.ValidateDraft(ctx, test.ID, resumed.ID, current.Revision)
	if err != nil {
		t.Fatal(err)
	}
	a = claim(loginValidation.ID)
	request.SecretVersion = 2
	if _, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, a.AttemptID, request); err != nil {
		t.Fatal("manual trusted login", err)
	}
	unaffected, err := p.CreateRun(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.RevokeWorkspaceCredentials(ctx, workspace.ID, role, 2); err != nil {
		t.Fatal(err)
	}
	unchangedRun, err := p.Run(ctx, unaffected.ID)
	if err != nil || unchangedRun.Status != "queued" {
		t.Fatal("credential revocation cancelled unrelated manual run")
	}
	if err := loadRunRoles(ctx, p.DB, a.ID); !errors.Is(err, ErrCredentialUnavailable) {
		t.Fatal("revoked credential still qualifies evidence", err)
	}
	finish(a, "cancelled")
	if _, err := p.Cancel(ctx, unaffected.ID); err != nil {
		t.Fatal(err)
	}

	const seedWorkspace = "00000000-0000-4000-8000-000000000001"
	const seedTest = "10000000-0000-4000-8000-000000000001"
	if _, err := p.CreateRun(ctx, seedTest); !errors.Is(err, ErrScopeConfirmation) {
		t.Fatal("legacy treated as manual")
	}
	seedProposal := interview(seedWorkspace, m8Config())
	if _, _, err := p.ActWorkspaceProposal(ctx, seedWorkspace, seedProposal.ID, "confirm", 1); err != nil {
		t.Fatal(err)
	}
	legacyRun, err := p.CreateRun(ctx, seedTest)
	if err != nil || legacyRun.ScriptOrigin != "legacy" || legacyRun.WorkspaceContext.Config == nil {
		t.Fatal("legacy fresh run scope", err)
	}
	versions, err := p.Versions(ctx, seedTest)
	if err != nil || versions[0].ScriptOrigin != "legacy" || versions[0].WorkspaceContext != nil {
		t.Fatal("legacy history rewritten")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET script_origin='manual' WHERE id=$1`, legacyRun.ID); err == nil {
		t.Fatal("run origin mutable")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE test_versions SET script_origin='ai' WHERE id=$1`, version.ID); err == nil {
		t.Fatal("version origin mutable")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE draft_revisions SET script_origin='ai' WHERE test_id=$1`, test.ID); err == nil {
		t.Fatal("revision origin mutable")
	}
	p.Secrets = nil
	if _, err := p.ResolveWorkspaceCredentials(ctx, manager, a.ID, a.AttemptID, request); !errors.Is(err, ErrSecretsUnavailable) {
		t.Fatal("missing key fallback")
	}
}
