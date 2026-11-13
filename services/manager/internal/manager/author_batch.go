package manager

import (
	"bytes"
	"encoding/json"
	"math"
	"reflect"
 "unicode/utf8"
)

type batchUsecase struct {
	TestID           string                   `json:"testId"`
	EditingSessionID string                   `json:"editingSessionId"`
	Revision         int64                    `json:"revision"`
	ContextRevision  int64                    `json:"contextRevision"`
	BundleHash       string                   `json:"bundleHash"`
	Evidence         AuthorValidationEvidence `json:"validationEvidence"`
}
type batchModule struct {
	TestID           string                   `json:"testId"`
	VersionID        string                   `json:"versionId"`
	Mode             string                   `json:"mode"`
	EditingSessionID *string                  `json:"editingSessionId"`
	Revision         int64                    `json:"revision"`
	ContextRevision  int64                    `json:"contextRevision"`
	BundleHash       string                   `json:"bundleHash"`
	Name             string                   `json:"name"`
	Description      *string                  `json:"description"`
	Module           json.RawMessage          `json:"module"`
	HarnessHash      string                   `json:"harnessHash"`
	Evidence         AuthorValidationEvidence `json:"validationEvidence"`
}

func validBatchEvidence(e AuthorValidationEvidence, revision int64) bool {
	return uuidPattern.MatchString(e.RunID) && uuidPattern.MatchString(e.AttemptID) && e.DraftRevision == revision && capabilityHash.MatchString(e.ScriptHash) && e.TimeoutMS >= 1 && e.TimeoutMS <= 3600000 && e.Status == "succeeded" && e.ReportsReady && e.Stats.Expected >= 1 && e.Stats.Unexpected == 0 && e.Stats.Flaky >= 0 && e.Stats.Skipped >= 0 && !math.IsNaN(e.Stats.Duration) && !math.IsInf(e.Stats.Duration, 0) && e.Stats.Duration >= 0
}
func strictBatchObject(raw json.RawMessage, nullable []string, keys ...string) bool {
	if !exactWorkspaceObject(raw, keys...) {
		return false
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	for k, v := range fields {
		if bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			allowed := false
			for _, n := range nullable {
				allowed = allowed || k == n
			}
			if !allowed {
				return false
			}
		}
	}
	return true
}
func strictBatchEvidenceObject(parent json.RawMessage) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(parent, &fields) != nil {
		return false
	}
	raw := fields["validationEvidence"]
	if !strictBatchObject(raw, nil, "runId", "attemptId", "draftRevision", "scriptHash", "timeoutMs", "status", "reportsReady", "stats") {
		return false
	}
	var evidence map[string]json.RawMessage
	_ = json.Unmarshal(raw, &evidence)
	return strictBatchObject(evidence["stats"], nil, "expected", "unexpected", "flaky", "skipped", "duration")
}
func validAuthorBatch(a *AuthorTask) bool {
	if len(a.Batch) == 0 {
		return true
	}
	if !utf8.Valid(a.Batch) || !summaryAuthor(a) || a.AllowedTools == nil || len(*a.AllowedTools) != 0 {
		return false
	}
	var compact bytes.Buffer
	if json.Compact(&compact, a.Batch) != nil || compact.Len() > 4<<20 {
		return false
	}
	if !strictBatchObject(a.Batch, nil, "schemaVersion", "planId", "planRevision", "batchHash", "usecase", "modules") {
		return false
	}
	var b struct {
		SchemaVersion int               `json:"schemaVersion"`
		PlanID        string            `json:"planId"`
		PlanRevision  int64             `json:"planRevision"`
		Hash          string            `json:"batchHash"`
		Usecase       json.RawMessage   `json:"usecase"`
		Modules       []json.RawMessage `json:"modules"`
	}
	if json.Unmarshal(a.Batch, &b) != nil || b.SchemaVersion != 1 || !uuidPattern.MatchString(b.PlanID) || b.PlanRevision < 1 || b.PlanRevision > 9007199254740991 || !capabilityHash.MatchString(b.Hash) || len(b.Modules) > 32 {
		return false
	}
	var budget skillBudget
	if json.Unmarshal(a.Budget, &budget) != nil || budget.MaxToolCalls != 0 {
		return false
	}
	if !strictBatchObject(b.Usecase, nil, "testId", "editingSessionId", "revision", "contextRevision", "bundleHash", "validationEvidence") {
		return false
	}
	var u batchUsecase
	if !strictBatchEvidenceObject(b.Usecase) || json.Unmarshal(b.Usecase, &u) != nil || !uuidPattern.MatchString(u.TestID) || !uuidPattern.MatchString(u.EditingSessionID) || u.Revision < 1 || u.Revision > 9007199254740991 || u.ContextRevision < 0 || u.ContextRevision > 9007199254740991 || !capabilityHash.MatchString(u.BundleHash) || !validBatchEvidence(u.Evidence, u.Revision) || a.EditingSessionID == nil || u.EditingSessionID != *a.EditingSessionID || u.Revision != a.BaseRevision || a.ContextRevision == nil || u.ContextRevision != *a.ContextRevision || a.ValidationEvidence == nil || !reflect.DeepEqual(u.Evidence, *a.ValidationEvidence) {
		return false
	}
	tests := map[string]bool{}
	previous := ""
	for _, raw := range b.Modules {
		if !strictBatchObject(raw, []string{"description", "editingSessionId"}, "testId", "versionId", "mode", "editingSessionId", "revision", "contextRevision", "bundleHash", "name", "description", "module", "harnessHash", "validationEvidence") {
			return false
		}
		var m batchModule
		if !strictBatchEvidenceObject(raw) || json.Unmarshal(raw, &m) != nil || !uuidPattern.MatchString(m.TestID) || tests[m.TestID] || !uuidPattern.MatchString(m.VersionID) || m.VersionID <= previous || m.Mode != "reuse" && m.Mode != "candidate" || m.Mode == "reuse" && m.EditingSessionID != nil || m.Mode == "candidate" && (m.EditingSessionID == nil || !uuidPattern.MatchString(*m.EditingSessionID)) || m.Revision < 1 || m.Revision > 9007199254740991 || m.ContextRevision < 0 || m.ContextRevision > 9007199254740991 || !capabilityHash.MatchString(m.BundleHash) || !capabilityHash.MatchString(m.HarnessHash) || !boundedAuthorText(m.Name, 200, false) || m.Description != nil && !boundedAuthorText(*m.Description, 16384, false) || !validBatchEvidence(m.Evidence, m.Revision) {
			return false
		}
		if !strictBatchObject(m.Module, nil, "slug", "moduleKind", "exportName", "signature", "inputs", "returns", "preconditions", "postconditions") {
			return false
		}
		var metadata map[string]json.RawMessage
		_ = json.Unmarshal(m.Module, &metadata)
		metadata["harness"] = json.RawMessage(`""`)
		full, _ := json.Marshal(metadata)
		if !validModuleCandidate("", full) {
			return false
		}
		tests[m.TestID] = true
		previous = m.VersionID
	}
	return true
}
