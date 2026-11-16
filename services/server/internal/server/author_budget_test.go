package server

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestM12ContinuationUsageStrictAndSharedCeiling(t *testing.T) {
	for _, raw := range []string{
		`null`, `{}`, `{"modelRequests":null,"toolCalls":0,"durationMs":1}`,
		`{"modelRequests":0,"toolCalls":false,"durationMs":1}`,
		`{"modelRequests":0,"toolCalls":0,"durationMs":1.5}`,
		`{"modelRequests":-1,"toolCalls":0,"durationMs":1}`,
		`{"modelRequests":0,"toolCalls":0,"durationMs":1,"extra":0}`,
		`{"modelRequests":0,"modelRequests":1,"toolCalls":0,"durationMs":1}`,
	} {
		var u AuthorUsage
		if json.Unmarshal([]byte(raw), &u) == nil {
			t.Fatal("invalid usage accepted", raw)
		}
	}
	root := authorChainBudget{RootRunID: NewID(), Ordinal: 1, MaxRuns: 3, Limit: AuthorBudget{MaxModelRequests: 8, MaxToolCalls: 12, MaxDurationMS: 180000}}
	input := AuthorInput{Budget: &root.Limit}
	next, err := nextAuthorChainBudget(root, input, &AuthorUsage{2, 3, 1000})
	if err != nil || next.Ordinal != 2 || root.Spent != (AuthorUsage{}) {
		t.Fatal("shared allocation mutated root", err)
	}
	higher := 16384
	child := AuthorInput{Budget: &AuthorBudget{MaxModelRequests: 8, MaxToolCalls: 12, MaxDurationMS: 180000, MaxOutputTokens: &higher}}
	if err = next.constrain(&child); err != nil || child.Budget.MaxModelRequests != 6 || child.Budget.MaxToolCalls != 9 || child.Budget.MaxDurationMS != 179000 || effectiveOutputTokens(child.Budget) != 8192 {
		t.Fatal("continuation grew or reset budget", err)
	}
	for _, usage := range []*AuthorUsage{nil, {8, 0, 1}, {0, 0, 180000}} {
		if _, err = nextAuthorChainBudget(root, input, usage); !errors.Is(err, ErrContinuationBudget) {
			t.Fatal("missing/exhausted receipt minted credit", err)
		}
	}
	for _, usage := range []*AuthorUsage{{9, 0, 1}, {0, 13, 1}, {0, 0, 0}, {0, 0, 180001}} {
		if _, err = nextAuthorChainBudget(root, input, usage); !errors.Is(err, ErrContinuationUsage) {
			t.Fatal("over-claim accepted", err)
		}
	}
	root.Ordinal = 3
	if _, err = nextAuthorChainBudget(root, input, &AuthorUsage{0, 0, 1}); !errors.Is(err, ErrContinuationBudget) {
		t.Fatal("zero-request partial bypassed attempt cap", err)
	}
}

func TestM12ContinuationReceiptParserDoesNotTrustModelFields(t *testing.T) {
	for _, receipt := range []string{`null`, `{"modelRequests":0,"toolCalls":0,"durationMs":0}`, `{"modelRequests":1,"toolCalls":0,"durationMs":1,"approved":true}`} {
		raw := []byte(`{"message":"partial","requestValidation":false,"partial":{"reason":"budget_exhausted","nextStep":"remaining","usage":` + receipt + `}}`)
		if _, err := decodeAuthorOutput(raw); err == nil {
			t.Fatal("invalid receipt accepted")
		}
	}
	raw := []byte(`{"message":"partial","requestValidation":false,"partial":{"reason":"budget_exhausted","nextStep":"remaining","usage":{"modelRequests":0,"toolCalls":0,"durationMs":1}}}`)
	if _, err := decodeAuthorOutput(raw); err != nil {
		t.Fatal("zero-request capacity partial rejected", err)
	}
	if _, err := decodeExternalAuthorOutput(raw); err == nil {
		t.Fatal("external client supplied a trusted usage receipt")
	}
}
