package manager

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

var authorEnvNames = []string{
	"WHIPPET_AI_ENABLED", "WHIPPET_AI_BASE_URL", "WHIPPET_AI_MODEL",
	"WHIPPET_AI_REASONING_EFFORT", "OPENCODE_API_KEY",
}

var authorProgressPattern = regexp.MustCompile(`^author:(model:([1-9]|1[0-2]):(started|succeeded|failed|heartbeat)|tool:([1-9]|1[0-9]|20):(read_draft|read_validation_report|update_draft|browser_navigate|browser_snapshot|browser_click|browser_fill|browser_login|request_validation|read_conversation_history|read_skill_reference|catalog_search|catalog_get|read_module_draft|read_usecase_draft|read_plan|propose_plan|update_module_candidate|request_module_validation|unknown):(started|succeeded|failed|heartbeat))$`)

const maxAuthorTimeoutMS = 900000

func validDispatch(d Dispatch) error {
	if d.Author != nil && !validPlatform(d.Author.Platform, d.Author, d.Script) {
		return errCapability
	}
	if err := normalizeBundle(&d); err != nil {
		return err
	}
	if d.Files != nil && d.ScriptOrigin != "manual" && d.WorkspaceID == "" {
		return errors.New("scope_confirmation_required")
	}
	if err := validWorkspaceSettings(d.WorkspaceSettings); err != nil {
		return err
	}
	if len(d.Script) > maxScriptBytes || d.TimeoutMS < 1 || d.TimeoutMS > 3600000 {
		return errors.New("dispatch script/timeout out of range")
	}
	if err := validWorkspaceOwner(d.WorkspaceID, d.TestID, d.WorkspaceContext, d.Author); err != nil {
		return err
	}
	if !validScriptOrigin(d.ScriptOrigin) {
		return errors.New("invalid scriptOrigin")
	}
	if d.WorkspaceID != "" && (d.Kind == "run" && d.ScriptOrigin != "manual" || d.Author != nil && authorWantsBrowser(d.Author)) {
		scope, err := parseWorkspaceContext(d.WorkspaceContext, d.WorkspaceID)
		if err != nil || scope == nil {
			return errors.New("scope_confirmation_required")
		}
		var config workspaceConfig
		if json.Unmarshal(scope.Config, &config) != nil || len(config.Targets) == 0 {
			return errors.New("scope_confirmation_required")
		}
	}
	if d.Kind == "run" && d.Author == nil && strings.TrimSpace(d.Script) != "" {
		return nil
	}
	if d.Kind != "author" || d.Author == nil || d.TimeoutMS > maxAuthorTimeoutMS {
		return errors.New("dispatch requires run or author with valid input")
	}
	a := d.Author
	if len(a.Batch) > 0 {
		var batch struct {
			Usecase struct {
				TestID string `json:"testId"`
			} `json:"usecase"`
		}
		var testID string
		if json.Unmarshal(a.Batch, &batch) != nil || json.Unmarshal(d.TestID, &testID) != nil || batch.Usecase.TestID != testID {
			return errCapability
		}
	}
	if a.History != nil && (!uuidPattern.MatchString(d.WorkspaceID) || !historyAuthor(a)) {
		return errors.New("invalid history owner")
	}
	if err := validAuthorMetadata(a, &d.Script); err != nil {
		return err
	}
	if v := a.Validation; v != nil {
		validStatus := false
		for _, status := range []string{"queued", "dispatched", "running", "collecting", "succeeded", "failed", "cancelling", "cancelled", "timed_out", "interrupted"} {
			validStatus = validStatus || v.Status == status
		}
		if !uuidPattern.MatchString(v.RunID) || !validStatus || utf8.RuneCountInString(v.Error) > 4000 {
			return errors.New("invalid author validation snapshot")
		}
	}
	if !uuidPattern.MatchString(a.ConversationID) || a.BaseRevision < 0 || a.BaseRevision > 9007199254740991 || a.Messages == nil || len(a.Messages) > 12 {
		return errors.New("invalid author conversation/revision/messages")
	}
	chars, hasUser := 0, false
	for _, m := range a.Messages {
		if m.Role != "user" && m.Role != "assistant" {
			return errors.New("invalid author message role")
		}
		chars += utf8.RuneCountInString(m.Content)
		hasUser = hasUser || m.Role == "user" && strings.TrimSpace(m.Content) != ""
	}
	if chars > 32000 || !hasUser && !summaryAuthor(a) {
		return errors.New("author messages exceed context bounds or lack user input")
	}
	return nil
}

func artifactAllowed(r record, name string) bool {
	if r.Kind == "author" {
		return name == "author.json"
	}
	return name == "report.html" || name == "results.json" || screenshotPattern.MatchString(name) || evidencePattern.MatchString(name)
}

// Values remain only in the docker CLI process environment. --env NAME avoids
// putting secrets in process arguments, input.json or the Manager journal.
func workerCLIEnvironment(kind string, parent []string) []string {
	filtered := make([]string, 0, len(parent))
	for _, entry := range parent {
		name, _, _ := strings.Cut(entry, "=")
		aiSetting := false
		for _, allowed := range authorEnvNames {
			aiSetting = aiSetting || name == allowed
		}
		if !aiSetting || kind == "author" {
			filtered = append(filtered, entry)
		}
	}
	return filtered
}
