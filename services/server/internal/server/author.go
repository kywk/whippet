package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"unicode/utf8"
)

const MaxAuthorArtifactBytes int64 = 2 << 20
const authorFailureMessage = "AI authoring failed. The saved conversation and draft are preserved; you can retry."

type authorOutput struct {
	ConversationSummary *string `json:"conversationSummary,omitempty"`
	Message             *string `json:"message"`
	Script              *string `json:"script,omitempty"`
	RequestValidation   *bool   `json:"requestValidation"`
}

func decodeAuthorOutput(data []byte) (authorOutput, error) {
	var result authorOutput
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if int64(len(data)) > MaxAuthorArtifactBytes || decoder.Decode(&result) != nil ||
		result.Message == nil || result.RequestValidation == nil || decoder.Decode(new(any)) != io.EOF {
		return result, fmt.Errorf("invalid author output")
	}
	if validateUserMessage(*result.Message) != nil || (result.ConversationSummary != nil && (len(*result.ConversationSummary) > 8192 || !utf8.ValidString(*result.ConversationSummary) || strings.ContainsRune(*result.ConversationSummary, '\x00'))) || strings.ContainsRune(*result.Message, '\x00') || (result.Script != nil && (len(*result.Script) > MaxScriptBytes || strings.ContainsRune(*result.Script, '\x00'))) {
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
	data, err := p.readArtifactBytes(ctx, tx, runID, attemptID, "author.json", MaxAuthorArtifactBytes)
	if err != nil {
		return authorOutput{}, err
	}
	return decodeAuthorOutput(data)
}

func (p *Postgres) completeAuthor(ctx context.Context, testID, managerID, runID, attemptID string, incoming Result) error {
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = lockEditingTest(ctx, tx, testID); err != nil {
		return err
	}
	status, err := lockAttempt(ctx, tx, managerID, runID, attemptID)
	if err != nil {
		return err
	}
	var reported sql.NullString
	var baseRevision int
	var rawInput, rawSettings, rawContext []byte
	var sessionID *string
	var script, origin string
	if err = tx.QueryRowContext(ctx, `SELECT author_reported_status,draft_revision,author_payload,editing_session_id,script_snapshot,workspace_settings,workspace_context,script_origin FROM runs WHERE id=$1`, runID).
		Scan(&reported, &baseRevision, &rawInput, &sessionID, &script, &rawSettings, &rawContext, &origin); err != nil {
		return err
	}
	result, duplicate, err := authorResultDisposition(status, reported.String, incoming)
	if err != nil || duplicate {
		return err
	}
	if result.Status == "succeeded" {
		var session EditingSession
		if sessionID != nil {
			session, err = readEditing(ctx, tx, testID, *sessionID)
		}
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if sessionID == nil || err != nil || session.Status != "active" {
			result = Result{Status: "cancelled", Error: "The editing session is closed; this result was not applied."}
		} else {
			d, readErr := scanDraft(tx.QueryRowContext(ctx, draftSelect+` FOR UPDATE OF d`, testID))
			if readErr != nil && !errors.Is(readErr, ErrNotFound) {
				return readErr
			}
			if readErr != nil || d.EditingSessionID != session.ID {
				result = Result{Status: "cancelled", Error: "The editing session is closed; this result was not applied."}
			} else {
				var input AuthorInput
				settings, settingsErr := decodeSettings(rawSettings)
				runContext, contextErr := decodeWorkspaceContext(rawContext)
				if settingsErr == nil {
					settingsErr = contextErr
				}
				if json.Unmarshal(rawInput, &input) != nil || settingsErr != nil || input.BaseRevision != baseRevision || input.ConversationID != session.ConversationID {
					result = Result{Status: "failed", Error: authorFailureMessage}
				} else if input.SkillID == "acceptance-summary" {
					data, outputErr := p.readArtifactBytes(ctx, tx, runID, attemptID, "author.json", MaxAuthorArtifactBytes)
					var out summaryOutput
					if outputErr == nil {
						out, outputErr = decodeSummaryOutput(data)
					}
					if outputErr != nil {
						result = Result{Status: "failed", Error: authorFailureMessage}
					} else {
						proof, proofErr := p.validationProof(ctx, tx, d)
						if effectiveScriptOrigin(origin) != effectiveScriptOrigin(d.ScriptOrigin) || proofErr != nil || checkPublication(d.Revision, true, d, proof) != nil || !summaryBindingMatches(session, d, input, script, settings, runContext) ||
							input.ValidationEvidence.AttemptID != proof.attemptID || d.summaryRunID == nil || *d.summaryRunID != runID {
							result = Result{Status: "failed", Error: "Acceptance summary no longer matches the current editing session."}
						} else if _, err = tx.ExecContext(ctx, `UPDATE drafts SET summary_description=$2,summary_background=$3,summary_name=$4 WHERE test_id=$1 AND summary_run_id=$5`, testID, out.Description, out.BackgroundSummary, out.Name, runID); err != nil {
							return err
						}
					}
				} else if input.SkillID != "" && (input.SkillID != "test-author" || input.SkillVersion != "1" || input.EditingSessionID != session.ID) {
					result = Result{Status: "failed", Error: authorFailureMessage}
				} else {
					output, outputErr := p.readAuthorOutput(ctx, tx, runID, attemptID)
					var plan authorPlan
					if outputErr == nil {
						plan, outputErr = planAuthorResult(d.Draft, baseRevision, output)
					}
					if outputErr != nil {
						result = Result{Status: "failed", Error: authorFailureMessage}
					} else {
						contextMatches := input.SkillID == "" || input.ContextRevision == session.ContextRevision
						snapshotMatches := effectiveScriptOrigin(origin) == effectiveScriptOrigin(d.ScriptOrigin) && contextMatches && d.Revision == baseRevision && script == d.Script && sameWorkspaceSettings(settings, d.WorkspaceSettings) && sameWorkspaceContext(runContext, d.WorkspaceContext)
						if !snapshotMatches {
							plan.changed = false
							plan.requestValidation = false
							if d.Revision == baseRevision {
								plan.message += "\n\n編輯背景已變更，建議未自動套用或驗證；請先檢視差異。"
							}
						}
						var appliedRevision *int
						if plan.changed {
							d, err = saveDraftScript(ctx, tx, d, plan.script, "ai")
							if err != nil {
								return err
							}
							applied := d.Revision
							appliedRevision = &applied
						}
						var validationID *string
						if plan.requestValidation {
							if _, _, permissionErr := executionForDraft(ctx, tx, d); permissionErr != nil {
								if !errors.Is(permissionErr, ErrScopeConfirmation) {
									return permissionErr
								}
								plan.requestValidation = false
								plan.message += "\n\nscope_confirmation_required：AI 套用後的草稿尚無有效確認範圍，未排驗證；草稿已保存。"
							}
						}
						if plan.requestValidation {
							validation, err := enqueueValidation(ctx, tx, d)
							if err != nil {
								return err
							}
							validationID = &validation.ID
						}
						if _, err = tx.ExecContext(ctx, `INSERT INTO messages(id,conversation_id,role,content,run_id,base_revision,applied_revision,proposed_script,validation_run_id)
       VALUES($1,$2,'assistant',$3,$4,$5,$6,$7,$8)`, NewID(), session.ConversationID, plan.message, runID, baseRevision, appliedRevision, plan.proposedScript, validationID); err != nil {
							return err
						}
						var recap *string
						if snapshotMatches {
							recap = output.ConversationSummary
						}
						if _, err = tx.ExecContext(ctx, `UPDATE editing_sessions SET context_revision=context_revision+1,conversation_summary=COALESCE($2,conversation_summary) WHERE id=$1`, session.ID, recap); err != nil {
							return err
						}
						if err = clearDraftSummary(ctx, tx, testID); err != nil {
							return err
						}
					}
				}
			}
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE runs SET status=$2,error=$3,finished_at=now(),author_reported_status=$4,
  acknowledged_at=COALESCE(acknowledged_at,now()) WHERE id=$1`, runID, result.Status, result.Error, incoming.Status); err != nil {
		return err
	}
	return tx.Commit()
}
