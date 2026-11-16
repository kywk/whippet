package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
)

const maxAuthorArtifactBytes = 13 << 20

func validPartialArtifact(raw, partial json.RawMessage, a *AuthorTask, script *string, requestValidation bool) bool {
	if _, ok := uniqueBudgetFields(raw); !ok {
		return false
	}
	if _, ok := uniqueBudgetFields(partial); !ok {
		return false
	}
	if a != nil && a.SkillID != nil && *a.SkillID != "test-author" {
		return false
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(partial, &fields) != nil || fields == nil || requestValidation {
		return false
	}
	keys := []string{"reason", "nextStep"}
	if _, ok := fields["checkpoint"]; ok {
		keys = append(keys, "checkpoint")
	}
	if usage, present := fields["usage"]; present {
		keys = append(keys, "usage")
		if !validAuthorUsageReceipt(usage, a) {
			return false
		}
	}
	if !exactWorkspaceObject(partial, keys...) {
		return false
	}
	var out struct {
		Reason     string          `json:"reason"`
		NextStep   string          `json:"nextStep"`
		Checkpoint json.RawMessage `json:"checkpoint"`
	}
	if json.Unmarshal(partial, &out) != nil || out.Reason != "budget_exhausted" || !boundedAuthorText(out.NextStep, 8192, true) {
		return false
	}
	var whole map[string]json.RawMessage
	if json.Unmarshal(raw, &whole) != nil {
		return false
	}
	if len(out.Checkpoint) == 0 {
		_, present := whole["script"]
		return !present
	}
	if bytes.Equal(bytes.TrimSpace(out.Checkpoint), []byte("null")) || !exactWorkspaceObject(out.Checkpoint, "scriptHash", "selfTestPassed") || script == nil {
		return false
	}
	var checkpoint struct {
		ScriptHash     string `json:"scriptHash"`
		SelfTestPassed bool   `json:"selfTestPassed"`
	}
	return json.Unmarshal(out.Checkpoint, &checkpoint) == nil && checkpoint.SelfTestPassed && capabilityHash.MatchString(checkpoint.ScriptHash) && checkpoint.ScriptHash == fmt.Sprintf("%x", sha256.Sum256([]byte(*script)))
}

func validAuthorUsageReceipt(raw json.RawMessage, a *AuthorTask) bool {
	fields, ok := uniqueBudgetFields(raw)
	if !ok || len(fields) != 3 || a == nil || len(a.Budget) == 0 {
		return false
	}
	for _, key := range []string{"modelRequests", "toolCalls", "durationMs"} {
		value, present := fields[key]
		if !present || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	var usage struct {
		ModelRequests int64 `json:"modelRequests"`
		ToolCalls     int64 `json:"toolCalls"`
		DurationMS    int64 `json:"durationMs"`
	}
	var budget skillBudget
	return json.Unmarshal(raw, &usage) == nil && json.Unmarshal(a.Budget, &budget) == nil &&
		usage.ModelRequests >= 0 && usage.ModelRequests <= budget.MaxModelRequests &&
		usage.ToolCalls >= 0 && usage.ToolCalls <= budget.MaxToolCalls && usage.DurationMS >= 1 && usage.DurationMS <= budget.MaxDurationMS
}
