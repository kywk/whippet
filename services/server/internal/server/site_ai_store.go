package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

type siteAIError string

func (e siteAIError) Error() string { return string(e) }

const (
	errSiteAIStale       siteAIError = "stale_revision"
	errSiteAIArchiving   siteAIError = "workspace_archiving"
	errSiteAIArchived    siteAIError = "workspace_archived"
	errSiteAIBusy        siteAIError = "resource_busy"
	errSiteAIAction      siteAIError = "action_unavailable"
	errSiteAINotReady    siteAIError = "agent_not_ready"
	errSiteAIIdempotency siteAIError = "idempotency_conflict"
	errSiteAIUnsupported siteAIError = "unsupported_combination"
	errSiteAIDisabled    siteAIError = "disabled"
	errSiteAITransport   siteAIError = "protected_transport_required"
	errSiteAIClaimPaused siteAIError = "claim_paused"
)

const (
	siteAIManaged     = "managed"
	siteAISelfManaged = "self_managed"
	siteAIWaiting     = "waiting_connection"
	siteAIVerifying   = "verifying"
	siteAIReady       = "ready"
	siteAIFailed      = "failed"
	siteAIUnavailable = "disabled"
)

var siteAIPrimarySkills = []string{"acceptance-summary", "module-authoring", "test-author", "usecase-planner", "workspace-author"}

func validSiteAIEngine(engine string) bool {
	return engine == "builtin" || engine == "pi" || engine == "vercel"
}

func validSiteAIProvider(provider string) bool {
	return provider == "opencode" || provider == "openai-responses"
}

func validSiteAIModel(model string) bool {
	return modelName.MatchString(model) && !strings.HasPrefix(model, "opencode-go/")
}

func validSiteAIKey(key string) bool {
	if len(key) < 1 || len(key) > 4096 {
		return false
	}
	for i := range len(key) {
		if key[i] < 0x21 || key[i] > 0x7e {
			return false
		}
	}
	return true
}

func lockSiteAISuperAdmin(ctx context.Context, tx *sql.Tx, actor platformActor) error {
	role, err := lockActorSiteRole(ctx, tx, actor)
	if err != nil {
		return err
	}
	if role != superAdmin {
		return errForbidden
	}
	return nil
}

func siteAIWorkspaceStatus(ctx context.Context, q queryDB, workspaceID string, lock bool) (state, mode string, err error) {
	query := `SELECT archive_status,COALESCE(archive_mode,'') FROM workspaces WHERE id=$1`
	if lock {
		query += ` FOR NO KEY UPDATE`
	}
	err = q.QueryRowContext(ctx, query, workspaceID).Scan(&state, &mode)
	return state, mode, dbError(err)
}

func siteAIWorkspaceError(state string) error {
	switch state {
	case "active":
		return nil
	case "archiving":
		return errSiteAIArchiving
	case "archived":
		return errSiteAIArchived
	default:
		return ErrConflict
	}
}

func activeSiteAIWorkspace(ctx context.Context, tx *sql.Tx, workspaceID string) error {
	state, _, err := siteAIWorkspaceStatus(ctx, tx, workspaceID, true)
	if err != nil {
		return err
	}
	return siteAIWorkspaceError(state)
}

func siteAIActorKind(actor platformActor) string {
	if actor.bootstrap {
		return "bootstrap"
	}
	return "user"
}

type siteAIExecer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func recordSiteAIAudit(ctx context.Context, q siteAIExecer, kind, actor, action, targetType, target string, workspace, requestID *string, result string, code *string) error {
	return (managementAudit{actorKind: kind, actorID: actor, action: action, target: targetType, targetID: target,
		workspace: workspace, requestID: requestID}).record(ctx, q, result, code)
}

func recordSiteAIAction(ctx context.Context, q siteAIExecer, actor platformActor, action, targetType, target string, workspace, requestID *string) error {
	entry := platformAudit(actor, action, targetType, target, workspace)
	entry.requestID = requestID
	return entry.record(ctx, q, "succeeded", nil)
}

func siteAIRequestDigest(value any, key []byte) ([]byte, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, ErrInvalid
	}
	defer clear(raw)
	if key == nil {
		digest := sha256.Sum256(raw)
		return digest[:], nil
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(raw)
	return mac.Sum(nil), nil
}

func lockSiteAIRequest(ctx context.Context, tx *sql.Tx, actor platformActor, operation, requestID string, fingerprint []byte) (string, error) {
	kind := siteAIActorKind(actor)
	identity := strings.Join([]string{"site-ai", kind, actor.user.ID, operation, requestID}, ":")
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, identity); err != nil {
		return "", err
	}
	var target string
	var stored []byte
	err := tx.QueryRowContext(ctx, `SELECT target_id,fingerprint FROM site_ai_requests
 WHERE actor_kind=$1 AND actor_id=$2 AND operation=$3 AND request_id=$4`, kind, actor.user.ID, operation, requestID).Scan(&target, &stored)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !hmac.Equal(stored, fingerprint) {
		return "", errSiteAIIdempotency
	}
	return target, nil
}

func saveSiteAIRequest(ctx context.Context, tx *sql.Tx, actor platformActor, operation, requestID string, fingerprint []byte, target string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO site_ai_requests(actor_kind,actor_id,operation,request_id,fingerprint,target_id)
 VALUES($1,$2,$3,$4,$5,$6)`, siteAIActorKind(actor), actor.user.ID, operation, requestID, fingerprint, target)
	return err
}

type siteAIPage[T any] struct {
	Items     []T     `json:"items"`
	NextAfter *string `json:"nextAfter"`
}

func paginateSiteAI[T any](items []T, limit int, id func(T) string) siteAIPage[T] {
	page := siteAIPage[T]{Items: items}
	if len(items) > limit {
		page.Items = items[:limit]
		page.NextAfter = stringPointer(id(items[limit-1]))
	}
	return page
}
