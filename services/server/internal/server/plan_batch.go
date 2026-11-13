package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"sort"
)

type BatchModuleMetadata struct {
	Slug           string `json:"slug"`
	ModuleKind     string `json:"moduleKind"`
	ExportName     string `json:"exportName"`
	Signature      string `json:"signature"`
	Inputs         string `json:"inputs"`
	Returns        string `json:"returns"`
	Preconditions  string `json:"preconditions"`
	Postconditions string `json:"postconditions"`
}
type BatchUseCase struct {
	TestID             string             `json:"testId"`
	EditingSessionID   string             `json:"editingSessionId"`
	Revision           int                `json:"revision"`
	ContextRevision    int64              `json:"contextRevision"`
	BundleHash         string             `json:"bundleHash"`
	ValidationEvidence ValidationEvidence `json:"validationEvidence"`
}
type BatchModule struct {
	TestID             string              `json:"testId"`
	VersionID          string              `json:"versionId"`
	Mode               string              `json:"mode"`
	EditingSessionID   *string             `json:"editingSessionId"`
	Revision           int                 `json:"revision"`
	ContextRevision    int64               `json:"contextRevision"`
	BundleHash         string              `json:"bundleHash"`
	Name               string              `json:"name"`
	Description        *string             `json:"description"`
	Module             BatchModuleMetadata `json:"module"`
	HarnessHash        string              `json:"harnessHash"`
	ValidationEvidence ValidationEvidence  `json:"validationEvidence"`
}
type AuthorBatch struct {
	SchemaVersion int           `json:"schemaVersion"`
	PlanID        string        `json:"planId"`
	PlanRevision  int           `json:"planRevision"`
	BatchHash     string        `json:"batchHash"`
	UseCase       BatchUseCase  `json:"usecase"`
	Modules       []BatchModule `json:"modules"`
}

