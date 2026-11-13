package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
)

const maxAuthorArtifactBytes = 13 << 20

func validPartialArtifact(raw, partial json.RawMessage, a *AuthorTask, script *string, requestValidation bool) bool {
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
