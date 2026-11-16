package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

func TestM11ExternalTaskDefinitionsUsePinnedRegistryAndIntersection(t *testing.T) {
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	input := AuthorInput{
		ToolRegistryVersion: registry.Version,
		ToolRegistrySHA256:  registry.SHA256,
		AllowedTools:        []string{"read_module_draft", "request_module_validation", "catalog_get"},
	}
	allowed, definitions, err := externalTaskDefinitions(input, []string{"read_module_draft", "catalog_get", "browser_login"}, registry)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(allowed, []string{"read_module_draft", "catalog_get"}) || len(definitions) != 2 {
		t.Fatalf("unexpected external tool intersection: %v, %d definitions", allowed, len(definitions))
	}
	for i, name := range allowed {
		original, ok := registry.tool(name)
		if !ok || !reflect.DeepEqual(definitions[i], original) {
			t.Fatalf("definition %d differs from registry tool %s", i, name)
		}
	}
	var schema struct {
		Type                 string                     `json:"type"`
		Properties           map[string]json.RawMessage `json:"properties"`
		AdditionalProperties bool                       `json:"additionalProperties"`
	}
	if json.Unmarshal(definitions[0].InputSchema, &schema) != nil || schema.Type != "object" || schema.Properties == nil || len(schema.Properties) != 0 || schema.AdditionalProperties {
		t.Fatal("nested read_module_draft must disclose its zero-argument schema")
	}
	input.AllowedTools = []string{}
	allowed, definitions, err = externalTaskDefinitions(input, []string{}, registry)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := json.Marshal(ExternalTaskBundle{ToolDefinitions: definitions})
	if err != nil || len(allowed) != 0 || !bytes.Contains(bundle, []byte(`"toolDefinitions":[]`)) {
		t.Fatal("summary task must expose an empty definitions array")
	}
	input.ToolRegistrySHA256 = "stale"
	if _, _, err := externalTaskDefinitions(input, []string{}, registry); !errors.Is(err, ErrHistoryUnavailable) {
		t.Fatal("stale Run registry pin was accepted")
	}
}
