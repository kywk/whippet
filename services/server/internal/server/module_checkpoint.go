package server

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

func moduleCheckpointAuthor(input AuthorInput) bool {
	return input.SkillID == "module-authoring" && input.Platform != nil && input.Platform.Module != nil && (input.Platform.PlanID == nil) == (input.Platform.StageID == nil)
}

func standaloneModule(input AuthorInput) bool {
	return input.SkillID == "module-authoring" && input.Platform != nil && input.Platform.Module != nil && input.Platform.PlanID == nil && input.Platform.StageID == nil
}

// Same ordered length-prefixed UTF-8 fields as the Worker and Manager. Includes
// the complete harness; JSON escaping and object property order are irrelevant.
func moduleCheckpointHash(m *Module) string {
	var text strings.Builder
	for _, value := range []string{m.Slug, m.ModuleKind, m.ExportName, m.Signature, m.Inputs, m.Returns, m.Preconditions, m.Postconditions, m.Harness} {
		fmt.Fprintf(&text, "%d:%s", len(value), value)
	}
	return scriptHash(text.String())
}

func validateModulePartial(out moduleAuthorOutput, input AuthorInput, registry *ToolRegistry) error {
	if out.Partial == nil {
		return nil
	}
	p := out.Partial
	if !moduleCheckpointAuthor(input) || validateToolSnapshot(input, registry, "commit_module_candidate") != nil ||
		p.Reason != "checkpoint_saved" || !validOutputText(p.NextStep, 8192) ||
		out.RequestValidation == nil || *out.RequestValidation || out.Script == nil || out.Module == nil ||
		p.Checkpoint == nil || !p.Checkpoint.SelfTestPassed || !sha256Hex(p.Checkpoint.ScriptHash) || p.Checkpoint.ScriptHash != scriptHash(*out.Script) ||
		p.Checkpoint.ModuleHash == nil || !sha256Hex(*p.Checkpoint.ModuleHash) || *p.Checkpoint.ModuleHash != moduleCheckpointHash(out.Module) || !validAuthorUsage(p.Usage, input.Budget) {
		return ErrInvalid
	}
	return nil
}

// Both standalone and Stage continuation compare the persisted assignments.
func sameModuleContinuationSnapshot(ctx context.Context, tx *sql.Tx, sourceID, childID string) error {
	var same bool
	if err := tx.QueryRowContext(ctx, `SELECT s.workspace_context IS NOT DISTINCT FROM n.workspace_context
 AND s.workspace_settings IS NOT DISTINCT FROM n.workspace_settings
 AND s.authorization_revision IS NOT DISTINCT FROM n.authorization_revision
 AND s.scope_proposal_id IS NOT DISTINCT FROM n.scope_proposal_id
 AND s.author_engine=n.author_engine
 AND s.author_payload->'skills'=n.author_payload->'skills'
 AND s.author_payload->'model'=n.author_payload->'model'
 AND s.author_payload->'runtime' IS NOT DISTINCT FROM n.author_payload->'runtime'
 AND s.author_payload->'toolRegistryVersion'=n.author_payload->'toolRegistryVersion'
 AND s.author_payload->'toolRegistrySha256'=n.author_payload->'toolRegistrySha256'
 FROM runs s JOIN runs n ON n.id=$2 WHERE s.id=$1`, sourceID, childID).Scan(&same); err != nil {
		return err
	}
	if !same {
		return ErrConflict
	}
	return nil
}
