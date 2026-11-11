package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const MaxAuthorArtifactBytes int64 = 2 << 20
const authorFailureMessage = "AI authoring failed. The saved conversation and draft are preserved; you can retry."

type authorOutput struct {
	Message           *string `json:"message"`
	Script            *string `json:"script,omitempty"`
	RequestValidation *bool   `json:"requestValidation"`
}

func decodeAuthorOutput(data []byte) (authorOutput, error) {
	var result authorOutput
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if int64(len(data)) > MaxAuthorArtifactBytes || decoder.Decode(&result) != nil ||
		result.Message == nil || result.RequestValidation == nil || decoder.Decode(new(any)) != io.EOF {
		return result, fmt.Errorf("invalid author output")
	}
	if strings.ContainsRune(*result.Message, '\x00') || (result.Script != nil && (len(*result.Script) > MaxScriptBytes || strings.ContainsRune(*result.Script, '\x00'))) {
		return result, fmt.Errorf("author script exceeds limit")
	}
	return result, nil
}

type authorPlan struct {
	message           string
	script            string
	proposedScript    *string
	changed           bool
	requestValidation bool
}

func planAuthorResult(current Draft, baseRevision int, output authorOutput) (authorPlan, error) {
	plan := authorPlan{message: *output.Message, script: current.Script, proposedScript: output.Script}
	if current.Revision != baseRevision {
		plan.message += "\n\n草稿已在此回合後修改，建議未自動套用或驗證；請先檢視差異。"
		return plan, nil
	}
	if output.Script != nil {
		plan.script = *output.Script
		plan.changed = plan.script != current.Script
	}
	plan.requestValidation = *output.RequestValidation
	if plan.requestValidation && strings.TrimSpace(plan.script) == "" {
		return authorPlan{}, fmt.Errorf("cannot validate an empty author draft")
	}
	return plan, nil
}

// The original reported status is persisted independently of the safe server result.
// Replayed success remains idempotent even when invalid output became failed or a
// concurrent cancel won; no artifact is reread and no revision/validation is repeated.
func authorResultDisposition(currentStatus, priorReported string, incoming Result) (Result, bool, error) {
	if Terminal(currentStatus) {
		if priorReported == incoming.Status {
			return Result{}, true, nil
		}
		return Result{}, false, fmt.Errorf("%w: author terminal result is immutable", ErrConflict)
	}
	result := incoming
	if currentStatus == "cancelling" && result.Status == "succeeded" {
		result.Status = "cancelled"
	}
	switch result.Status {
	case "succeeded":
		result.Error = ""
	case "cancelled":
		result.Error = "AI authoring was cancelled. The saved draft is unchanged."
	case "timed_out":
		result.Error = "AI authoring timed out. The saved draft is unchanged; you can retry."
	default:
		result.Error = authorFailureMessage
	}
	return result, false, nil
}

func (p *Postgres) readAuthorOutput(ctx context.Context, tx *sql.Tx, runID, attemptID string) (authorOutput, error) {
	var key, hash string
	var size int64
	if err := tx.QueryRowContext(ctx, `SELECT storage_key,size_bytes,sha256 FROM artifacts
        WHERE run_id=$1 AND attempt_id=$2 AND name='author.json'`, runID, attemptID).Scan(&key, &size, &hash); err != nil {
		return authorOutput{}, err
	}
	if p.Artifacts == nil || size <= 0 || size > MaxAuthorArtifactBytes {
		return authorOutput{}, fmt.Errorf("author artifact unavailable")
	}
	f, err := p.Artifacts.Open(key)
	if err != nil {
		return authorOutput{}, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, MaxAuthorArtifactBytes+1))
	if err != nil || int64(len(data)) != size || scriptHash(string(data)) != hash {
		return authorOutput{}, fmt.Errorf("author artifact integrity mismatch")
	}
	return decodeAuthorOutput(data)
}

func (p *Postgres) completeAuthor(ctx context.Context, testID, managerID, runID, attemptID string, incoming Result) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Match Workspace -> Test -> Draft -> Run lock order. Posting a turn and applying a
	// result cannot race with a human save or create two active author runs.
	d, err := lockDraft(ctx, tx, testID)
	if err != nil {
		return err
	}
	status, err := lockAttempt(ctx, tx, managerID, runID, attemptID)
	if err != nil {
		return err
	}
	var reported sql.NullString
	var baseRevision int
	var rawInput []byte
	if err := tx.QueryRowContext(ctx, `SELECT author_reported_status,draft_revision,author_payload
        FROM runs WHERE id=$1`, runID).Scan(&reported, &baseRevision, &rawInput); err != nil {
		return err
	}
	result, duplicate, err := authorResultDisposition(status, reported.String, incoming)
	if err != nil || duplicate {
		return err
	}
	if result.Status == "succeeded" {
		var input AuthorInput
		output, outputErr := p.readAuthorOutput(ctx, tx, runID, attemptID)
		if json.Unmarshal(rawInput, &input) != nil || input.BaseRevision != baseRevision || !ValidID(input.ConversationID) {
			outputErr = fmt.Errorf("invalid author snapshot")
		}
		var conversationMatches bool
		if outputErr == nil {
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM conversations WHERE id=$1 AND test_id=$2)`, input.ConversationID, testID).Scan(&conversationMatches); err != nil {
				return err
			}
			if !conversationMatches {
				outputErr = fmt.Errorf("author conversation mismatch")
			}
		}
		var plan authorPlan
		if outputErr == nil {
			plan, outputErr = planAuthorResult(d.Draft, baseRevision, output)
		}
		if outputErr != nil {
			// Never expose provider body, invalid artifact details, or candidate scripts as errors.
			result = Result{Status: "failed", Error: authorFailureMessage}
		} else {
			var appliedRevision *int
			if plan.changed {
				d, err = saveDraftScript(ctx, tx, d, plan.script)
				if err != nil {
					return err
				}
				applied := d.Revision
				appliedRevision = &applied
			}
			var validationRunID *string
			if plan.requestValidation {
				validation, err := enqueueValidation(ctx, tx, d)
				if err != nil {
					return err
				}
				validationRunID = &validation.ID
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO messages
                (id,conversation_id,role,content,run_id,base_revision,applied_revision,proposed_script,validation_run_id)
                VALUES($1,$2,'assistant',$3,$4,$5,$6,$7,$8)`, NewID(), input.ConversationID,
				plan.message, runID, baseRevision, appliedRevision, plan.proposedScript, validationRunID); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET status=$2,error=$3,finished_at=now(),
        author_reported_status=$4,acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1`,
		runID, result.Status, result.Error, incoming.Status); err != nil {
		return err
	}
	return tx.Commit()
}
