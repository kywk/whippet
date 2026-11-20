package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"
)

type inspectionSchedule struct {
	source    *inspectionSource
	test      inspectionTest
	VersionID string `json:"versionId"`
	RequestID string `json:"requestId"`
}

func (s inspectionSchedule) prior(ctx context.Context, tx *sql.Tx) (string, error) {
	lock := strings.Join([]string{"whippet-inspection", s.source.WorkspaceID, s.source.Environment, s.RequestID}, "/")
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, lock); err != nil {
		return "", err
	}
	var run, test, version, target, project string
	err := tx.QueryRowContext(ctx, `SELECT i.run_id,r.test_id,r.version_id,i.target_origin,i.project_slug FROM inspection_runs i
		JOIN runs r ON r.id=i.run_id WHERE i.workspace_id=$1 AND i.environment=$2 AND i.request_id=$3`,
		s.source.WorkspaceID, s.source.Environment, s.RequestID).Scan(&run, &test, &version, &target, &project)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if test != s.test.TestID || version != s.VersionID || target != s.source.TargetOrigin || project != s.source.ProjectSlug {
		return "", ErrConflict
	}
	return run, nil
}

func (s inspectionSchedule) matches(workspace, version string, snapshot *WorkspaceContext) bool {
	if workspace != s.source.WorkspaceID || version != s.VersionID || snapshot == nil || snapshot.Config == nil {
		return false
	}
	cfg := snapshot.Config
	if len(cfg.Targets) != 1 || cfg.Targets[0].Origin != s.source.TargetOrigin || !validWebsiteURL(cfg.DefaultTestURL) {
		return false
	}
	u, err := url.Parse(cfg.DefaultTestURL)
	if err != nil {
		return false
	}
	origin, err := normalizedOrigin(u.Scheme + "://" + u.Host)
	return err == nil && origin == s.source.TargetOrigin
}

