package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func runtimeGolden(t *testing.T) AuthorRuntime {
	t.Helper()
	raw, err := os.ReadFile(repositoryFile("contracts", "testdata", "agent-runtime.json"))
	if err != nil {
		t.Fatal(err)
	}
	var r AuthorRuntime
	if json.Unmarshal(raw, &r) != nil || !validAuthorRuntime(&r) {
		t.Fatal("runtime digest contract")
	}
	return r
}

func cleanRuntimeEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"WHIPPET_AI_RUNTIME_PROFILES_JSON", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_CONTEXT_WINDOW_TOKENS", "WHIPPET_AI_CONTEXT_INPUT_TOKENS"} {
		t.Setenv(k, "")
		if err := os.Unsetenv(k); err != nil {
			t.Fatal(err)
		}
	}
}

func TestM12RuntimeProfilesAndDigest(t *testing.T) {
	cleanRuntimeEnv(t)
	r := runtimeGolden(t)
	input := AuthorInput{SkillID: "test-author", Model: &AuthorModel{Provider: r.Provider, Model: r.Model, ReasoningEffort: r.ReasoningEffort}}
	t.Setenv("WHIPPET_AI_ENGINE", "vercel") // Workspace default stays builtin.
	selection := RuntimeSelection{ProfileID: "builtin", SkillProfiles: map[string]string{}}
	got, err := resolveAuthorRuntime(input, selection)
	if err != nil || got.Engine != "builtin" || got.Model != r.Model || got.ReasoningEffort != r.ReasoningEffort || got.ContextInputTokens != 262144 {
		t.Fatal("default policy", err)
	}
	selection.SkillProfiles["test-author"] = "vercel"
	got, err = resolveAuthorRuntime(input, selection)
	expected := r
	expected.ContextInputTokens = 262144
	expected.SHA256 = runtimeDigest(expected.AuthorRuntimeData)
	if err != nil || *got != expected {
		t.Fatal("default per-skill selection", err)
	}
	t.Run("pi uses the same pinned provider and capacity policy", func(t *testing.T) {
		got, err := resolveAuthorRuntime(input, RuntimeSelection{ProfileID: "pi", SkillProfiles: map[string]string{}})
		if err != nil || got.Engine != "pi" || got.Provider != r.Provider || got.Model != r.Model ||
			got.ContextInputTokens != 262144 || !validAuthorRuntime(got) {
			t.Fatal("pi runtime policy", err)
		}
	})
	t.Run("explicit input cap reproduces legacy digest", func(t *testing.T) {
		t.Setenv("WHIPPET_AI_CONTEXT_INPUT_TOKENS", "65536")
		got, err := resolveAuthorRuntime(input, selection)
		if err != nil || *got != r {
			t.Fatal("legacy override", err)
		}
	})
	t.Run("default input cap respects smaller window", func(t *testing.T) {
		t.Setenv("WHIPPET_AI_CONTEXT_WINDOW_TOKENS", "131072")
		got, err := resolveAuthorRuntime(input, selection)
		if err != nil || got.ContextInputTokens != 131072 {
			t.Fatal("smaller window", err)
		}
	})
	p := runtimeProfile{"alternate", "vercel", "openai-responses", "https://provider.example/v1", "configured-model", "high", 131072, 32768}
	raw, _ := json.Marshal([]runtimeProfile{p})
	t.Setenv("WHIPPET_AI_RUNTIME_PROFILES_JSON", string(raw))
	selection.ProfileID = "alternate"
	selection.SkillProfiles = map[string]string{}
	got, err = resolveAuthorRuntime(input, selection)
	if err != nil || got.Provider != p.Provider || got.Model != p.Model || got.ContextInputTokens != 32768 {
		t.Fatal("backend profile", err)
	}
	t.Run("existing custom pi id keeps its engine", func(t *testing.T) {
		t.Setenv("WHIPPET_AI_RUNTIME_PROFILES_JSON", strings.Replace(string(raw), `"alternate"`, `"pi"`, 1))
		got, err := resolveAuthorRuntime(input, RuntimeSelection{ProfileID: "pi", SkillProfiles: map[string]string{}})
		if err != nil || got.Engine != p.Engine || got.Provider != p.Provider || got.Model != p.Model {
			t.Fatal("existing profile was not preserved", err)
		}
	})
	for _, body := range []string{"null", `[{"id":"bad","apiKey":"forbidden"}]`, string(raw[:len(raw)-1]) + `,` + string(raw[1:]), strings.Replace(string(raw), `"alternate"`, `"vercel"`, 1), strings.Replace(string(raw), `"id":"alternate"`, `"id":"alternate","id":"hidden"`, 1)} {
		t.Setenv("WHIPPET_AI_RUNTIME_PROFILES_JSON", body)
		if _, err := runtimeProfiles(); err == nil {
			t.Fatal("accepted invalid profile registry")
		}
	}
}

func TestM12RuntimeRejectsDriftAndInvalidPolicy(t *testing.T) {
	r := runtimeGolden(t)
	for _, mutate := range []func(*AuthorRuntime){
		func(r *AuthorRuntime) { r.Model = "changed" }, func(r *AuthorRuntime) { r.ContextWindowTokens = 2097152 },
		func(r *AuthorRuntime) { r.ContextInputTokens = 2097152 }, func(r *AuthorRuntime) { r.Engine = "auto" },
		func(r *AuthorRuntime) { r.BaseURL = "https://provider.example/v1?" }, func(r *AuthorRuntime) { r.BaseURL = "https://user:pass@provider.example/v1" },
		func(r *AuthorRuntime) { r.BaseURL = "https://provider.example:65536/v1" }, func(r *AuthorRuntime) { r.ContextWindowTokens = 0 },
	} {
		bad := r
		mutate(&bad)
		if validAuthorRuntime(&bad) {
			t.Fatal("accepted changed/invalid runtime")
		}
		if bad.Model == "changed" {
			continue
		} // Hashing invalid data must not grant validity.
		bad.SHA256 = runtimeDigest(bad.AuthorRuntimeData)
		if validAuthorRuntime(&bad) {
			t.Fatal("digest bypassed validation")
		}
	}
}
