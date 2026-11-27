package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Ordered fields are the cross-language digest input. Keys/credentials are never
// part of this object. Model remains the packaged skill default; Runtime is the
// effective control-plane selection when present.
type AuthorRuntimeData struct {
	SchemaVersion       int    `json:"schemaVersion"`
	ProfileID           string `json:"profileId"`
	Engine              string `json:"engine"`
	Provider            string `json:"provider"`
	BaseURL             string `json:"baseURL"`
	Model               string `json:"model"`
	ReasoningEffort     string `json:"reasoningEffort"`
	ContextWindowTokens int    `json:"contextWindowTokens"`
	ContextInputTokens  int    `json:"contextInputTokens"`
}
type AuthorRuntime struct {
	AuthorRuntimeData
	SHA256 string `json:"sha256"`
}
type RuntimeSelection struct {
	ProfileID     string            `json:"profileId"`
	SkillProfiles map[string]string `json:"skillProfiles"`
}
type runtimeProfile struct {
	ID                  string `json:"id"`
	Engine              string `json:"engine"`
	Provider            string `json:"provider"`
	BaseURL             string `json:"baseURL"`
	Model               string `json:"model"`
	ReasoningEffort     string `json:"reasoningEffort"`
	ContextWindowTokens int    `json:"contextWindowTokens"`
	ContextInputTokens  int    `json:"contextInputTokens"`
}

