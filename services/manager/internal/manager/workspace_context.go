package manager

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// These are nonsecret snapshots, never network permission or credentials.
type workspaceContext struct {
	SchemaVersion    string             `json:"schemaVersion"`
	WorkspaceID      string             `json:"workspaceId"`
	SettingsRevision int64              `json:"settingsRevision"`
	Config           json.RawMessage    `json:"config"`
	RoleRefs         []workspaceRoleRef `json:"roleRefs"`
}
type workspaceRoleRef struct {
	RoleID        string  `json:"roleId"`
	SecretRef     *string `json:"secretRef"`
	SecretVersion *int64  `json:"secretVersion"`
	Configured    bool    `json:"configured"`
}
type workspaceSite struct {
	Name    string `json:"name"`
	Purpose string `json:"purpose"`
	Origin  string `json:"origin"`
}
type workspaceRole struct {
	RoleID      *string `json:"roleId"`
	Name        string  `json:"name"`
	LoginMethod string  `json:"loginMethod"`
	LoginOrigin string  `json:"loginOrigin"`
}
type workspaceConfig struct {
	Name              string          `json:"name"`
	Purpose           string          `json:"purpose"`
	BackgroundSummary string          `json:"backgroundSummary"`
	Targets           []workspaceSite `json:"targets"`
	Dependencies      []workspaceSite `json:"dependencies"`
	ExcludedOrigins   []string        `json:"excludedOrigins"`
	Exclusions        string          `json:"exclusions"`
	LoginRoles        []workspaceRole `json:"loginRoles"`
	DefaultTestURL    string          `json:"defaultTestUrl"`
	TimeoutMS         int64           `json:"timeoutMs"`
}

