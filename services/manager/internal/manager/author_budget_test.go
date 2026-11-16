package manager

import (
	"encoding/json"
	"testing"
)

func TestM12ContinuationUsageReceiptBoundToAllocation(t *testing.T) {
	a := m7Dispatch(t, false).Author
	a.Budget = json.RawMessage(`{"maxModelRequests":2,"maxToolCalls":1,"maxDurationMs":1000}`)
	for _, raw := range []string{
		`null`, `{}`, `{"modelRequests":0,"toolCalls":null,"durationMs":1}`,
		`{"modelRequests":3,"toolCalls":0,"durationMs":1}`,
		`{"modelRequests":1,"toolCalls":2,"durationMs":1}`,
		`{"modelRequests":1,"toolCalls":0,"durationMs":1001}`,
		`{"modelRequests":1,"toolCalls":0,"durationMs":0}`,
		`{"modelRequests":1,"toolCalls":false,"durationMs":1}`,
		`{"modelRequests":1,"toolCalls":0,"durationMs":1.5}`,
		`{"modelRequests":1,"toolCalls":0,"durationMs":1,"extra":1}`,
		`{"modelRequests":0,"modelRequests":1,"toolCalls":0,"durationMs":1}`,
	} {
		if validAuthorUsageReceipt(json.RawMessage(raw), a) {
			t.Fatal("invalid or increased usage accepted", raw)
		}
	}
	for _, raw := range []string{`{"modelRequests":0,"toolCalls":0,"durationMs":1}`, `{"modelRequests":2,"toolCalls":1,"durationMs":1000}`} {
		if !validAuthorUsageReceipt(json.RawMessage(raw), a) {
			t.Fatal("valid bounded usage rejected")
		}
	}
	value := partialValue(nil)
	value["partial"].(map[string]any)["usage"] = map[string]any{"modelRequests": 1, "toolCalls": 1, "durationMs": 10}
	raw, _ := json.Marshal(value)
	partial, _ := json.Marshal(value["partial"])
	if !validPartialArtifact(raw, partial, a, nil, false) {
		t.Fatal("valid receipt rejected at artifact boundary")
	}
	a.Budget = nil
	if validPartialArtifact(raw, partial, a, nil, false) {
		t.Fatal("unbound legacy receipt accepted")
	}
}