func (b AuthorBatch) hash() (string, error) {
	payload := struct {
		SchemaVersion int           `json:"schemaVersion"`
		PlanID        string        `json:"planId"`
		PlanRevision  int           `json:"planRevision"`
		UseCase       BatchUseCase  `json:"usecase"`
		Modules       []BatchModule `json:"modules"`
	}{b.SchemaVersion, b.PlanID, b.PlanRevision, b.UseCase, b.Modules}
	raw, err := json.Marshal(payload)
	if err != nil || len(raw) > 4<<20 {
		return "", ErrInvalid
	}
	return scriptHash(string(raw)), nil
}
func (p *Postgres) batchEvidence(ctx context.Context, tx *sql.Tx, d draftState) (ValidationEvidence, string, error) {
	proof, err := p.validationProof(ctx, tx, d)
	if err != nil {
		return ValidationEvidence{}, "", err
	}
	if checkPublication(d.Revision, true, d, proof) != nil || proof.bundle == nil {
		return ValidationEvidence{}, "", ErrConflict
	}
	execution := d
	execution.ScriptOrigin = proof.bundle.origin()
	if _, _, err = executionForDraft(ctx, tx, execution); err != nil {
		return ValidationEvidence{}, "", err
	}

	var released bool
	if err = tx.QueryRowContext(ctx, `SELECT slot_released FROM runs WHERE id=$1`, proof.id).Scan(&released); err != nil || !released {
		return ValidationEvidence{}, "", ErrConflict
	}
	data, err := p.readArtifactBytes(ctx, tx, proof.id, proof.attemptID, "results.json", MaxArtifactBytes)
	if err != nil {
		return ValidationEvidence{}, "", ErrConflict
	}
	var report struct {
		Stats  *ValidationStats  `json:"stats"`
		Errors []json.RawMessage `json:"errors"`
	}
	if json.Unmarshal(data, &report) != nil || report.Stats == nil || report.Stats.Expected < 1 || report.Stats.Unexpected != 0 || report.Stats.Flaky < 0 || report.Stats.Skipped < 0 || report.Stats.Duration < 0 || report.Errors == nil || len(report.Errors) != 0 {
		return ValidationEvidence{}, "", ErrConflict
	}
	hash, err := proof.bundle.hash()
	if err != nil {
		return ValidationEvidence{}, "", err
	}
	return ValidationEvidence{RunID: proof.id, AttemptID: proof.attemptID, DraftRevision: d.Revision, ScriptHash: proof.hash, TimeoutMS: proof.timeoutMS, Status: "succeeded", ReportsReady: true, Stats: *report.Stats}, hash, nil
}
func (p *Postgres) buildPlanBatch(ctx context.Context, tx *sql.Tx, plan *Plan, d draftState, s EditingSession) (*AuthorBatch, error) {
	if plan.Status != "composed" || plan.BaseRevision != d.Revision || plan.ContextRevision != s.ContextRevision || plan.ValidationRunID == nil || d.ValidationRunID == nil || *plan.ValidationRunID != *d.ValidationRunID {
		return nil, ErrConflict
	}
	evidence, hash, err := p.batchEvidence(ctx, tx, d)
	if err != nil {
		return nil, err
	}
	b := &AuthorBatch{SchemaVersion: 1, PlanID: plan.ID, PlanRevision: plan.Revision, UseCase: BatchUseCase{d.TestID, s.ID, d.Revision, s.ContextRevision, hash, evidence}, Modules: []BatchModule{}}
	seen := map[string]string{}
	// Stable Module lock order avoids cross-batch lock inversion.
	stages := append([]PlanStage{}, plan.Stages...)
	sort.Slice(stages, func(i, j int) bool { return stages[i].ModuleTestID < stages[j].ModuleTestID })
	for _, stage := range stages {
		version := stage.ModuleVersionID
		mode := "reuse"
		if stage.Action != "reuse" {
			mode = "candidate"
			if stage.CandidateVersionID == nil {
				return nil, ErrConflict
			}
			version = *stage.CandidateVersionID
		}
		if prior := seen[stage.ModuleTestID]; prior != "" {
			if prior != version {
				return nil, ErrConflict
			}
			continue
		}
		seen[stage.ModuleTestID] = version
		if stage.Status != "ready" {
			return nil, ErrConflict
		}
		var md draftState
		var contextRevision int64
		var editing *string
		if mode == "candidate" {
			var revision int
			var boundHash string
			var session string
			if err = tx.QueryRowContext(ctx, `SELECT editing_session_id,revision,context_revision,bundle_hash FROM plan_module_candidates WHERE id=$1 AND plan_id=$2 AND test_id=$3`, version, plan.ID, stage.ModuleTestID).Scan(&session, &revision, &contextRevision, &boundHash); err != nil {
				return nil, err
			}
			var ms EditingSession
			md, ms, err = requireEditingDraft(ctx, tx, stage.ModuleTestID, session)
			if err != nil || md.Revision != revision || ms.ContextRevision != contextRevision {
				return nil, ErrConflict
			}
			editing = &session
			current, err := bundleForDraft(ctx, tx, md)
			if err != nil {
				return nil, err
			}
			currentHash, err := current.hash()
			if err != nil || currentHash != boundHash {
				return nil, ErrConflict
			}
		} else {
			v, e := scanVersion(tx.QueryRowContext(ctx, `SELECT `+versionColumns+` FROM test_versions WHERE id=$1 AND test_id=$2`, version, stage.ModuleTestID))
			if e != nil {
				return nil, e
			}
			var timeout int
			if err = tx.QueryRowContext(ctx, `SELECT context_revision,timeout_ms FROM test_versions WHERE id=$1`, version).Scan(&contextRevision, &timeout); err != nil {
				return nil, err
			}
			md = draftState{Draft: Draft{TestID: v.TestID, Revision: v.Revision, Script: v.Script, EditingSessionID: stringValue(v.EditingSessionID), ValidationRunID: v.ValidationRunID, Module: v.Module, Stages: v.Stages, WorkspaceSettings: v.WorkspaceSettings, WorkspaceContext: v.WorkspaceContext, ScriptOrigin: v.ScriptOrigin}, hash: scriptHash(v.Script), timeoutMS: timeout}
		}
		proof, bundleHash, err := p.batchEvidence(ctx, tx, md)
		if err != nil {
			return nil, err
		}
		if md.Module == nil {
			return nil, ErrConflict
		}
		m := md.Module
		entry := BatchModule{TestID: stage.ModuleTestID, VersionID: version, Mode: mode, EditingSessionID: editing, Revision: md.Revision, ContextRevision: contextRevision, BundleHash: bundleHash, HarnessHash: scriptHash(m.Harness), ValidationEvidence: proof, Module: BatchModuleMetadata{m.Slug, m.ModuleKind, m.ExportName, m.Signature, m.Inputs, m.Returns, m.Preconditions, m.Postconditions}}
		if err = tx.QueryRowContext(ctx, `SELECT name,description FROM tests WHERE id=$1`, stage.ModuleTestID).Scan(&entry.Name, &entry.Description); err != nil {
			return nil, err
		}
		// Reuse description is version-pinned; mutable current test text is not used.
		if mode == "reuse" {
			if err = tx.QueryRowContext(ctx, `SELECT COALESCE(published_name,module->>'slug'),description FROM test_versions WHERE id=$1`, version).Scan(&entry.Name, &entry.Description); err != nil {
				return nil, err
			}
		}
		b.Modules = append(b.Modules, entry)
	}
	sort.Slice(b.Modules, func(i, j int) bool { return b.Modules[i].VersionID < b.Modules[j].VersionID })
	b.BatchHash, err = b.hash()
	return b, err
}
