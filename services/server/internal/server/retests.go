package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"slices"
	"strings"
	"time"
)

const maxRetestChecks = 32

type retestTarget struct {
	ProjectSlug      string `json:"projectSlug"`
	Environment      string `json:"environment"`
	DeploymentID     string `json:"deploymentId"`
	ArtifactRevision string `json:"artifactRevision"`
	Origin           string `json:"origin"`
	ProofPath        string `json:"proofPath"`
}

type retestObservation struct {
	DeploymentID     string            `json:"deploymentId"`
	ArtifactRevision string            `json:"artifactRevision"`
	Verified         bool              `json:"verified"`
	Checks           map[string]string `json:"checks,omitempty"`
}

func (o retestObservation) valid() bool {
	if !inspectionIdentifier.MatchString(o.DeploymentID) || !inspectionIdentifier.MatchString(o.ArtifactRevision) ||
		len(o.Checks) > 128 || !o.Verified && len(o.Checks) > 0 {
		return false
	}
	for digest, status := range o.Checks {
		if !inspectionDigest.MatchString(digest) || status != "passed" && status != "failed" {
			return false
		}
	}
	return true
}

type publishedRunExtension interface {
	prior(context.Context, *sql.Tx) (string, error)
	matches(workspace, version string, snapshot *WorkspaceContext) bool
	record(context.Context, *sql.Tx, string) error
}

type retestSchedule struct {
	inspectionSchedule
	target    retestTarget
	checkPlan map[string]string
}

func (s retestSchedule) prior(ctx context.Context, tx *sql.Tx) (string, error) {
	key := jsonText([]string{"whippet-deployment-retest", s.target.ProjectSlug, s.target.Environment,
		s.target.DeploymentID, s.test.TestID, s.VersionID})
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
		return "", err
	}
	var run, workspace, revision, origin, proofPath string
	var raw []byte
	err := tx.QueryRowContext(ctx, `SELECT run_id,workspace_id,artifact_revision,target_origin,proof_path,check_plan
		FROM deployment_retests WHERE project_slug=$1 AND environment=$2 AND deployment_id=$3 AND test_id=$4 AND version_id=$5`,
		s.target.ProjectSlug, s.target.Environment, s.target.DeploymentID, s.test.TestID, s.VersionID).
		Scan(&run, &workspace, &revision, &origin, &proofPath, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var stored map[string]string
	if workspace != s.source.WorkspaceID || revision != s.target.ArtifactRevision || origin != s.target.Origin ||
		proofPath != s.target.ProofPath || json.Unmarshal(raw, &stored) != nil || !maps.Equal(stored, s.checkPlan) {
		return "", ErrConflict
	}
	return run, nil
}

func (s retestSchedule) record(ctx context.Context, tx *sql.Tx, run string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO deployment_retests
		(run_id,workspace_id,test_id,version_id,project_slug,environment,deployment_id,artifact_revision,target_origin,proof_path,check_plan)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, run, s.source.WorkspaceID, s.test.TestID, s.VersionID,
		s.target.ProjectSlug, s.target.Environment, s.target.DeploymentID, s.target.ArtifactRevision,
		s.target.Origin, s.target.ProofPath, jsonText(s.checkPlan))
	return err
}

func lookupRetestTarget(ctx context.Context, q queryDB, run string) (*retestTarget, error) {
	var target retestTarget
	err := q.QueryRowContext(ctx, `SELECT project_slug,environment,deployment_id,artifact_revision,target_origin,proof_path
		FROM deployment_retests WHERE run_id=$1`, run).Scan(&target.ProjectSlug, &target.Environment, &target.DeploymentID,
		&target.ArtifactRevision, &target.Origin, &target.ProofPath)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &target, err
}

type retestCheckResult struct {
	CheckKey string `json:"checkKey"`
	Status   string `json:"status"`
}

type deploymentRetestRun struct {
	terminalInspectionRun
	DeploymentID      string              `json:"deploymentId"`
	ArtifactRevision  string              `json:"artifactRevision"`
	AttemptGeneration int                 `json:"attemptGeneration,omitempty"`
	Checks            []retestCheckResult `json:"checks"`
}

