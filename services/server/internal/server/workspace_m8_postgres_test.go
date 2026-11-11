//go:build integration

package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

// Opt in only with TEST_DATABASE_URL for an isolated database. The shared
// helper creates/drops one random schema and has no service-DB fallback.
func TestM8WorkspaceSliceA(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	legacy, err := p.Workspaces(ctx)
	if err != nil || len(legacy) != 1 || legacy[0].Lifecycle != "needs_confirmation" || legacy[0].Settings != nil || legacy[0].ScopeStatus != "unconfirmed" {
		t.Fatalf("legacy confirmation: %+v %v", legacy, err)
	}
	p.Artifacts, err = NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Secrets, err = NewSecretVault(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{23}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	w1, err := p.CreateWorkspace(ctx, "第一工作區")
	if err != nil {
		t.Fatal(err)
	}
	w2, err := p.CreateWorkspace(ctx, "第二工作區")
	if err != nil {
		t.Fatal(err)
	}
	if w1.ConversationID == w2.ConversationID || w1.ExecutionAvailable || w1.Revision != 1 || w1.Settings != nil {
		t.Fatal("workspace isolation/defaults")
	}
	test, err := p.CreateTest(ctx, w1.ID, "測試", "")
	if err != nil {
		t.Fatal(err)
	}
	editing, _, err := p.StartEditingSession(ctx, test.ID)
	if err != nil {
		t.Fatal(err)
	}
	beforeDraft := *editing.Draft
	beforeDraft, err = p.SaveDraft(ctx, test.ID, beforeDraft.EditingSessionID, beforeDraft.Revision,
		`import { test, expect } from '@playwright/test'; test('synthetic', async ({page}) => { await page.setContent('<h1>synthetic</h1>'); await expect(page.getByRole('heading')).toHaveText('synthetic'); });`)
	if err != nil {
		t.Fatal(err)
	}
	if beforeDraft.WorkspaceContext == nil || beforeDraft.WorkspaceContext.WorkspaceID != w1.ID {
		t.Fatal("new draft owner snapshot missing")
	}
	if _, err := p.ValidateDraft(ctx, test.ID, beforeDraft.EditingSessionID, beforeDraft.Revision); !errors.Is(err, ErrSecurityUnavailable) {
		t.Fatalf("unsafe validation queued: %v", err)
	}
	var blockedRuns int
	if err := p.DB.QueryRowContext(ctx, `SELECT count(*) FROM runs WHERE test_id=$1`, test.ID).Scan(&blockedRuns); err != nil || blockedRuns != 0 {
		t.Fatalf("blocked validation still created a Run: %d %v", blockedRuns, err)
	}
	const manager = "m8-isolated-manager"
	if err := p.RegisterManager(ctx, manager, 1); err != nil {
		t.Fatal(err)
	}
	submit := func(w Workspace) *Assignment {
		t.Helper()
		current, err := p.Workspace(ctx, w.ID)
		if err != nil {
			t.Fatal(err)
		}
		c, err := p.WorkspaceConversation(ctx, w.ID)
		if err != nil {
			t.Fatal(err)
		}
		s, err := p.CreateWorkspaceAuthor(ctx, w.ID, "請整理非機密設定", current.Revision, c.ContextRevision)
		if err != nil {
			t.Fatal(err)
		}
		if s.Run.TestID != nil || s.Run.WorkspaceID != w.ID || s.Run.AuthorMode != "workspace" || s.Run.EditingSessionID != nil {
			t.Fatalf("invalid workspace owner: %+v", s)
		}
		if _, err := p.CreateWorkspaceAuthor(ctx, w.ID, "重複", current.Revision, c.ContextRevision+1); !errors.Is(err, ErrConflict) {
			t.Fatal("concurrent workspace task accepted")
		}
		a, err := p.Claim(ctx, manager, 1)
		if err != nil || a == nil || a.ID != s.Run.ID || !offlineAuthorAllowed(*a) {
			t.Fatalf("claim workspace interview: %+v %v", a, err)
		}
		return a
	}
	complete := func(a *Assignment, config *WorkspaceConfig) {
		t.Helper()
		body, err := json.Marshal(workspaceAuthorOutput{Message: "非機密設定提案，尚未探索網站", Proposal: config})
		if err != nil {
			t.Fatal(err)
		}
		artifact, err := p.Artifacts.Save(a.ID, a.AttemptID, "author.json", strings.NewReader(string(body)))
		if err != nil {
			t.Fatal(err)
		}
		if err := p.SaveArtifact(ctx, artifact); err != nil {
			t.Fatal(err)
		}
		if err := p.Complete(ctx, manager, a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatal(err)
		}
		if err := p.Complete(ctx, manager, a.ID, a.AttemptID, Result{Status: "succeeded"}); err != nil {
			t.Fatalf("duplicate result: %v", err)
		}
		if err := p.ReleaseSlots(ctx, manager, nil); err != nil {
			t.Fatal(err)
		}
	}
	config := m8Config()
	a := submit(w1)
	complete(a, &config)
	pending, err := p.Workspace(ctx, w1.ID)
	if err != nil || pending.CurrentProposal == nil || pending.CurrentProposal.Status != "pending" || pending.Settings != nil || len(pending.Roles) != 1 {
		t.Fatalf("result auto-applied or missing proposal: %+v %v", pending, err)
	}
	proposal := *pending.CurrentProposal
	if _, err := p.WorkspaceProposal(ctx, w2.ID, proposal.ID); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-workspace proposal exposed")
	}
	if _, _, err := p.ActWorkspaceProposal(ctx, w2.ID, proposal.ID, "confirm", 1); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-workspace confirmation accepted")
	}
	role := pending.Roles[0].RoleID
	if _, err := p.SaveWorkspaceCredentials(ctx, w2.ID, role, 0, credentialValues{"synthetic", "synthetic"}); !errors.Is(err, ErrNotFound) {
		t.Fatal("cross-workspace role accepted")
	}
	_, scoped, err := p.ActWorkspaceProposal(ctx, w1.ID, proposal.ID, "confirm-scope", 1)
	if err != nil || !scoped.ScopeConfirmed {
		t.Fatalf("scope confirmation: %v", err)
	}
	confirmed, applied, err := p.ActWorkspaceProposal(ctx, w1.ID, proposal.ID, "confirm", 1)
	if err != nil || confirmed.Revision != 2 || confirmed.Lifecycle != "active" || confirmed.Settings == nil || confirmed.ExecutionAvailable || applied.Status != "applied" {
		t.Fatalf("confirm: %+v %v", confirmed, err)
	}
	again, _, err := p.ActWorkspaceProposal(ctx, w1.ID, proposal.ID, "confirm", 1)
	if err != nil || again.Revision != 2 {
		t.Fatal("confirmation not idempotent")
	}
	afterDraft, err := p.Draft(ctx, test.ID)
	if err != nil || afterDraft.Revision != beforeDraft.Revision+1 || afterDraft.Script != beforeDraft.Script || afterDraft.ValidationRunID != nil || afterDraft.WorkspaceContext.SettingsRevision != 2 {
		t.Fatalf("active draft not invalidated: %+v %v", afterDraft, err)
	}
	oldRun, err := p.Run(ctx, a.ID)
	if err != nil || oldRun.WorkspaceContext.Config != nil || oldRun.WorkspaceContext.SettingsRevision != 1 {
		t.Fatal("existing run snapshot silently changed")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE runs SET workspace_context='{}' WHERE id=$1`, a.ID); err == nil {
		t.Fatal("run context mutable")
	}
	if _, err := p.DB.ExecContext(ctx, `UPDATE draft_revisions SET workspace_context='{}' WHERE test_id=$1`, test.ID); err == nil {
		t.Fatal("draft context mutable")
	}
	if _, err := p.PatchWorkspace(ctx, w1.ID, WorkspacePatch{Revision: 2}); !errors.Is(err, ErrProposalRequired) {
		t.Fatal("PATCH bypass remains")
	}
	if _, err := p.Publish(ctx, test.ID, afterDraft.EditingSessionID, afterDraft.Revision, NewID(), true); !errors.Is(err, ErrSecurityUnavailable) {
		t.Fatalf("new publish not gated: %v", err)
	}
	seedTests, err := p.Tests(ctx, legacy[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.CreateRun(ctx, seedTests[0].ID); !errors.Is(err, ErrSecurityUnavailable) {
		t.Fatal("formal run not gated")
	}
	values := credentialValues{"synthetic-user", "synthetic-password"}
	ref, err := p.SaveWorkspaceCredentials(ctx, w1.ID, role, 0, values)
	if err != nil || !ref.Configured || ref.SecretVersion == nil || *ref.SecretVersion != 1 {
		t.Fatalf("first credential save: %+v %v", ref, err)
	}
	if _, err := p.SaveWorkspaceCredentials(ctx, w1.ID, role, 0, values); !errors.Is(err, ErrConflict) {
		t.Fatal("stale credential version accepted")
	}
	revoked, err := p.RevokeWorkspaceCredentials(ctx, w1.ID, role, 1)
	if err != nil || revoked.Configured || *revoked.SecretVersion != 1 {
		t.Fatal("revocation reset version")
	}
	ref, err = p.SaveWorkspaceCredentials(ctx, w1.ID, role, 1, values)
	if err != nil || *ref.SecretVersion != 2 {
		t.Fatal("revoked version reused")
	}
	var nonce, sealed []byte
	if err := p.DB.QueryRowContext(ctx, `SELECT nonce,ciphertext FROM workspace_secrets WHERE role_id=$1 AND secret_version=2`, role).Scan(&nonce, &sealed); err != nil {
		t.Fatal(err)
	}
	opened, err := p.Secrets.open(w1.ID, role, *ref.SecretRef, 2, nonce, sealed)
	if err != nil || opened != values || bytes.Contains(sealed, []byte(values.Password)) {
		t.Fatal("AEAD persisted values invalid")
	}
	p.Secrets = nil
	if _, err := p.SaveWorkspaceCredentials(ctx, w1.ID, role, 2, values); !errors.Is(err, ErrSecretsUnavailable) {
		t.Fatal("missing key fallback")
	}
	// A subsequent interview invalidates an older proposal. Cross-workspace
	// conversations stay empty, and result/cancel never overwrites active config.
	second := submit(w1)
	same := *confirmed.Settings
	complete(second, &same)
	newest, err := p.Workspace(ctx, w1.ID)
	if err != nil {
		t.Fatal(err)
	}
	noOp, _, err := p.ActWorkspaceProposal(ctx, w1.ID, newest.CurrentProposal.ID, "confirm", 2)
	if err != nil || noOp.Revision != 2 {
		t.Fatal("no-op confirm bumped revision")
	}
	third := submit(w1)
	same.BackgroundSummary = "候選背景"
	complete(third, &same)
	newest, err = p.Workspace(ctx, w1.ID)
	if err != nil {
		t.Fatal(err)
	}
	staleID := newest.CurrentProposal.ID
	if _, _, err := p.ActWorkspaceProposal(ctx, w1.ID, staleID, "confirm", 1); !errors.Is(err, ErrConflict) {
		t.Fatal("old revision confirmed")
	}
	stale, err := p.WorkspaceProposal(ctx, w1.ID, staleID)
	if err != nil || stale.Status != "stale" || stale.InvalidationReason == nil {
		t.Fatal("stale reason not persisted")
	}
	fourth := submit(w1)
	complete(fourth, &same)
	newest, err = p.Workspace(ctx, w1.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, cancelled, err := p.ActWorkspaceProposal(ctx, w1.ID, newest.CurrentProposal.ID, "cancel", 2)
	if err != nil || cancelled.Status != "cancelled" || cancelled.ScopeConfirmed {
		t.Fatal("cancel proposal")
	}
	fifth := submit(w1)
	if _, err := p.Cancel(ctx, fifth.ID); err != nil {
		t.Fatal(err)
	}
	complete(fifth, &same)
	last, err := p.Workspace(ctx, w1.ID)
	if err != nil || last.Revision != 2 || last.Settings.BackgroundSummary != confirmed.Settings.BackgroundSummary || last.CurrentProposal.Status != "cancelled" {
		t.Fatal("late cancelled result applied")
	}
	other, err := p.WorkspaceConversation(ctx, w2.ID)
	if err != nil || len(other.Messages) != 0 || other.ContextRevision != 0 {
		t.Fatal("conversation crossed workspace")
	}
	owner, err := p.ResourceWorkspace(ctx, "runs", a.ID)
	if err != nil || owner != w1.ID {
		t.Fatal("resource owner not derived from DB")
	}
	public, _ := json.Marshal(last)
	if bytes.Contains(public, []byte(values.Password)) || bytes.Contains(public, []byte(values.Username)) {
		t.Fatal("credential values exposed")
	}
}
