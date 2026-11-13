package server

import (
	"encoding/json"
	"testing"
)

func TestM10StageBindingAndPinnedVersion(t *testing.T) {
	module, version, other := NewID(), NewID(), NewID()
	stages := []Stage{{ID: "first", Title: "first", Kind: "module", ModuleTestID: module, ModuleVersionID: version}, {ID: "second", Title: "second", Kind: "module", ModuleTestID: module, ModuleVersionID: version, Args: map[string]StageArgument{"input": {Kind: "binding", StageID: "first", Path: []string{}}}}}
	if err := validateStages(stages); err != nil {
		t.Fatal(err)
	}
	stages[1].ModuleVersionID = other
	if validateStages(stages) == nil {
		t.Fatal("same module with different version accepted")
	}
	stages[1].ModuleVersionID = version
	stages[1].Args["page"] = StageArgument{Kind: "literal", Value: json.RawMessage(`null`)}
	if validateStages(stages) == nil {
		t.Fatal("page override accepted")
	}
	delete(stages[1].Args, "page")
	stages[1].Args["input"] = StageArgument{Kind: "binding", StageID: "later"}
	if validateStages(stages) == nil {
		t.Fatal("forward binding accepted")
	}
	stages[0] = Stage{ID: "first", Title: "inline", Kind: "inline", Script: "return 1"}
	stages[1].Args["input"] = StageArgument{Kind: "binding", StageID: "first"}
	if validateStages(stages) == nil {
		t.Fatal("inline result binding accepted")
	}
}
func TestM10ModuleIdentity(t *testing.T) {
	module := &Module{Slug: "login", ModuleKind: "setup", ExportName: "login", Harness: "test('login', async ({page}) => {});"}
	if err := validateModule(module, "login"); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"default", "await", "a-b", "x);evil()", ""} {
		module.ExportName = name
		if validateModule(module, "login") == nil {
			t.Fatalf("accepted export %q", name)
		}
	}
	module.ExportName = "login"
	if validateModule(module, "different") == nil {
		t.Fatal("slug rename accepted")
	}
}
