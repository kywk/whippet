package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestM10PartialParserCheckpointAndRedaction(t *testing.T) {
	script := "test('verified',()=>{})"
	valid := map[string]any{"message": "budget exhausted", "requestValidation": false, "script": script, "partial": map[string]any{"reason": "budget_exhausted", "nextStep": "finish assertions", "checkpoint": map[string]any{"scriptHash": scriptHash(script), "selfTestPassed": true}}}
	raw, _ := json.Marshal(valid)
	out, err := decodeAuthorOutput(raw)
	if err != nil || out.Partial == nil {
		t.Fatal("valid checkpoint rejected", err)
	}
	cases := map[string]func(map[string]any){
		"wrong hash": func(v map[string]any) {
			v["partial"].(map[string]any)["checkpoint"].(map[string]any)["scriptHash"] = strings.Repeat("0", 64)
		},
		"redaction changed script": func(v map[string]any) { v["script"] = "test('[REDACTED]',()=>{})" },
		"false self test": func(v map[string]any) {
			v["partial"].(map[string]any)["checkpoint"].(map[string]any)["selfTestPassed"] = false
		},
		"missing script":           func(v map[string]any) { delete(v, "script") },
		"validation flag":          func(v map[string]any) { v["requestValidation"] = true },
		"unknown applied revision": func(v map[string]any) { v["partial"].(map[string]any)["appliedRevision"] = 2 },
		"empty next step":          func(v map[string]any) { v["partial"].(map[string]any)["nextStep"] = " " },
		"oversize next step":       func(v map[string]any) { v["partial"].(map[string]any)["nextStep"] = strings.Repeat("a", 8193) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			var v map[string]any
			json.Unmarshal(raw, &v)
			change(v)
			data, _ := json.Marshal(v)
			if _, err := decodeAuthorOutput(data); err == nil {
				t.Fatal("invalid partial accepted")
			}
		})
	}
	delete(valid, "script")
	delete(valid["partial"].(map[string]any), "checkpoint")
	raw, _ = json.Marshal(valid)
	if _, err := decodeAuthorOutput(raw); err != nil {
		t.Fatal("no-checkpoint partial rejected", err)
	}
	valid["script"] = nil
	raw, _ = json.Marshal(valid)
	if _, err := decodeAuthorOutput(raw); err == nil {
		t.Fatal("no-checkpoint script null accepted")
	}
	if _, err := decodeSummaryOutput([]byte(`{"message":"m","description":"d","backgroundSummary":"b","partial":{"reason":"budget_exhausted","nextStep":"x"}}`)); err == nil {
		t.Fatal("summary accepted partial")
	}
	if _, err := decodeWorkspaceAuthorOutput([]byte(`{"message":"m","partial":{"reason":"budget_exhausted","nextStep":"x"}}`)); err == nil {
		t.Fatal("workspace accepted partial")
	}
}

func TestM10AuthorArtifactEscapingLimit(t *testing.T) {
	script := "/*" + strings.Repeat("<", MaxScriptBytes-4) + "*/"
	output := authorOutput{Message: stringPointer("large candidate"), RequestValidation: new(bool), Script: &script, Partial: &AuthorPartialOutput{Reason: "budget_exhausted", NextStep: "continue", Checkpoint: &AuthorCheckpoint{ScriptHash: scriptHash(script), SelfTestPassed: true}}}
	raw, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) <= 2<<20 || int64(len(raw)) > MaxAuthorArtifactBytes {
		t.Fatal("fixture must exercise expanded JSON")
	}
	if _, err = decodeAuthorOutput(raw); err != nil {
		t.Fatal("escaped 2 MiB candidate rejected", err)
	}
	over := strings.Repeat(" ", int(MaxAuthorArtifactBytes)+1)
	if _, err = decodeAuthorOutput([]byte(over)); err == nil {
		t.Fatal("oversize JSON accepted")
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = files.Save(NewID(), NewID(), "author.json", strings.NewReader(string(raw))); err != nil {
		t.Fatal("artifact upload rejected valid escaped candidate", err)
	}
	if _, err = files.Save(NewID(), NewID(), "author.json", strings.NewReader(over)); err == nil {
		t.Fatal("oversize upload accepted")
	}
	if artifactLimit("author.json") != 13<<20 || artifactLimit("report.html") != MaxArtifactBytes {
		t.Fatal("unrelated artifact limits changed")
	}
	if authorCanUpdateDraft(AuthorInput{SkillID: "test-author", AllowedTools: []string{"read_draft"}}) {
		t.Fatal("read only author acquired candidate capability")
	}
}
