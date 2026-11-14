//go:build integration

// In-process Server dispatch and real isolated PostgreSQL; no Worker or Docker.
package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestM11FinalModuleABISnapshotAndDispatch(t *testing.T) {
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal("migration failed")
	}
	w, err := p.CreateWorkspace(ctx, "synthetic ABI")
	if err != nil {
		t.Fatal("workspace fixture failed")
	}
	slug := "setup"
	item, err := p.CreatePlatformTest(ctx, w.ID, "synthetic module", "", "module", &slug)
	if err != nil {
		t.Fatal("module fixture failed")
	}
	edit, _, err := p.StartEditingSession(ctx, item.ID)
	if err != nil {
		t.Fatal("editing fixture failed")
	}
	metadata := &Module{Slug: slug, ModuleKind: "setup", ExportName: "prepare", Harness: m10BundleSpec}
	draft, err := p.SavePlatformDraft(ctx, item.ID, edit.ID, edit.Draft.Revision, m10BundleModule, metadata, nil)
	if err != nil {
		t.Fatal("draft fixture failed")
	}
	run, err := p.ValidateDraft(ctx, item.ID, edit.ID, draft.Revision)
	if err != nil {
		t.Fatal("validation fixture failed")
	}
	if err := p.RegisterManager(ctx, "m11-final-abi", 1); err != nil {
		t.Fatal("manager fixture failed")
	}
	assignment, err := p.Claim(ctx, "m11-final-abi", 1)
	if err != nil || assignment == nil || assignment.ID != run.ID || assignment.ModuleABI == nil || assignment.ModuleABI.Slug != slug || assignment.ModuleABI.ExportName != "prepare" {
		t.Fatal("validation claim did not carry authoritative ABI")
	}
	changed := *metadata
	changed.ExportName = "changed"
	if _, err := p.SavePlatformDraft(ctx, item.ID, edit.ID, draft.Revision, m10BundleModule, &changed, nil); err != nil {
		t.Fatal("draft change fixture failed")
	}
	replay, err := p.Assignments(ctx, "m11-final-abi")
	if err != nil || len(replay) != 1 || replay[0].ModuleABI == nil || *replay[0].ModuleABI != *assignment.ModuleABI {
		t.Fatal("replayed assignment did not preserve snapshotted ABI")
	}
	engine := NewEngine(newFlowStore(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	defer engine.Close()
	peer := &recordPeer{}
	session := &Session{managerID: "m11-final-abi", peer: peer, sent: map[string]time.Time{}}
	if err := engine.send(session, *assignment, "dispatch"); err != nil {
		t.Fatal("module dispatch failed")
	}
	var wire struct {
		ModuleABI *ModuleABI `json:"moduleAbi"`
	}
	if len(peer.messages) != 1 || json.Unmarshal(peer.messages[0].Payload, &wire) != nil || wire.ModuleABI == nil || *wire.ModuleABI != *assignment.ModuleABI {
		t.Fatal("module dispatch lost authoritative ABI")
	}
	// Control: a non-module assignment must omit this authority entirely.
	nonModule := *assignment
	nonModule.ModuleABI = nil
	otherPeer := &recordPeer{}
	other := &Session{managerID: "m11-final-abi", peer: otherPeer, sent: map[string]time.Time{}}
	if err := engine.send(other, nonModule, "dispatch"); err != nil || len(otherPeer.messages) != 1 || strings.Contains(string(otherPeer.messages[0].Payload), `"moduleAbi"`) {
		t.Fatal("non-module dispatch disclosed ABI")
	}
}