func (p *Postgres) deploymentRetest(ctx context.Context, source *inspectionSource, runID string) (deploymentRetestRun, error) {
	var item deploymentRetestRun
	item.Purpose = "deployment_retest"
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return item, err
	}
	defer tx.Rollback()
	var ended *time.Time
	var reportKey sql.NullString
	var reportSize sql.NullInt64
	var scopeCurrent bool
	var planRaw, observedRaw []byte
	err = tx.QueryRowContext(ctx, `SELECT r.workspace_id,r.test_id,r.id,r.attempt_id,r.version_id,d.environment,r.status,
		r.started_at,r.finished_at,d.deployment_id,d.artifact_revision,d.check_plan,d.observation,a.storage_key,a.size_bytes,
		COALESCE(r.authorization_revision=w.authorization_revision,false)
		FROM deployment_retests d JOIN runs r ON r.id=d.run_id AND r.workspace_id=d.workspace_id
		  AND r.test_id=d.test_id AND r.version_id=d.version_id
		JOIN workspaces w ON w.id=d.workspace_id
		LEFT JOIN artifacts a ON a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html'
		WHERE d.run_id=$1 AND d.workspace_id=$2 AND d.environment=$3 AND d.project_slug=$4 AND d.target_origin=$5
		  AND d.proof_path=$6 AND w.lifecycle='active' AND w.scope_status='confirmed'`,
		runID, source.WorkspaceID, source.Environment, source.ProjectSlug, source.TargetOrigin, source.DeploymentProofPath).
		Scan(&item.WorkspaceID, &item.TestID, &item.RunID, &item.AttemptID, &item.VersionID, &item.Environment, &item.Status,
			&item.StartedAt, &ended, &item.DeploymentID, &item.ArtifactRevision, &planRaw, &observedRaw, &reportKey, &reportSize, &scopeCurrent)
	if err != nil {
		return item, dbError(err)
	}
	test, approved := source.test(item.TestID)
	if !approved || !slices.Contains(test.VersionIDs, item.VersionID) {
		return item, ErrNotFound
	}
	if !Terminal(item.Status) || ended == nil {
		return item, ErrConflict
	}
	item.FinishedAt = ended.UTC()
	if item.StartedAt != nil {
		started := item.StartedAt.UTC()
		item.StartedAt = &started
	}
	if item.AttemptID != nil {
		item.AttemptGeneration = 1 // A Run has one immutable attempt; retry schedules reserve a different Run.
	}
	var plan map[string]string
	if json.Unmarshal(planRaw, &plan) != nil || len(plan) == 0 || len(plan) > maxRetestChecks {
		return item, ErrConflict
	}
	p.retestEvidence(ctx, tx, &item, test, plan, observedRaw, scopeCurrent, reportKey, reportSize)
	return item, tx.Commit()
}