func runtimeDigest(data AuthorRuntimeData) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(data)
	return scriptHash(strings.TrimSuffix(b.String(), "\n"))
}
func validRuntimeURL(value string) bool {
	if len(value) > 2048 || value == "" || strings.ContainsAny(value, "\\\"<>?#") || strings.HasSuffix(value, "/") {
		return false
	}
	for _, c := range value {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	u, err := url.Parse(value)
	return err == nil && u.Scheme == "https" && u.Hostname() != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.Opaque == "" && !strings.HasSuffix(u.Path, "/responses") && validWebsiteURL(value)
}
func validRuntimeData(r AuthorRuntimeData) bool {
	return r.SchemaVersion == 1 && moduleSlug.MatchString(r.ProfileID) && len(r.ProfileID) <= 63 &&
		(r.Engine == "builtin" || r.Engine == "vercel" || r.Engine == "pi") && (r.Provider == "opencode" || r.Provider == "openai-responses") && validRuntimeURL(r.BaseURL) &&
		modelName.MatchString(r.Model) && !strings.HasPrefix(r.Model, "opencode-go/") &&
		(r.ReasoningEffort == "low" || r.ReasoningEffort == "medium" || r.ReasoningEffort == "high" || r.ReasoningEffort == "xhigh") &&
		(r.ContextWindowTokens >= 1024 && r.ContextWindowTokens <= 2097152 || r.ContextWindowTokens == 0 && r.Engine == "builtin") &&
		r.ContextInputTokens >= 1024 && r.ContextInputTokens <= 2097152 && (r.ContextWindowTokens == 0 || r.ContextInputTokens <= r.ContextWindowTokens) &&
		!(r.Provider == "opencode" && r.Model == "muse-spark-1.3-contributor" && r.BaseURL == "https://opencode.ai/inference/go/openai/v1" && r.ContextWindowTokens > 1048576)
}
func validAuthorRuntime(r *AuthorRuntime) bool {
	return r != nil && validRuntimeData(r.AuthorRuntimeData) && r.SHA256 == runtimeDigest(r.AuthorRuntimeData)
}
func runtimeProfiles() (map[string]runtimeProfile, error) {
	out := map[string]runtimeProfile{"builtin": {ID: "builtin", Engine: "builtin"}, "vercel": {ID: "vercel", Engine: "vercel"}}
	raw := os.Getenv("WHIPPET_AI_RUNTIME_PROFILES_JSON")
	var profiles []runtimeProfile
	if raw != "" {
		if len(raw) > 65536 || strictJSONNoDuplicates([]byte(raw)) != nil {
			return nil, ErrInvalid
		}
		d := json.NewDecoder(strings.NewReader(raw))
		d.DisallowUnknownFields()
		if d.Decode(&profiles) != nil || d.Decode(new(any)) != io.EOF || profiles == nil || len(profiles) > 16 {
			return nil, ErrInvalid
		}
	}
	for _, p := range profiles {
		r := AuthorRuntimeData{1, p.ID, p.Engine, p.Provider, p.BaseURL, p.Model, p.ReasoningEffort, p.ContextWindowTokens, p.ContextInputTokens}
		if _, exists := out[p.ID]; exists || !validRuntimeData(r) || p.ContextWindowTokens == 0 {
			return nil, ErrInvalid
		}
		out[p.ID] = p
	}
	if _, exists := out["pi"]; !exists {
		out["pi"] = runtimeProfile{ID: "pi", Engine: "pi"}
	}
	return out, nil
}
func sortedRuntimeProfileIDs(profiles map[string]runtimeProfile) []string {
	ids := make([]string, 0, len(profiles))
	for id := range profiles {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
func validRuntimeSelection(s RuntimeSelection, profiles map[string]runtimeProfile) bool {
	if _, ok := profiles[s.ProfileID]; !ok || s.SkillProfiles == nil || len(s.SkillProfiles) > 5 {
		return false
	}
	for skill, id := range s.SkillProfiles {
		if skill != "test-author" && skill != "workspace-author" && skill != "acceptance-summary" && skill != "module-authoring" && skill != "usecase-planner" {
			return false
		}
		if _, ok := profiles[id]; !ok {
			return false
		}
	}
	return true
}
func resolveAuthorRuntime(input AuthorInput, selection RuntimeSelection) (*AuthorRuntime, error) {
	profiles, err := runtimeProfiles()
	if err != nil || !validRuntimeSelection(selection, profiles) || input.Model == nil {
		return nil, ErrSkillUnavailable
	}
	id := selection.ProfileID
	if override := selection.SkillProfiles[input.SkillID]; override != "" {
		id = override
	}
	p := profiles[id]
	if p.Provider == "" {
		p.Provider, p.Model, p.ReasoningEffort = input.Model.Provider, input.Model.Model, input.Model.ReasoningEffort
		p.BaseURL = strings.TrimRight(os.Getenv("WHIPPET_AI_BASE_URL"), "/")
		if p.BaseURL == "" {
			p.BaseURL = "https://opencode.ai/inference/go/openai/v1"
		}
		if p.Model == "muse-spark-1.3-contributor" && p.BaseURL == "https://opencode.ai/inference/go/openai/v1" {
			p.ContextWindowTokens = 1048576
		}
		if text, present := os.LookupEnv("WHIPPET_AI_CONTEXT_WINDOW_TOKENS"); present {
			p.ContextWindowTokens, err = strconv.Atoi(text)
			if err != nil {
				return nil, ErrSkillUnavailable
			}
		}
		p.ContextInputTokens = 256 * 1024
		if p.ContextWindowTokens > 0 && p.ContextWindowTokens < p.ContextInputTokens {
			p.ContextInputTokens = p.ContextWindowTokens
		}
		if text, present := os.LookupEnv("WHIPPET_AI_CONTEXT_INPUT_TOKENS"); present {
			p.ContextInputTokens, err = strconv.Atoi(text)
			if err != nil {
				return nil, ErrSkillUnavailable
			}
		}
	}
	r := &AuthorRuntime{AuthorRuntimeData: AuthorRuntimeData{1, id, p.Engine, p.Provider, p.BaseURL, p.Model, p.ReasoningEffort, p.ContextWindowTokens, p.ContextInputTokens}}
	if !validRuntimeData(r.AuthorRuntimeData) {
		return nil, ErrSkillUnavailable
	}
	r.SHA256 = runtimeDigest(r.AuthorRuntimeData)
	return r, nil
}

func snapshotRuntime(ctx context.Context, tx *sql.Tx, workspace string, input *AuthorInput) error {
	// A controlled continuation carries the original immutable choice. Never
	// rebuild it from the current Workspace policy or an operator's new profile.
	if input.Runtime != nil {
		if !validAuthorRuntime(input.Runtime) {
			return ErrInvalid
		}
		return nil
	}
	var raw []byte
	if err := tx.QueryRowContext(ctx, `SELECT agent_runtime FROM workspaces WHERE id=$1 FOR SHARE`, workspace).Scan(&raw); err != nil {
		return dbError(err)
	}
	var selection RuntimeSelection
	if json.Unmarshal(raw, &selection) != nil {
		return ErrInvalid
	}
	runtime, err := resolveAuthorRuntime(*input, selection)
	if err != nil {
		return err
	}
	input.Runtime = runtime
	return nil
}
func (p *Postgres) AgentRuntime(ctx context.Context, workspace string) (any, error) {
	var revision int
	var raw []byte
	if err := p.DB.QueryRowContext(ctx, `SELECT (settings->>'revision')::integer,agent_runtime FROM workspaces WHERE id=$1`, workspace).Scan(&revision, &raw); err != nil {
		return nil, dbError(err)
	}
	profiles, err := runtimeProfiles()
	if err != nil {
		return nil, err
	}
	// Public descriptors omit endpoint and all credentials. Default model/effort
	// follow the primary skill, rather than overriding its frozen package policy.
	public := []map[string]any{}
	for _, id := range sortedRuntimeProfileIDs(profiles) {
		profile := profiles[id]
		public = append(public, map[string]any{"id": id, "engine": profile.Engine, "provider": profile.Provider, "model": profile.Model, "reasoningEffort": profile.ReasoningEffort})
	}
	return map[string]any{"workspaceId": workspace, "revision": revision, "selection": json.RawMessage(raw), "profiles": public}, nil
}
func (p *Postgres) SetAgentRuntime(ctx context.Context, workspace string, revision int, selection RuntimeSelection) (any, error) {
	profiles, err := runtimeProfiles()
	if !ValidID(workspace) || revision < 1 || err != nil || !validRuntimeSelection(selection, profiles) {
		return nil, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	w, currentProposal, err := readWorkspaceCore(ctx, tx, workspace, true)
	if err != nil {
		return nil, err
	}
	if err := w.Management.State.workError(); err != nil {
		return nil, err
	}
	if err = checkRevision(revision, w.Revision); err != nil {
		return nil, err
	}
	var prior []byte
	if err = tx.QueryRowContext(ctx, `SELECT agent_runtime FROM workspaces WHERE id=$1`, workspace).Scan(&prior); err != nil {
		return nil, err
	}
	var previous RuntimeSelection
	if json.Unmarshal(prior, &previous) != nil {
		return nil, ErrInvalid
	}
	if jsonText(previous) != jsonText(selection) {
		if _, err = tx.ExecContext(ctx, `UPDATE workspaces SET agent_runtime=$2,settings=jsonb_set(settings,'{revision}',to_jsonb($3::integer)) WHERE id=$1`, workspace, jsonText(selection), revision+1); err != nil {
			return nil, err
		}
		if err := invalidateWorkspaceLoginProposal(ctx, tx, workspace, currentProposal); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return p.AgentRuntime(ctx, workspace)
}
func (a *API) agentRuntime(w http.ResponseWriter, r *http.Request) {
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrConflict)
		return
	}
	if r.Method == http.MethodGet {
		item, err := p.AgentRuntime(r.Context(), id)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, 200, item)
		return
	}
	var body struct {
		Revision int `json:"revision"`
		RuntimeSelection
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil || strictJSONNoDuplicates(raw) != nil || !requiredJSONFields(raw, "revision", "profileId", "skillProfiles") {
		a.fail(w, ErrInvalid)
		return
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil || d.Decode(new(any)) != io.EOF {
		a.fail(w, ErrInvalid)
		return
	}
	item, err := p.SetAgentRuntime(r.Context(), id, body.Revision, body.RuntimeSelection)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, 200, item)
}