func (s inspectionSchedule) record(ctx context.Context, tx *sql.Tx, run string) error {
	expected := scriptHash(s.test.TestTitle + "\x00" + s.test.AssertionTitle)
	_, err := tx.ExecContext(ctx, `INSERT INTO inspection_runs(run_id,workspace_id,environment,target_origin,project_slug,request_id,check_key,expected_assertion)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, run, s.source.WorkspaceID, s.source.Environment, s.source.TargetOrigin,
		s.source.ProjectSlug, s.RequestID, s.test.CheckKey, expected)
	return err
}

type terminalInspectionRun struct {
	WorkspaceID      string     `json:"workspaceId"`
	TestID           string     `json:"testId"`
	RunID            string     `json:"runId"`
	AttemptID        *string    `json:"attemptId,omitempty"`
	VersionID        string     `json:"versionId"`
	Environment      string     `json:"environment"`
	Purpose          string     `json:"purpose"`
	Status           string     `json:"status"`
	StartedAt        *time.Time `json:"startedAt,omitempty"`
	FinishedAt       time.Time  `json:"finishedAt"`
	Outcome          string     `json:"outcome"`
	CheckKey         string     `json:"checkKey,omitempty"`
	FailureSignature string     `json:"failureSignature,omitempty"`
	ReportURL        string     `json:"reportUrl,omitempty"`
}

type inspectionTerminalRow struct {
	terminalInspectionRun
	serial          int64
	checkKey        string
	assertion       string
	hasCurrentScope bool
	observedTarget  bool
	reportKey       sql.NullString
	reportSize      sql.NullInt64
}

const inspectionTerminalSelect = `SELECT r.workspace_id,r.test_id,r.id,r.attempt_id,r.version_id,i.environment,
	r.status,r.started_at,r.finished_at,i.terminal_seq,i.check_key,a.storage_key,a.size_bytes,
	COALESCE(i.observed_assertion,''),i.observed_target,
	COALESCE(r.authorization_revision=w.authorization_revision, false)
	FROM inspection_runs i JOIN runs r ON r.id=i.run_id AND r.workspace_id=i.workspace_id
	JOIN workspaces w ON w.id=i.workspace_id
	LEFT JOIN artifacts a ON a.run_id=r.id AND a.attempt_id=r.attempt_id AND a.name='report.html'
	WHERE i.workspace_id=$1 AND i.environment=$2 AND i.project_slug=$3 AND i.target_origin=$4
	  AND EXISTS (SELECT 1 FROM unnest($5::uuid[],$6::uuid[]) allowed(test_id,version_id)
	    WHERE allowed.test_id=r.test_id AND allowed.version_id=r.version_id)
	  AND i.terminal_seq IS NOT NULL
	  AND w.lifecycle='active' AND w.scope_status='confirmed'`

func (s *inspectionSource) queryArgs() []any {
	var tests, versions []string
	for _, test := range s.Tests {
		for _, version := range test.VersionIDs {
			tests = append(tests, test.TestID)
			versions = append(versions, version)
		}
	}
	return []any{s.WorkspaceID, s.Environment, s.ProjectSlug, s.TargetOrigin, pq.Array(tests), pq.Array(versions)}
}

func scanInspectionTerminal(row scanner) (inspectionTerminalRow, error) {
	var item inspectionTerminalRow
	item.Purpose = "inspection"
	err := row.Scan(&item.WorkspaceID, &item.TestID, &item.RunID, &item.AttemptID, &item.VersionID, &item.Environment,
		&item.Status, &item.StartedAt, &item.FinishedAt, &item.serial, &item.checkKey, &item.reportKey, &item.reportSize,
		&item.assertion, &item.observedTarget, &item.hasCurrentScope)
	item.FinishedAt = item.FinishedAt.UTC()
	if item.StartedAt != nil {
		started := item.StartedAt.UTC()
		item.StartedAt = &started
	}
	return item, dbError(err)
}

func (p *Postgres) inspectionEvidence(ctx context.Context, tx *sql.Tx, item inspectionTerminalRow, source *inspectionSource) terminalInspectionRun {
	run := item.terminalInspectionRun
	switch run.Status {
	case "cancelled", "timed_out":
		run.Outcome = run.Status
		return run
	case "interrupted":
		run.Outcome = "infrastructure"
		return run
	case "failed":
		if !item.observedTarget {
			run.Outcome = "infrastructure"
			return run
		}
	}
	run.Outcome = "unverified"
	test, _ := source.test(run.TestID)
	if run.AttemptID == nil || run.StartedAt == nil || !item.hasCurrentScope || !item.observedTarget || item.checkKey != test.CheckKey ||
		!p.reportReady(item.reportKey, item.reportSize) {
		return run
	}
	if run.Status == "failed" && item.assertion != scriptHash(test.TestTitle+"\x00"+test.AssertionTitle) {
		return run
	}
	stats := p.verifiedRunStats(ctx, tx, run.RunID, *run.AttemptID)
	if stats == nil {
		return run
	}
	if run.Status == "succeeded" && stats.Expected > 0 && stats.Unexpected == 0 {
		run.Outcome = "passed"
	} else if run.Status == "failed" && stats.Unexpected == 1 {
		run.Outcome = "assertion_failed"
		run.CheckKey = item.checkKey
		run.FailureSignature = scriptHash("whippet.assertion.v1\x00" + run.CheckKey)
	}
	if run.Outcome == "passed" || run.Outcome == "assertion_failed" {
		run.ReportURL = "/api/runs/" + run.RunID + "/artifacts/report.html"
	}
	return run
}

type verifiedPlaywrightStats struct {
	Expected   int `json:"expected"`
	Unexpected int `json:"unexpected"`
}

func (p *Postgres) verifiedRunStats(ctx context.Context, tx *sql.Tx, runID, attemptID string) *verifiedPlaywrightStats {
	data, err := p.readArtifactBytes(ctx, tx, runID, attemptID, "results.json", 4<<20)
	if err != nil {
		return nil
	}
	var report struct {
		Stats  *verifiedPlaywrightStats `json:"stats"`
		Errors []json.RawMessage        `json:"errors"`
	}
	if json.Unmarshal(data, &report) != nil || report.Stats == nil || report.Errors == nil || len(report.Errors) != 0 {
		return nil
	}
	return report.Stats
}

type inspectionPage struct {
	Items      []terminalInspectionRun `json:"items"`
	NextCursor string                  `json:"nextCursor,omitempty"`
}

func (p *Postgres) inspectionPage(ctx context.Context, source *inspectionSource, after int64, limit int) (inspectionPage, error) {
	page := inspectionPage{Items: []terminalInspectionRun{}}
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	args := append(source.queryArgs(), after, limit)
	rows, err := tx.QueryContext(ctx, inspectionTerminalSelect+` AND i.terminal_seq>$7 ORDER BY i.terminal_seq LIMIT $8`, args...)
	if err != nil {
		return page, err
	}
	var items []inspectionTerminalRow
	for rows.Next() {
		item, err := scanInspectionTerminal(rows)
		if err != nil {
			rows.Close()
			return page, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return page, err
	}
	rows.Close()
	for _, item := range items {
		page.Items = append(page.Items, p.inspectionEvidence(ctx, tx, item, source))
		page.NextCursor = strconv.FormatInt(item.serial, 10)
	}
	return page, tx.Commit()
}

func (p *Postgres) inspectionRun(ctx context.Context, source *inspectionSource, runID string) (terminalInspectionRun, error) {
	tx, err := p.DB.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return terminalInspectionRun{}, err
	}
	defer tx.Rollback()
	item, err := scanInspectionTerminal(tx.QueryRowContext(ctx, inspectionTerminalSelect+` AND i.run_id=$7`,
		append(source.queryArgs(), runID)...))
	if err != nil {
		return terminalInspectionRun{}, err
	}
	return p.inspectionEvidence(ctx, tx, item, source), tx.Commit()
}

type inspectionLink struct {
	WorkspaceID    string `json:"workspaceId"`
	RunID          string `json:"runId"`
	AttemptID      string `json:"attemptId"`
	ProjectSlug    string `json:"projectSlug"`
	ReportPublicID string `json:"reportPublicId"`
}

func (p *Postgres) addInspectionLink(ctx context.Context, source *inspectionSource, link inspectionLink) (inspectionLink, error) {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return link, err
	}
	defer tx.Rollback()
	item, err := scanInspectionTerminal(tx.QueryRowContext(ctx, inspectionTerminalSelect+` AND i.run_id=$7 FOR UPDATE OF i FOR SHARE OF w`,
		append(source.queryArgs(), link.RunID)...))
	if err != nil {
		return link, err
	}
	if item.AttemptID == nil || *item.AttemptID != link.AttemptID {
		return link, ErrConflict
	}
	var savedAttempt, savedReport string
	err = tx.QueryRowContext(ctx, `SELECT attempt_id,report_public_id FROM inspection_report_links WHERE run_id=$1`, link.RunID).
		Scan(&savedAttempt, &savedReport)
	if err == nil {
		if savedAttempt != link.AttemptID || savedReport != link.ReportPublicID {
			return link, ErrConflict
		}
		return link, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return link, err
	}
	if p.inspectionEvidence(ctx, tx, item, source).Outcome != "assertion_failed" {
		return link, ErrConflict
	}
	reportURL := source.FeedbackOrigin + "/p/" + url.PathEscape(link.ProjectSlug) + "/reports/" + url.PathEscape(link.ReportPublicID)
	if _, err = tx.ExecContext(ctx, `INSERT INTO inspection_report_links(run_id,attempt_id,report_public_id,report_url) VALUES ($1,$2,$3,$4)`,
		link.RunID, link.AttemptID, link.ReportPublicID, reportURL); err != nil {
		return link, err
	}
	return link, tx.Commit()
}

// Machine credentials are accepted only here and are bound to a single
// workspace, environment, and operation role.
func (a *API) inspectionHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	headers := r.Header.Values("Authorization")
	if len(headers) != 1 || !strings.HasPrefix(headers[0], "Bearer ") ||
		len(r.Header.Values("X-Whippet-Admin-Token")) != 0 {
		writeError(w, http.StatusUnauthorized, "unauthorized", "inspection bearer token required")
		return
	}
	workspace, runID := r.PathValue("workspaceId"), r.PathValue("runId")
	create := r.Method == http.MethodPost && runID == ""
	source := a.inspections.source(workspace, strings.TrimPrefix(headers[0], "Bearer "), create)
	if source == nil {
		writeError(w, http.StatusForbidden, "forbidden", "inspection scope denied")
		return
	}
	if runID != "" && !inspectionID(runID) {
		a.fail(w, ErrInvalid)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "inspection store unavailable")
		return
	}
	var result any
	var err error
	status := http.StatusOK
	switch {
	case create:
		var body struct {
			TestID      string `json:"testId"`
			VersionID   string `json:"versionId"`
			Environment string `json:"environment"`
			RequestID   string `json:"requestId"`
		}
		err = decodeAccessBody(w, r, &body, false)
		test, allowed := source.test(body.TestID)
		if err != nil || !inspectionID(body.VersionID) || !inspectionID(body.RequestID) {
			err = ErrInvalid
		} else if !allowed || !slices.Contains(test.VersionIDs, body.VersionID) || body.Environment != source.Environment {
			err = errForbidden
		} else {
			item, e := p.createRun(r.Context(), body.TestID, &inspectionSchedule{source, test, body.VersionID, body.RequestID})
			err = e
			if err == nil {
				if a.engine != nil {
					a.engine.Wake()
				}
				result = map[string]string{"runId": item.ID}
				status = http.StatusAccepted
			}
		}
	case r.Method == http.MethodPost:
		var body struct {
			AttemptID      string `json:"attemptId"`
			ProjectSlug    string `json:"projectSlug"`
			ReportPublicID string `json:"reportPublicId"`
		}
		err = decodeAccessBody(w, r, &body, false)
		if err != nil || !inspectionID(body.AttemptID) || !inspectionID(body.ReportPublicID) {
			err = ErrInvalid
		} else if body.ProjectSlug != source.ProjectSlug {
			err = errForbidden
		} else {
			result, err = p.addInspectionLink(r.Context(), source, inspectionLink{workspace, runID, body.AttemptID, body.ProjectSlug, body.ReportPublicID})
		}
	case runID != "":
		result, err = p.inspectionRun(r.Context(), source, runID)
	default:
		var after int64
		limit := 50
		query := r.URL.Query()
		if raw := query.Get("after"); raw != "" {
			after, err = strconv.ParseInt(raw, 10, 64)
		}
		if err == nil && query.Get("limit") != "" {
			limit, err = strconv.Atoi(query.Get("limit"))
		}
		if err != nil || after < 0 || limit < 1 || limit > 100 {
			err = ErrInvalid
		} else {
			result, err = p.inspectionPage(r.Context(), source, after, limit)
		}
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, status, result)
}
