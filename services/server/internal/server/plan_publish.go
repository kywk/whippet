package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type PlanPublication struct {
	UseCaseVersion Version   `json:"usecaseVersion"`
	ModuleVersions []Version `json:"moduleVersions"`
}

func (p *Postgres) PublishPlan(ctx context.Context, id string, revision int, summary string) (PlanPublication, error) {
	empty := PlanPublication{}
	if revision < 1 || !ValidID(summary) {
		return empty, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	var test string
	if err = tx.QueryRowContext(ctx, `SELECT test_id FROM plans WHERE id=$1`, id).Scan(&test); err != nil {
		return empty, dbError(err)
	}
	if _, err = lockEditingTest(ctx, tx, test); err != nil {
		return empty, err
	}
	plan, err := scanPlan(tx.QueryRowContext(ctx, `SELECT `+planColumns+` FROM plans WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return empty, err
	}
	var oldRevision int
	var oldSummary string
	var prior []byte
	err = tx.QueryRowContext(ctx, `SELECT request_revision,summary_run_id,result FROM plan_publications WHERE plan_id=$1`, id).Scan(&oldRevision, &oldSummary, &prior)
	if err == nil {
		if oldRevision != revision || oldSummary != summary {
			return empty, ErrConflict
		}
		var result PlanPublication
		if json.Unmarshal(prior, &result) != nil {
			return empty, ErrConflict
		}
		return result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return empty, err
	}
	if plan.Revision != revision || plan.Status != "composed" {
		return empty, ErrConflict
	}
	d, s, err := requireEditingDraft(ctx, tx, test, plan.EditingSessionID)
	if err != nil {
		return empty, err
	}
	batch, err := p.buildPlanBatch(ctx, tx, plan, d, s)
	if err != nil {
		return empty, err
	}
	var output, inputRaw []byte
	var hash, status string
	var released bool
	err = tx.QueryRowContext(ctx, `SELECT ps.output,ps.batch_hash,r.status,r.slot_released,r.author_payload FROM plan_summaries ps JOIN runs r ON r.id=ps.run_id WHERE ps.run_id=$1 AND ps.plan_id=$2 FOR UPDATE OF r`, summary, id).Scan(&output, &hash, &status, &released, &inputRaw)
	if err != nil || hash != batch.BatchHash || status != "succeeded" || !released || len(output) == 0 {
		return empty, ErrConflict
	}
	var input AuthorInput
	var out summaryOutput
	if json.Unmarshal(inputRaw, &input) != nil || input.Batch == nil || input.Batch.BatchHash != hash || json.Unmarshal(output, &out) != nil {
		return empty, ErrConflict
	}
	snapshotHash, err := input.Batch.hash()
	if err != nil || snapshotHash != hash {
		return empty, ErrConflict
	}
	result := PlanPublication{ModuleVersions: []Version{}}
	for _, module := range batch.Modules {
		if module.Mode != "candidate" {
			continue
		}
		md, ms, err := requireEditingDraft(ctx, tx, module.TestID, *module.EditingSessionID)
		if err != nil {
			return empty, err
		}
		if _, _, err = executionForDraft(ctx, tx, md); err != nil {
			return empty, err
		}
		description := ""
		if module.Description != nil {
			description = *module.Description
		}
		version, err := publishBatchVersion(ctx, tx, module.VersionID, md, ms, summary, hash, module.BundleHash, description, out.BackgroundSummary, module.Name)
		if err != nil {
			return empty, err
		}
		result.ModuleVersions = append(result.ModuleVersions, version)
	}
	// All Module IDs exist before inserting immutable Use Case dependencies.
	name := out.Name
	if name == nil {
		var current string
		if err = tx.QueryRowContext(ctx, `SELECT name FROM tests WHERE id=$1`, test).Scan(&current); err != nil {
			return empty, err
		}
		name = &current
	}
	version, err := publishBatchVersion(ctx, tx, NewID(), d, s, summary, hash, batch.UseCase.BundleHash, out.Description, out.BackgroundSummary, *name)
	if err != nil {
		return empty, err
	}
	result.UseCaseVersion = version
	for _, m := range batch.Modules {
		if _, err = tx.ExecContext(ctx, `INSERT INTO version_dependencies(version_id,module_version_id) VALUES($1,$2)`, version.ID, m.VersionID); err != nil {
			return empty, err
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE plans SET status='done',revision=revision+1 WHERE id=$1`, id); err != nil {
		return empty, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO plan_publications(plan_id,request_revision,summary_run_id,result) VALUES($1,$2,$3,$4)`, id, revision, summary, jsonText(result)); err != nil {
		return empty, err
	}
	return result, tx.Commit()
}
func publishBatchVersion(ctx context.Context, tx *sql.Tx, id string, d draftState, s EditingSession, summary, batchHash, bundleHash, description, background, name string) (Version, error) {
	var batchBinding any
	if batchHash != "" {
		batchBinding = batchHash
	}
	version, err := scanVersion(tx.QueryRowContext(ctx, `INSERT INTO test_versions(id,test_id,version,source_revision,script,script_hash,timeout_ms,validation_run_id,workspace_settings,description,background_summary,summary_run_id,editing_session_id,workspace_context,script_origin,module,stages,context_revision,bundle_hash,summary_batch_hash,published_name) SELECT $1,$2,COALESCE(MAX(version),0)+1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20 FROM test_versions WHERE test_id=$2 RETURNING `+versionColumns, id, d.TestID, d.Revision, d.Script, d.hash, d.timeoutMS, d.ValidationRunID, settingsJSON(d.WorkspaceSettings), description, background, summary, s.ID, jsonText(d.WorkspaceContext), d.ScriptOrigin, jsonText(d.Module), stagesJSON(d.Stages), s.ContextRevision, bundleHash, batchBinding, name))
	if err != nil {
		return Version{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE tests SET published_version_id=$2,description=$3,name=$4 WHERE id=$1`, d.TestID, version.ID, description, name); err != nil {
		return Version{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET status='published',published_version_id=$2,closed_at=now() WHERE id=$1`, s.ID, version.ID); err != nil {
		return Version{}, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM drafts WHERE test_id=$1 AND editing_session_id=$2`, d.TestID, s.ID); err != nil {
		return Version{}, err
	}
	return version, nil
}
