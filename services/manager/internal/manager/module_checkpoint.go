package manager

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
)

func moduleCheckpointHash(raw json.RawMessage) string {
	var fields map[string]string
	if json.Unmarshal(raw, &fields) != nil {
		return ""
	}
	var text strings.Builder
	for _, key := range []string{"slug", "moduleKind", "exportName", "signature", "inputs", "returns", "preconditions", "postconditions", "harness"} {
		value, present := fields[key]
		if !present {
			return ""
		}
		fmt.Fprintf(&text, "%d:%s", len(value), value)
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(text.String())))
}

func validModulePartialArtifact(partial json.RawMessage, a *AuthorTask, script string, module json.RawMessage) bool {
	registry, err := validCapabilitySnapshot(a)
	if err != nil || registry == nil || !moduleAuthor(a) || !hasAllowedTool(a, "commit_module_candidate") ||
		!exactWorkspaceObject(a.Platform, "planId", "stageId", "module") {
		return false
	}
	var scope struct {
		PlanID  *string `json:"planId"`
		StageID *string `json:"stageId"`
	}
	if json.Unmarshal(a.Platform, &scope) != nil || scope.PlanID != nil || scope.StageID != nil {
		return false
	}
	if _, ok := uniqueBudgetFields(partial); !ok {
		return false
	}
	if !exactWorkspaceObject(partial, "reason", "nextStep", "checkpoint", "usage") {
		return false
	}
	var p struct {
		Reason     string          `json:"reason"`
		NextStep   string          `json:"nextStep"`
		Checkpoint json.RawMessage `json:"checkpoint"`
		Usage      json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(partial, &p) != nil || p.Reason != "checkpoint_saved" || !boundedAuthorText(p.NextStep, 8192, true) || !validAuthorUsageReceipt(p.Usage, a) {
		return false
	}
	if _, ok := uniqueBudgetFields(p.Checkpoint); !ok {
		return false
	}
	var c struct {
		ScriptHash     string `json:"scriptHash"`
		ModuleHash     string `json:"moduleHash"`
		SelfTestPassed bool   `json:"selfTestPassed"`
	}
	return exactWorkspaceObject(p.Checkpoint, "scriptHash", "moduleHash", "selfTestPassed") && json.Unmarshal(p.Checkpoint, &c) == nil && c.SelfTestPassed &&
		capabilityHash.MatchString(c.ScriptHash) && capabilityHash.MatchString(c.ModuleHash) && c.ScriptHash == fmt.Sprintf("%x", sha256.Sum256([]byte(script))) && c.ModuleHash == moduleCheckpointHash(module)
}
