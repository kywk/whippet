package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode/utf8"
)

var authorToolNames = []string{"read_draft", "read_validation_report", "update_draft", "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login", "request_validation", "read_conversation_history"}

func summaryAuthor(a *AuthorTask) bool {
	return a != nil && a.SkillID != nil && *a.SkillID == "acceptance-summary"
}

func workspaceAuthor(a *AuthorTask) bool {
	return a != nil && a.SkillID != nil && *a.SkillID == "workspace-author"
}

func validAuthorMetadata(a *AuthorTask, script *string) error {
	if a == nil {
		return errors.New("missing author snapshot")
	}
	modern := a.SkillID != nil || a.SkillVersion != nil || a.AllowedTools != nil || a.EditingSessionID != nil || a.ContextRevision != nil || len(a.SourceVersion) > 0 || len(a.ConversationSummary) > 0 || a.ValidationEvidence != nil
	if !modern {
		return nil
	}
	if a.History != nil {
		if _, ok := historySequence(a.History.MaxSequence); !ok || !historyAuthor(a) {
			return errors.New("invalid history pin")
		}
	}
	if a.AllowedTools != nil {
		for _, tool := range *a.AllowedTools {
			if tool == "read_conversation_history" && a.History == nil {
				return errors.New("missing history pin")
			}
		}
	}
	invalid := errors.New("invalid M7 author snapshot")
	if a.SkillID == nil || (*a.SkillID != "test-author" && *a.SkillID != "acceptance-summary" && !workspaceAuthor(a)) || a.SkillVersion == nil || *a.SkillVersion != "1" || a.AllowedTools == nil ||
		(!workspaceAuthor(a) && (a.EditingSessionID == nil || !uuidPattern.MatchString(*a.EditingSessionID))) || a.ContextRevision == nil || *a.ContextRevision < 0 || *a.ContextRevision > 9007199254740991 || a.BaseRevision < 1 || len(a.SourceVersion) == 0 || len(a.ConversationSummary) == 0 {
		return invalid
	}
	var source *struct {
		ID                string  `json:"id"`
		Description       *string `json:"description"`
		BackgroundSummary *string `json:"backgroundSummary"`
	}
	d := json.NewDecoder(bytes.NewReader(a.SourceVersion))
	d.DisallowUnknownFields()
	if d.Decode(&source) != nil {
		return invalid
	}
	if source != nil && (!uuidPattern.MatchString(source.ID) || source.Description != nil && !boundedAuthorText(*source.Description, 16384, false) || source.BackgroundSummary != nil && !boundedAuthorText(*source.BackgroundSummary, 8192, false)) {
		return invalid
	}
	if source != nil {
		var fields map[string]json.RawMessage
		if json.Unmarshal(a.SourceVersion, &fields) != nil || len(fields) != 3 {
			return invalid
		}
	}
	if workspaceAuthor(a) && (a.EditingSessionID != nil || source != nil || a.Validation != nil || a.ValidationEvidence != nil || script != nil && *script != "") {
		return invalid
	}
	if workspaceAuthor(a) {
		for _, tool := range *a.AllowedTools {
			if !strings.HasPrefix(tool, "browser_") && tool != "read_conversation_history" {
				return invalid
			}
		}
	}
	var conversation *string
	if json.Unmarshal(a.ConversationSummary, &conversation) != nil || conversation != nil && !boundedAuthorText(*conversation, 8192, false) {
		return invalid
	}
	seen := map[string]bool{}
	for _, name := range *a.AllowedTools {
		known := false
		for _, allowed := range authorToolNames {
			known = known || name == allowed
		}
		if !known || seen[name] {
			return invalid
		}
		seen[name] = true
	}
	if summaryAuthor(a) {
		e := a.ValidationEvidence
		if len(*a.AllowedTools) != 0 || e == nil || !uuidPattern.MatchString(e.RunID) || !uuidPattern.MatchString(e.AttemptID) || e.DraftRevision != a.BaseRevision ||
			e.Status != "succeeded" || !e.ReportsReady || e.TimeoutMS < 1 || e.TimeoutMS > 3600000 || len(e.ScriptHash) != 64 || strings.IndexFunc(e.ScriptHash, func(r rune) bool { return !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') }) >= 0 ||
			e.Stats.Expected < 1 || e.Stats.Unexpected != 0 || e.Stats.Flaky < 0 || e.Stats.Skipped < 0 || e.Stats.Duration < 0 || math.IsNaN(e.Stats.Duration) || math.IsInf(e.Stats.Duration, 0) {
			return invalid
		}
		if script != nil && (strings.TrimSpace(*script) == "" || e.ScriptHash != fmt.Sprintf("%x", sha256.Sum256([]byte(*script)))) {
			return invalid
		}
	} else if a.ValidationEvidence != nil {
		return invalid
	}
	return nil
}

func boundedAuthorText(value string, limit int, nonempty bool) bool {
	return utf8.ValidString(value) && len(value) <= limit && !strings.ContainsRune(value, '\x00') && (!nonempty || strings.TrimSpace(value) != "")
}

func validAuthorArtifact(taskDir string, a *AuthorTask, context json.RawMessage) bool {
	var raw json.RawMessage
	if readOutput(taskDir, "author.json", &raw) != nil {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if workspaceAuthor(a) {
		var out struct {
			Message             *string         `json:"message"`
			Proposal            json.RawMessage `json:"proposal,omitempty"`
			ConversationSummary *string         `json:"conversationSummary,omitempty"`
		}
		if decoder.Decode(&out) != nil || out.Message == nil || !boundedAuthorText(*out.Message, 128000, true) || utf8.RuneCountInString(*out.Message) > 32000 ||
			out.ConversationSummary != nil && !boundedAuthorText(*out.ConversationSummary, 8192, false) {
			return false
		}
		// Explicit null is not a valid optional string/config in author output.
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			return false
		}
		if value, ok := fields["conversationSummary"]; ok && bytes.Equal(value, []byte("null")) {
			return false
		}
		if len(out.Proposal) == 0 {
			return true
		}
		snapshot, err := parseWorkspaceContext(context, "")
		if err != nil || snapshot == nil {
			return false
		}
		roles := map[string]bool{}
		for _, role := range snapshot.RoleRefs {
			roles[role.RoleID] = true
		}
		return validWorkspaceConfig(out.Proposal, roles) == nil
	}
	if summaryAuthor(a) {
		var out struct {
			Message           *string `json:"message"`
			Description       *string `json:"description"`
			BackgroundSummary *string `json:"backgroundSummary"`
			Name              *string `json:"name,omitempty"`
		}
		return decoder.Decode(&out) == nil && out.Message != nil && boundedAuthorText(*out.Message, 128000, true) && utf8.RuneCountInString(*out.Message) <= 32000 &&
			out.Description != nil && boundedAuthorText(*out.Description, 16384, true) && out.BackgroundSummary != nil && boundedAuthorText(*out.BackgroundSummary, 8192, true) &&
			(out.Name == nil || boundedAuthorText(*out.Name, 200, true))
	}
	var out struct {
		Message             *string `json:"message"`
		Script              *string `json:"script,omitempty"`
		RequestValidation   *bool   `json:"requestValidation"`
		ConversationSummary *string `json:"conversationSummary,omitempty"`
	}
	return decoder.Decode(&out) == nil && out.Message != nil && boundedAuthorText(*out.Message, 128000, true) && utf8.RuneCountInString(*out.Message) <= 32000 && out.RequestValidation != nil &&
		(out.Script == nil || boundedAuthorText(*out.Script, maxScriptBytes, false)) && (out.ConversationSummary == nil || boundedAuthorText(*out.ConversationSummary, 8192, false))
}