func (p *Postgres) retestEvidence(ctx context.Context, tx *sql.Tx, item *deploymentRetestRun, test inspectionTest,
	plan map[string]string, observedRaw []byte, scopeCurrent bool, reportKey sql.NullString, reportSize sql.NullInt64) {
	keys := slices.Sorted(maps.Keys(plan))
	item.Checks = make([]retestCheckResult, 0, len(keys))
	for _, key := range keys {
		item.Checks = append(item.Checks, retestCheckResult{CheckKey: key, Status: "skipped"})
	}
	switch item.Status {
	case "cancelled", "timed_out":
		item.Outcome = item.Status
		return
	case "interrupted":
		item.Outcome = "infrastructure"
		return
	}
	item.Outcome = "unverified"
	if len(observedRaw) == 0 && item.Status == "failed" {
		item.Outcome = "infrastructure"
		return
	}
	var observation retestObservation
	if !scopeCurrent || item.AttemptID == nil || item.StartedAt == nil ||
		json.Unmarshal(observedRaw, &observation) != nil || !observation.valid() || !observation.Verified ||
		observation.DeploymentID != item.DeploymentID || observation.ArtifactRevision != item.ArtifactRevision ||
		!p.reportReady(reportKey, reportSize) {
		return
	}
	stats := p.verifiedRunStats(ctx, tx, item.RunID, *item.AttemptID)
	if stats == nil {
		return
	}
	current := test.checks()
	passed := 0
	var failed []string
	for _, key := range keys {
		if current[key] != plan[key] {
			return
		}
		switch observation.Checks[plan[key]] {
		case "passed":
			passed++
		case "failed":
			failed = append(failed, key)
		}
	}
	if item.Status == "succeeded" && passed == len(keys) && len(failed) == 0 && stats.Expected > 0 && stats.Unexpected == 0 {
		item.Outcome = "passed"
	} else if item.Status == "failed" && len(failed) > 0 && stats.Unexpected > 0 {
		item.Outcome = "assertion_failed"
		item.FailureSignature = scriptHash("whippet.retest.assertion.v1\x00" + jsonText(failed))
	}
	for i, key := range keys {
		if status := observation.Checks[plan[key]]; status != "" {
			item.Checks[i].Status = status
		}
	}
	if item.Outcome == "passed" || item.Outcome == "assertion_failed" {
		item.ReportURL = "/api/runs/" + item.RunID + "/artifacts/report.html"
	}
}

func (a *API) retestHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	values := r.Header.Values("Authorization")
	if len(values) != 1 || !strings.HasPrefix(values[0], "Bearer ") || len(r.Header.Values("X-Whippet-Admin-Token")) != 0 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "retest bearer token required")
		return
	}
	schedule := r.Method == http.MethodPost
	source := a.inspections.source(r.PathValue("workspaceId"), strings.TrimPrefix(values[0], "Bearer "), schedule)
	if source == nil || source.DeploymentProofPath == "" {
		writeError(w, http.StatusForbidden, "forbidden", "retest scope denied")
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "retest store unavailable")
		return
	}
	if !schedule {
		runID := r.PathValue("runId")
		if !inspectionID(runID) {
			a.fail(w, ErrInvalid)
			return
		}
		result, err := p.deploymentRetest(r.Context(), source, runID)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	var body struct {
		TestID           string   `json:"testId"`
		VersionID        string   `json:"versionId"`
		Environment      string   `json:"environment"`
		DeploymentID     string   `json:"deploymentId"`
		ArtifactRevision string   `json:"artifactRevision"`
		CheckKeys        []string `json:"checkKeys"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if decodeBody(w, r, &body) != nil || !inspectionID(body.TestID) || !inspectionID(body.VersionID) ||
		!inspectionIdentifier.MatchString(body.DeploymentID) || !inspectionIdentifier.MatchString(body.ArtifactRevision) ||
		len(body.CheckKeys) == 0 || len(body.CheckKeys) > maxRetestChecks {
		a.fail(w, ErrInvalid)
		return
	}
	test, allowed := source.test(body.TestID)
	if !allowed || !slices.Contains(test.VersionIDs, body.VersionID) || body.Environment != source.Environment {
		a.fail(w, errForbidden)
		return
	}
	configured := test.checks()
	plan := make(map[string]string, len(body.CheckKeys))
	for i, key := range body.CheckKeys {
		if !inspectionIdentifier.MatchString(key) || i > 0 && key <= body.CheckKeys[i-1] {
			a.fail(w, ErrInvalid)
			return
		}
		value, ok := configured[key]
		if !ok {
			a.fail(w, errForbidden)
			return
		}
		plan[key] = value
	}
	target := retestTarget{source.ProjectSlug, source.Environment, body.DeploymentID, body.ArtifactRevision,
		source.TargetOrigin, source.DeploymentProofPath}
	item, err := p.createRun(r.Context(), body.TestID, retestSchedule{
		inspectionSchedule: inspectionSchedule{source: source, test: test, VersionID: body.VersionID},
		target:             target, checkPlan: plan,
	})
	if err != nil {
		a.fail(w, err)
		return
	}
	if a.engine != nil {
		a.engine.Wake()
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"runId": item.ID})
}
