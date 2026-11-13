package manager

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

func moduleAuthor(a *AuthorTask) bool {
	return a != nil && a.SkillID != nil && *a.SkillID == "module-authoring"
}
func plannerAuthor(a *AuthorTask) bool {
	return a != nil && a.SkillID != nil && *a.SkillID == "usecase-planner"
}
func platformTool(name string) bool {
	switch name {
	case "catalog_search", "catalog_get", "read_module_draft", "read_usecase_draft", "read_plan", "propose_plan", "update_module_candidate", "request_module_validation":
		return true
	}
	return false
}
func platformServerTool(name string) bool {
	return platformTool(name) && name != "update_module_candidate" && name != "request_module_validation"
}
func allowedPlatformTool(a *AuthorTask, name string) bool {
	if !moduleAuthor(a) && !plannerAuthor(a) {
		return !platformTool(name)
	}
	if name == "read_skill_reference" || name == "read_conversation_history" {
		return true
	}
	if moduleAuthor(a) {
		return name == "read_module_draft" || name == "update_module_candidate" || name == "request_module_validation" || name == "read_validation_report" || strings.HasPrefix(name, "browser_")
	}
	return name == "catalog_search" || name == "catalog_get" || name == "read_usecase_draft" || name == "read_plan" || name == "propose_plan"
}
func validModuleCandidate(script string, module json.RawMessage) bool {
	registry, e := loadToolRegistry()
	if e != nil {
		return false
	}
	raw, e := json.Marshal(struct {
		Script string          `json:"script"`
		Module json.RawMessage `json:"module"`
	}{script, module})
	if e != nil {
		return false
	}
	for _, tool := range registry.Tools {
		if tool.Name == "update_module_candidate" {
			if !validToolArguments(tool, raw) {
				return false
			}
			var m struct {
				ExportName string `json:"exportName"`
			}
			if json.Unmarshal(module, &m) != nil || !regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`).MatchString(m.ExportName) {
				return false
			}
			for _, word := range strings.Fields("await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield") {
				if word == m.ExportName {
					return false
				}
			}
			return true
		}
	}
	return false
}
func validPlatform(raw json.RawMessage, a *AuthorTask, script string) bool {
	if !moduleAuthor(a) && !plannerAuthor(a) {
		return len(raw) == 0
	}
	registry, e := validCapabilitySnapshot(a)
	if e != nil || registry == nil || !exactWorkspaceObject(raw, "planId", "stageId", "module") {
		return false
	}
	var p struct {
		PlanID  *string         `json:"planId"`
		StageID *string         `json:"stageId"`
		Module  json.RawMessage `json:"module"`
	}
	if json.Unmarshal(raw, &p) != nil || p.PlanID != nil && !uuidPattern.MatchString(*p.PlanID) {
		return false
	}
	if moduleAuthor(a) {
		return (p.PlanID == nil) == (p.StageID == nil) && (p.StageID == nil || boundedAuthorText(*p.StageID, 64, true)) && validModuleCandidate(script, p.Module)
	}
	return p.StageID == nil && bytes.Equal(bytes.TrimSpace(p.Module), []byte("null"))
}
func authorArtifactLimit(a *AuthorTask) int64 {
	if moduleAuthor(a) {
		return 25 << 20
	}
	return maxAuthorArtifactBytes
}
func validPlatformArtifact(raw json.RawMessage, a *AuthorTask) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return false
	}
	allowed := map[string]bool{"message": true, "conversationSummary": true}
	if moduleAuthor(a) {
		allowed["script"] = true
		allowed["module"] = true
		allowed["requestValidation"] = true
	} else {
		allowed["planCandidate"] = true
	}
	for k, v := range fields {
		if !allowed[k] || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return false
		}
	}
	var message string
	if json.Unmarshal(fields["message"], &message) != nil || !boundedAuthorText(message, 128000, true) || utf8.RuneCountInString(message) > 32000 {
		return false
	}
	if v, ok := fields["conversationSummary"]; ok {
		var text string
		if json.Unmarshal(v, &text) != nil || !boundedAuthorText(text, 8192, false) {
			return false
		}
	}
	if plannerAuthor(a) {
		var c struct {
			Ref string `json:"candidateRef"`
		}
		return hasAllowedTool(a, "propose_plan") && exactWorkspaceObject(fields["planCandidate"], "candidateRef") && json.Unmarshal(fields["planCandidate"], &c) == nil && uuidPattern.MatchString(c.Ref)
	}
	var script string
	var request bool
	return hasAllowedTool(a, "update_module_candidate") && json.Unmarshal(fields["script"], &script) == nil && validModuleCandidate(script, fields["module"]) && len(fields["requestValidation"]) > 0 && json.Unmarshal(fields["requestValidation"], &request) == nil && (!request || hasAllowedTool(a, "request_module_validation"))
}
