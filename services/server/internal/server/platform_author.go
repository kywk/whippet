package server

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"unicode/utf8"
)

type AuthorPlatform struct {
	PlanID  *string `json:"planId"`
	StageID *string `json:"stageId"`
	Module  *Module `json:"module"`
}

type moduleAuthorOutput struct {
	Message             *string `json:"message"`
	Script              *string `json:"script"`
	Module              *Module `json:"module"`
	RequestValidation   *bool   `json:"requestValidation"`
	ConversationSummary *string `json:"conversationSummary,omitempty"`
}
type plannerAuthorOutput struct {
	Message       *string `json:"message"`
	PlanCandidate *struct {
		CandidateRef string `json:"candidateRef"`
	} `json:"planCandidate"`
	ConversationSummary *string `json:"conversationSummary,omitempty"`
}

func decodePlatformFinal(data []byte, limit int64, out any) error {
	if int64(len(data)) > limit || !utf8.Valid(data) {
		return ErrInvalid
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if dec.Decode(out) != nil || dec.Decode(new(any)) != io.EOF {
		return ErrInvalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return ErrInvalid
	}
	for _, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return ErrInvalid
		}
	}
	return nil
}
func validAuthorText(message, summary *string) bool {
	return message != nil && validateUserMessage(*message) == nil && !strings.ContainsRune(*message, 0) && (summary == nil || (len(*summary) <= 8192 && utf8.ValidString(*summary) && !strings.ContainsRune(*summary, 0)))
}
func decodeModuleAuthorOutput(data []byte, input AuthorInput, registry *ToolRegistry) (moduleAuthorOutput, error) {
	var out moduleAuthorOutput
	if input.SkillID != "module-authoring" || input.Platform == nil || input.Platform.Module == nil || decodePlatformFinal(data, MaxModuleAuthorArtifactBytes, &out) != nil || out.Script == nil || out.Module == nil || out.RequestValidation == nil || !validAuthorText(out.Message, out.ConversationSummary) {
		return out, ErrInvalid
	}
	if validateToolSnapshot(input, registry, "update_module_candidate") != nil && validateToolSnapshot(input, registry, "commit_module_candidate") != nil {
		return out, ErrInvalid
	}
	if *out.RequestValidation && validateToolSnapshot(input, registry, "request_module_validation") != nil {
		return out, ErrInvalid
	}
	tool, ok := registry.tool("update_module_candidate")
	if !ok {
		return out, ErrInvalid
	}
	raw, err := json.Marshal(struct {
		Script string  `json:"script"`
		Module *Module `json:"module"`
	}{*out.Script, out.Module})
	if err != nil {
		return out, ErrInvalid
	}
	if _, err = validateToolArguments(tool, raw); err != nil {
		return out, err
	}
	if strings.TrimSpace(*out.Script) == "" || strings.ContainsRune(*out.Script, 0) || validateModule(out.Module, input.Platform.Module.Slug) != nil {
		return out, ErrInvalid
	}
	return out, nil
}
func decodePlannerAuthorOutput(data []byte, input AuthorInput, registry *ToolRegistry) (plannerAuthorOutput, error) {
	var out plannerAuthorOutput
	if input.SkillID != "usecase-planner" || input.Platform == nil || input.Platform.Module != nil || input.Platform.StageID != nil || decodePlatformFinal(data, MaxAuthorArtifactBytes, &out) != nil || !validAuthorText(out.Message, out.ConversationSummary) || out.PlanCandidate == nil || !ValidID(out.PlanCandidate.CandidateRef) || validateToolSnapshot(input, registry, "propose_plan") != nil {
		return out, ErrInvalid
	}
	// Ownership and last-successful-candidate checks require the completion transaction.
	return out, nil
}
func validateAuthorPlatform(input AuthorInput, kind string) error {
	p := input.Platform
	switch input.SkillID {
	case "module-authoring":
		if kind != "module" || p == nil || p.Module == nil || (p.PlanID == nil) != (p.StageID == nil) || !moduleSlug.MatchString(p.Module.Slug) || !validExportName(p.Module.ExportName) {
			return ErrInvalid
		}
		if p.PlanID != nil && (!ValidID(*p.PlanID) || strings.TrimSpace(*p.StageID) == "") {
			return ErrInvalid
		}
		if p.Module.ModuleKind != "setup" && p.Module.ModuleKind != "step" && p.Module.ModuleKind != "page" {
			return ErrInvalid
		}
	case "usecase-planner":
		if kind != "usecase" || p == nil || p.Module != nil || p.StageID != nil || (p.PlanID != nil && !ValidID(*p.PlanID)) {
			return ErrInvalid
		}
	default:
		if p != nil {
			return ErrInvalid
		}
	}
	return nil
}
