package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Field order matches Server/Worker v12 digest input. Runtime contains no keys.
type runtimeData struct {
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
type runtimeSnapshot struct {
	runtimeData
	SHA256 string `json:"sha256"`
}

var runtimeModel = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_./:-]{0,127}$`)

func validRuntimeSnapshot(raw json.RawMessage) bool {
	fields, ok := uniqueBudgetFields(raw)
	if !ok || len(fields) != 10 {
		return false
	}
	for _, name := range []string{"schemaVersion", "profileId", "engine", "provider", "baseURL", "model", "reasoningEffort", "contextWindowTokens", "contextInputTokens", "sha256"} {
		value, found := fields[name]
		if !found || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return false
		}
	}
	var r runtimeSnapshot
	if json.Unmarshal(raw, &r) != nil {
		return false
	}
	u, err := url.Parse(r.BaseURL)
	if err != nil || len(r.BaseURL) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || strings.ContainsAny(r.BaseURL, "\\\"<>?#") || strings.HasSuffix(r.BaseURL, "/") || strings.HasSuffix(u.Path, "/responses") {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return false
	}
	for _, c := range r.BaseURL {
		if c < 0x21 || c > 0x7e {
			return false
		}
	}
	if r.SchemaVersion != 1 || !capabilityID.MatchString(r.ProfileID) || len(r.ProfileID) > 63 || r.Engine != "builtin" && r.Engine != "vercel" && r.Engine != "pi" || r.Provider != "opencode" && r.Provider != "openai-responses" ||
		!runtimeModel.MatchString(r.Model) || strings.HasPrefix(r.Model, "opencode-go/") || r.ReasoningEffort != "low" && r.ReasoningEffort != "medium" && r.ReasoningEffort != "high" && r.ReasoningEffort != "xhigh" ||
		!(r.ContextWindowTokens >= 1024 && r.ContextWindowTokens <= 2097152 || r.ContextWindowTokens == 0 && r.Engine == "builtin") || r.ContextInputTokens < 1024 || r.ContextInputTokens > 2097152 || r.ContextWindowTokens > 0 && r.ContextInputTokens > r.ContextWindowTokens ||
		r.Provider == "opencode" && r.Model == "muse-spark-1.3-contributor" && r.BaseURL == "https://opencode.ai/inference/go/openai/v1" && r.ContextWindowTokens > 1048576 {
		return false
	}
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if e.Encode(r.runtimeData) != nil {
		return false
	}
	return r.SHA256 == fmt.Sprintf("%x", sha256.Sum256(bytes.TrimSuffix(b.Bytes(), []byte("\n"))))
}
