package server

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestM102CatalogHandlerAndMinLength(t *testing.T) {
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	for _, args := range []string{`{"query":"setup","limit":1,"cursor":null}`, `{"query":"setup","limit":1,"cursor":""}`} {
		raw, _ := json.Marshal(HarnessToolRequest{CallID: NewID(), Name: "catalog_search", Arguments: json.RawMessage(args)})
		req := httptest.NewRequest("POST", "https://localhost/tools", bytes.NewReader(raw))
		req.TLS = &tls.ConnectionState{}
		req.SetPathValue("id", NewID())
		req.SetPathValue("attemptId", NewID())
		rec := httptest.NewRecorder()
		(&API{}).harnessTool(rec, req)
		if rec.Code != 400 || rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("extra cursor not rejected before store")
		}
	}
	next, _ := registry.tool("catalog_next_page")
	if _, err := validateToolArguments(next, []byte(`{"cursor":"","limit":1}`)); err == nil {
		t.Fatal("empty cursor accepted")
	}
	schema := map[string]any{"type": "string", "minLength": float64(2), "x-maxUtf8Bytes": float64(8)}
	if matchesToolSchema(schema, "😀") || !matchesToolSchema(schema, "😀😀") || matchesToolSchema(schema, "😀😀a") {
		t.Fatal("rune minimum/UTF8 maximum conflated")
	}
}