var errWorkspaceSnapshot = errors.New("invalid nonsecret Workspace snapshot")
var dnsLabel = regexp.MustCompile(`(?i)^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

func exactWorkspaceObject(raw json.RawMessage, names ...string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != len(names) {
		return false
	}
	for _, name := range names {
		if _, ok := fields[name]; !ok {
			return false
		}
	}
	return true
}

func workspaceName(value string) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && boundedAuthorText(strings.TrimSpace(value), 200, true)
}

func workspaceOrigin(value string) (string, bool) {
	if !boundedAuthorText(value, 2048, true) || strings.IndexFunc(value, func(r rune) bool { return r < 33 || r > 126 }) >= 0 || strings.ContainsAny(value, "?#*\\") {
		return "", false
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Host == "" || u.Opaque != "" || u.Path != "" && u.Path != "/" || u.RawPath != "" || strings.HasSuffix(u.Host, ":") {
		return "", false
	}
	host := strings.ToLower(u.Hostname())
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	} else {
		for _, label := range strings.Split(host, ".") {
			if !dnsLabel.MatchString(label) {
				return "", false
			}
		}
	}
	port := u.Port()
	if port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return "", false
		}
		port = strconv.Itoa(n)
	}
	if u.Scheme == "http" && port == "80" || u.Scheme == "https" && port == "443" {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return u.Scheme + "://" + host, true
}

func validWorkspaceConfig(raw json.RawMessage, knownRoles map[string]bool) error {
	if !exactWorkspaceObject(raw, "name", "purpose", "backgroundSummary", "targets", "dependencies", "excludedOrigins", "exclusions", "loginRoles", "defaultTestUrl", "timeoutMs") {
		return errWorkspaceSnapshot
	}
	var c workspaceConfig
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || !workspaceName(c.Name) || !boundedAuthorText(c.Purpose, 8192, false) || !boundedAuthorText(c.BackgroundSummary, 8192, false) || !boundedAuthorText(c.Exclusions, 8192, false) ||
		c.TimeoutMS < 1 || c.TimeoutMS > 3600000 || c.Targets == nil || len(c.Targets) > 20 || c.Dependencies == nil || len(c.Dependencies) > 20 || c.ExcludedOrigins == nil || len(c.ExcludedOrigins) > 40 || c.LoginRoles == nil || len(c.LoginRoles) > 10 {
		return errWorkspaceSnapshot
	}
	// JSON null must not silently become a zero-value scalar or a missing role ID.
	var fields map[string]json.RawMessage
	json.Unmarshal(raw, &fields)
	for _, key := range []string{"name", "purpose", "backgroundSummary", "exclusions", "defaultTestUrl", "timeoutMs"} {
		if bytes.Equal(fields[key], []byte("null")) {
			return errWorkspaceSnapshot
		}
	}
	targets, deps, login := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, key := range []string{"targets", "dependencies"} {
		var entries []json.RawMessage
		json.Unmarshal(fields[key], &entries)
		for _, entry := range entries {
			if !exactWorkspaceObject(entry, "name", "purpose", "origin") {
				return errWorkspaceSnapshot
			}
			var s workspaceSite
			if json.Unmarshal(entry, &s) != nil || !workspaceName(s.Name) || !boundedAuthorText(s.Purpose, 8192, false) {
				return errWorkspaceSnapshot
			}
			var sf map[string]json.RawMessage
			json.Unmarshal(entry, &sf)
			if bytes.Equal(sf["purpose"], []byte("null")) {
				return errWorkspaceSnapshot
			}
			o, ok := workspaceOrigin(s.Origin)
			if !ok || targets[o] || deps[o] {
				return errWorkspaceSnapshot
			}
			if key == "targets" {
				targets[o] = true
			} else {
				if s.Purpose != "login" && s.Purpose != "api" && s.Purpose != "cdn" {
					return errWorkspaceSnapshot
				}
				deps[o] = true
				login[o] = s.Purpose == "login"
			}
		}
	}
	exclusions := map[string]bool{}
	for _, excluded := range c.ExcludedOrigins {
		o, ok := workspaceOrigin(excluded)
		if !ok || targets[o] || deps[o] || exclusions[o] {
			return errWorkspaceSnapshot
		}
		exclusions[o] = true
	}
	var roles []json.RawMessage
	json.Unmarshal(fields["loginRoles"], &roles)
	seen := map[string]bool{}
	for i, role := range c.LoginRoles {
		if !exactWorkspaceObject(roles[i], "roleId", "name", "loginMethod", "loginOrigin") || !workspaceName(role.Name) || role.LoginMethod != "form" {
			return errWorkspaceSnapshot
		}
		if role.RoleID != nil {
			if !uuidPattern.MatchString(*role.RoleID) || seen[*role.RoleID] || knownRoles != nil && !knownRoles[*role.RoleID] {
				return errWorkspaceSnapshot
			}
			seen[*role.RoleID] = true
		}
		o, ok := workspaceOrigin(role.LoginOrigin)
		if !ok || (!targets[o] && !login[o]) {
			return errWorkspaceSnapshot
		}
	}
	if !utf8.ValidString(c.DefaultTestURL) || utf8.RuneCountInString(c.DefaultTestURL) > 2048 || strings.IndexFunc(c.DefaultTestURL, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == '\\' }) >= 0 {
		return errWorkspaceSnapshot
	}
	if c.DefaultTestURL != "" {
		u, err := url.Parse(c.DefaultTestURL)
		if err != nil || u.User != nil {
			return errWorkspaceSnapshot
		}
		o, ok := workspaceOrigin(u.Scheme + "://" + u.Host)
		if !ok || !targets[o] {
			return errWorkspaceSnapshot
		}
	}
	return nil
}

func parseWorkspaceContext(raw json.RawMessage, workspaceID string) (*workspaceContext, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	if len(raw) > 1<<20 || !exactWorkspaceObject(raw, "schemaVersion", "workspaceId", "settingsRevision", "config", "roleRefs") {
		return nil, errWorkspaceSnapshot
	}
	var c workspaceContext
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&c) != nil || c.SchemaVersion != "1" || !uuidPattern.MatchString(c.WorkspaceID) || workspaceID != "" && c.WorkspaceID != workspaceID || c.SettingsRevision < 1 || c.SettingsRevision > 9007199254740991 || c.RoleRefs == nil || len(c.RoleRefs) > 10 {
		return nil, errWorkspaceSnapshot
	}
	var fields map[string]json.RawMessage
	json.Unmarshal(raw, &fields)
	var refs []json.RawMessage
	json.Unmarshal(fields["roleRefs"], &refs)
	seen := map[string]bool{}
	for i, ref := range c.RoleRefs {
		if !exactWorkspaceObject(refs[i], "roleId", "secretRef", "secretVersion", "configured") || !uuidPattern.MatchString(ref.RoleID) || seen[ref.RoleID] || ref.SecretRef != nil && !uuidPattern.MatchString(*ref.SecretRef) || ref.SecretVersion != nil && (*ref.SecretVersion < 1 || *ref.SecretVersion > 9007199254740991) || ref.Configured && (ref.SecretRef == nil || ref.SecretVersion == nil) {
			return nil, errWorkspaceSnapshot
		}
		var rf map[string]json.RawMessage
		json.Unmarshal(refs[i], &rf)
		if bytes.Equal(rf["configured"], []byte("null")) {
			return nil, errWorkspaceSnapshot
		}
		seen[ref.RoleID] = true
	}
	if !bytes.Equal(bytes.TrimSpace(c.Config), []byte("null")) && validWorkspaceConfig(c.Config, nil) != nil {
		return nil, errWorkspaceSnapshot
	}
	return &c, nil
}

func validWorkspaceOwner(workspaceID string, testID, raw json.RawMessage, a *AuthorTask) error {
	if workspaceID != "" && !uuidPattern.MatchString(workspaceID) {
		return errWorkspaceSnapshot
	}
	if workspaceID != "" && len(testID) == 0 || workspaceID == "" && len(testID) > 0 {
		return errWorkspaceSnapshot
	}
	if len(testID) > 0 && !bytes.Equal(bytes.TrimSpace(testID), []byte("null")) {
		var id string
		if json.Unmarshal(testID, &id) != nil || !uuidPattern.MatchString(id) {
			return errWorkspaceSnapshot
		}
	}
	c, err := parseWorkspaceContext(raw, workspaceID)
	if err != nil || c != nil && workspaceID == "" {
		return errWorkspaceSnapshot
	}
	if workspaceAuthor(a) {
		if workspaceID == "" || !bytes.Equal(bytes.TrimSpace(testID), []byte("null")) || c == nil || c.SettingsRevision != a.BaseRevision {
			return errWorkspaceSnapshot
		}
	} else if bytes.Equal(bytes.TrimSpace(testID), []byte("null")) {
		return errWorkspaceSnapshot
	}
	return nil
}

func authorCanEditWithoutExecution(a *AuthorTask) bool {
	if a.AllowedTools == nil {
		return false
	}
	for _, tool := range *a.AllowedTools {
		if tool != "read_draft" && tool != "read_validation_report" && tool != "update_draft" {
			return false
		}
	}
	return true
}

func validScriptOrigin(value string) bool {
	return value == "" || value == "ai" || value == "manual" || value == "legacy"
}
func authorWantsBrowser(a *AuthorTask) bool {
	if a == nil || summaryAuthor(a) {
		return false
	}
	if a.AllowedTools == nil {
		return true
	}
	for _, tool := range *a.AllowedTools {
		if strings.HasPrefix(tool, "browser_") {
			return true
		}
	}
	return false
}

func normalizedScriptOrigin(value string) string {
	if value == "" {
		return "legacy"
	}
	return value
}
