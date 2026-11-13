package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

func validModuleSummary(a *AuthorTask, script *string) bool {
	if len(a.ModuleSummary) == 0 {
		return true
	}
	if !summaryAuthor(a) || len(a.Batch) > 0 || len(a.Platform) > 0 || !utf8.Valid(a.ModuleSummary) || a.AllowedTools == nil || len(*a.AllowedTools) != 0 || !strictBatchObject(a.ModuleSummary, nil, "schemaVersion", "module", "bundleHash", "bodyHash", "harnessHash") {
		return false
	}
	var compact bytes.Buffer
	if json.Compact(&compact, a.ModuleSummary) != nil || compact.Len() > 13<<20 {
		return false
	}
	var s struct {
		SchemaVersion int             `json:"schemaVersion"`
		Module        json.RawMessage `json:"module"`
		BundleHash    string          `json:"bundleHash"`
		BodyHash      string          `json:"bodyHash"`
		HarnessHash   string          `json:"harnessHash"`
	}
	var budget skillBudget
	if json.Unmarshal(a.ModuleSummary, &s) != nil || s.SchemaVersion != 1 || !capabilityHash.MatchString(s.BundleHash) || !capabilityHash.MatchString(s.BodyHash) || !capabilityHash.MatchString(s.HarnessHash) || json.Unmarshal(a.Budget, &budget) != nil || budget.MaxToolCalls != 0 || a.ValidationEvidence == nil || !validBatchEvidence(*a.ValidationEvidence, a.BaseRevision) || a.ValidationEvidence.ScriptHash != s.HarnessHash {
		return false
	}
	body := ""
	if script != nil {
		body = *script
		if fmt.Sprintf("%x", sha256.Sum256([]byte(body))) != s.BodyHash {
			return false
		}
	}
	if !validModuleCandidate(body, s.Module) {
		return false
	}
	var module struct {
		Harness string `json:"harness"`
	}
	if json.Unmarshal(s.Module, &module) != nil {
		return false
	}
	return fmt.Sprintf("%x", sha256.Sum256([]byte(module.Harness))) == s.HarnessHash
}
