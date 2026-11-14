package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"
)

const m10BundleSpec = "import {test,expect} from '@playwright/test'; import {prepare} from '@lib/setup'; test('case',async({page})=>{const result=await test.step('Stage 1: prepare',()=>prepare({page}));await test.step('Stage 2: verify',async()=>{await expect(page.getByRole('heading')).toHaveText('alpha');expect(result.name).toBe('alpha');});});"
const m10BundleModule = "export async function prepare({page}){await page.setContent('<h1>alpha</h1>');return {name:'alpha'};}"

func TestM10BundleHashAndDispatch(t *testing.T) {
	b := RunBundle{SchemaVersion: 1, Files: []RunFile{{Path: "tests/test.spec.ts", Content: m10BundleSpec, Origin: "manual"}, {Path: "lib/setup.ts", Content: m10BundleModule, Origin: "manual"}}}
	hash, err := b.hash()
	if err != nil {
		t.Fatal(err)
	}
	reverse := RunBundle{SchemaVersion: 1, Files: []RunFile{b.Files[1], b.Files[0]}}
	same, err := reverse.hash()
	if err != nil || hash != same {
		t.Fatal("file order changed hash", err)
	}
	b.Files[0].Origin = "ai"
	changed, err := b.hash()
	if err != nil || changed == hash || b.origin() != "ai" {
		t.Fatal("origin missing from bundle identity", err)
	}
	if _, err := decodeRunBundle([]byte(jsonText(b.Files)), []byte(b.metadata()), &changed, b.entry(), "manual"); err == nil {
		t.Fatal("manual aggregate overrode AI file")
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(newFlowStore(), log)
	defer engine.Close()
	peer := &recordPeer{}
	session := &Session{managerID: "m10", peer: peer, sent: map[string]time.Time{}}
	a := Assignment{Run: Run{ID: NewID(), Kind: "validation", ScriptOrigin: "ai"}, AttemptID: NewID(), Script: b.entry(), Files: b.Files, TimeoutMS: 20000}
	if err := engine.send(session, a, "dispatch"); err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Script       string    `json:"script"`
		Files        []RunFile `json:"files"`
		ScriptOrigin string    `json:"scriptOrigin"`
	}
	if err = json.Unmarshal(peer.messages[0].Payload, &wire); err != nil || wire.Script != b.entry() || len(wire.Files) != 2 || wire.ScriptOrigin != "ai" {
		t.Fatal("dispatch bundle lost", err)
	}
	if strings.Contains(string(peer.messages[0].Payload), `"moduleAbi"`) {
		t.Fatal("Use Case dispatch exposed Module ABI")
	}
	modulePeer := &recordPeer{}
	moduleSession := &Session{managerID: "m10", peer: modulePeer, sent: map[string]time.Time{}}
	a.ModuleABI = &ModuleABI{Slug: "setup", ExportName: "prepare"}
	if err := engine.send(moduleSession, a, "dispatch"); err != nil {
		t.Fatal(err)
	}
	var moduleWire struct {
		ModuleABI *ModuleABI `json:"moduleAbi"`
	}
	if json.Unmarshal(modulePeer.messages[0].Payload, &moduleWire) != nil || moduleWire.ModuleABI == nil || *moduleWire.ModuleABI != *a.ModuleABI {
		t.Fatal("Module dispatch lost trusted ABI")
	}
}
func TestM10BundleInvalidInputsAndMetadataGate(t *testing.T) {
	for _, path := range []string{"../outside.ts", "lib/../outside.ts", "/tmp/x", "lib/x\\y.ts", "lib/a/b.ts"} {
		b := RunBundle{SchemaVersion: 1, Files: []RunFile{{Path: "tests/test.spec.ts", Content: "test", Origin: "manual"}, {Path: path, Content: "x", Origin: "manual"}}}
		if _, err := b.hash(); err == nil {
			t.Fatal("invalid file accepted", path)
		}
	}
	b := RunBundle{SchemaVersion: 1, Files: []RunFile{{Path: "tests/test.spec.ts", Content: strings.Repeat("x", MaxScriptBytes+1), Origin: "manual"}}}
	if _, err := b.hash(); err == nil {
		t.Fatal("oversize file accepted")
	}
	b.Files = []RunFile{{Path: "tests/test.spec.ts", Content: "x", Origin: "manual"}, {Path: "tests/test.spec.ts", Content: "y", Origin: "manual"}}
	if _, err := b.hash(); err == nil {
		t.Fatal("duplicate entry accepted")
	}
}
