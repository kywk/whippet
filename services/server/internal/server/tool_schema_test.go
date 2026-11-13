package server

import (
	"strings"
	"testing"
)

func TestM10RegistrySchemaGuard(t *testing.T) {
	r, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, raw string
		valid     bool
	}{
		{"catalog_search", `{"query":"測試","limit":20}`, true},
		{"catalog_search", `{"query":"x","limit":1.5}`, false},
		{"catalog_search", `{"query":"x","limit":21}`, false},
		{"catalog_search", `{"query":"x","limit":1,"cursor":null}`, false},
		{"catalog_search", `{"query":"` + strings.Repeat("測", 342) + `","limit":1}`, false},
		{"catalog_get", `{"moduleVersionId":"bad"}`, false},
		{"read_plan", `{"extra":null}`, false},
	}
	stage := `{"stages":[{"id":"a","title":"A","action":"create","module":{"slug":"setup","moduleKind":"setup","description":"d"},"args":ARGS}]}`
	for _, a := range []struct {
		args  string
		valid bool
	}{
		{`{}`, true},
		{`{"page":{"kind":"literal","value":null}}`, false},
		{`{"x":{"kind":"literal","value":{"__proto__":{}}}}`, false},
		{`{"x":{"kind":"literal","value":"` + strings.Repeat("x", 16385) + `"}}`, false},
		{`{"x":{"kind":"literal","value":` + strings.Repeat("[", 18) + "0" + strings.Repeat("]", 18) + `}}`, false},
	} {
		tests = append(tests, struct {
			name, raw string
			valid     bool
		}{"propose_plan", strings.Replace(stage, "ARGS", a.args, 1), a.valid})
	}
	for _, tt := range tests {
		tool, _ := r.tool(tt.name)
		_, err := validateToolArguments(tool, []byte(tt.raw))
		if (err == nil) != tt.valid {
			t.Errorf("%s valid=%v: %v", tt.name, tt.valid, err)
		}
	}
}
