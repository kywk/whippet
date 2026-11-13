package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func m10PlatformInput(t *testing.T, role string) (AuthorInput, *ToolRegistry) {
	t.Helper()
	r, e := loadToolRegistry()
	if e != nil {
		t.Fatal(e)
	}
	m, p, e := loadSkill(repositoryFile("runtimes", "worker", "skills"), role, r)
	if e != nil {
		t.Fatal(e)
	}
	return AuthorInput{SkillID: role, SkillVersion: p.Version, Skills: []SkillSnapshot{p}, Budget: &m.Budget, Model: &m.Model, ToolRegistryVersion: r.Version, ToolRegistrySHA256: r.SHA256, AllowedTools: []string{"update_module_candidate", "request_module_validation", "propose_plan"}, Platform: &AuthorPlatform{}}, r
}
func TestM10PlatformFinalGuards(t *testing.T) {
	input, r := m10PlatformInput(t, "module-authoring")
	metadata := &Module{Slug: "setup", ModuleKind: "setup", ExportName: "prepare", Harness: strings.Repeat("\x01", MaxScriptBytes)}
	input.Platform.Module = metadata
	script := strings.Repeat("\x01", MaxScriptBytes)
	raw, _ := json.Marshal(moduleAuthorOutput{Message: stringPointer("candidate"), Script: &script, Module: metadata, RequestValidation: new(bool)})
	if len(raw) <= int(MaxAuthorArtifactBytes) {
		t.Fatal("fixture does not exercise module exception")
	}
	if _, e := decodeModuleAuthorOutput(raw, input, r); e != nil {
		t.Fatal(e)
	}
	if _, e := decodeModuleAuthorOutput(append(raw, []byte(strings.Repeat(" ", int(MaxModuleAuthorArtifactBytes)))...), input, r); e == nil {
		t.Fatal("oversized module accepted")
	}
	if runArtifactLimit("author.json", "author", "test-author") != MaxAuthorArtifactBytes || runArtifactLimit("author.json", "run", "module-authoring") != MaxAuthorArtifactBytes || runArtifactLimit("author.json", "author", "module-authoring") != MaxModuleAuthorArtifactBytes {
		t.Fatal("authority exception wrong")
	}
	planner, r := m10PlatformInput(t, "usecase-planner")
	valid := `{"message":"plan","planCandidate":{"candidateRef":"` + NewID() + `"}}`
	if _, e := decodePlannerAuthorOutput([]byte(valid), planner, r); e != nil {
		t.Fatal(e)
	}
	for _, raw := range []string{`{"message":"plan","planCandidate":{"stages":[]}}`, `{"message":"plan","planCandidate":{"candidateRef":"opaque"}}`, strings.TrimSuffix(valid, "}") + `,"requestValidation":false}`, strings.TrimSuffix(valid, "}") + `,"partial":{}}`} {
		if _, e := decodePlannerAuthorOutput([]byte(raw), planner, r); e == nil {
			t.Fatal("invalid planner final accepted")
		}
	}
	planner.Platform.StageID = stringPointer("stage")
	if validateAuthorPlatform(planner, "usecase") == nil {
		t.Fatal("planner Stage accepted")
	}
	input.SkillID = "test-author"
	if validateAuthorPlatform(input, "test") == nil {
		t.Fatal("ordinary primary platform accepted")
	}
}
