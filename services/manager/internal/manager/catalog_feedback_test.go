package manager

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestCatalogSearchFeedbackBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, tool, body, cache string
		status                  int
		cancel, want            bool
	}{
		{"valid", "catalog_search", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL"}}`, "no-store", 400, false, true},
		{"next-page", "catalog_next_page", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL"}}`, "no-store", 400, false, false},
		{"wrong-tool", "catalog_get", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL"}}`, "no-store", 400, false, false},
		{"wrong-status", "catalog_search", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL"}}`, "no-store", 409, false, false},
		{"no-cache", "catalog_search", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL"}}`, "", 400, false, false},
		{"wrong-code", "catalog_search", `{"error":{"code":"unauthorized","message":"SECRET_SENTINEL"}}`, "no-store", 400, false, false},
		{"unknown", "catalog_search", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL","extra":true}}`, "no-store", 400, false, false},
		{"malformed", "catalog_search", `{`, "no-store", 400, false, false},
		{"oversize", "catalog_search", `{"error":{"code":"invalid_request","message":"` + strings.Repeat("x", 4096) + `"}}`, "no-store", 400, false, false},
		{"late", "catalog_search", `{"error":{"code":"invalid_request","message":"SECRET_SENTINEL"}}`, "no-store", 400, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r := record{RunID: newID(), AttemptID: newID()}
			q := toolRequest{RequestID: newID(), AttemptID: r.AttemptID, Name: tc.tool, Arguments: []byte(`{}`)}
			client := &http.Client{Transport: liveRoundTripFunc(func(*http.Request) (*http.Response, error) {
				if tc.cancel {
					cancel()
				}
				return &http.Response{StatusCode: tc.status, Header: http.Header{"Cache-Control": []string{tc.cache}}, Body: io.NopCloser(strings.NewReader(tc.body))}, nil
			})}
			_, err := readHarnessTool(ctx, Config{ServerURL: "https://synthetic.invalid"}, r, q, registryTool{}, client)
			if errors.Is(err, errCatalogSearchInput) != tc.want {
				t.Fatal("incorrect mapping")
			}
			if err == nil || strings.Contains(err.Error(), "SECRET_SENTINEL") {
				t.Fatal("unsafe error")
			}
		})
	}
}
func TestRegistry102PaginationGuards(t *testing.T) {
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal(err)
	}
	var search, next registryTool
	for _, tool := range registry.Tools {
		if tool.Name == "catalog_search" {
			search = tool
		}
		if tool.Name == "catalog_next_page" {
			next = tool
		}
	}
	if !validToolArguments(search, []byte(`{"query":"x","limit":1}`)) || validToolArguments(search, []byte(`{"query":"x","limit":1,"cursor":null}`)) {
		t.Fatal("search schema")
	}
	for _, raw := range []string{`{"cursor":null,"limit":1}`, `{"cursor":"","limit":1}`, `{"cursor":"issued","limit":1,"query":"x"}`, `{"cursor":"` + strings.Repeat("😀", 257) + `","limit":1}`} {
		if validToolArguments(next, []byte(raw)) {
			t.Fatal("invalid next accepted")
		}
	}
	if !validToolArguments(next, []byte(`{"cursor":"😀","limit":1}`)) {
		t.Fatal("unicode cursor")
	}
	schema, e := parseToolSchema([]byte(`{"type":"string","minLength":2}`))
	if e != nil || schema.matches("😀") {
		t.Fatal("minLength must count runes")
	}
	a := platformAuthorFixture(t, "usecase-planner")
	if !allowedPlatformTool(a, "catalog_next_page") {
		t.Fatal("planner denied")
	}
	if allowedPlatformTool(platformAuthorFixture(t, "module-authoring"), "catalog_next_page") {
		t.Fatal("module scope expanded")
	}
}
