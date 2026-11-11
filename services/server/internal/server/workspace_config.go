package server

import (
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type WorkspaceOrigin struct {
	Name    string `json:"name"`
	Purpose string `json:"purpose"`
	Origin  string `json:"origin"`
}
type WorkspaceRole struct {
	RoleID      *string `json:"roleId"`
	Name        string  `json:"name"`
	LoginMethod string  `json:"loginMethod"`
	LoginOrigin string  `json:"loginOrigin"`
}
type WorkspaceConfig struct {
	Name              string            `json:"name"`
	Purpose           string            `json:"purpose"`
	BackgroundSummary string            `json:"backgroundSummary"`
	Targets           []WorkspaceOrigin `json:"targets"`
	Dependencies      []WorkspaceOrigin `json:"dependencies"`
	ExcludedOrigins   []string          `json:"excludedOrigins"`
	Exclusions        string            `json:"exclusions"`
	LoginRoles        []WorkspaceRole   `json:"loginRoles"`
	DefaultTestURL    string            `json:"defaultTestUrl"`
	TimeoutMS         int               `json:"timeoutMs"`
}
type RoleRef struct {
	RoleID        string  `json:"roleId"`
	SecretRef     *string `json:"secretRef"`
	SecretVersion *int    `json:"secretVersion"`
	Configured    bool    `json:"configured"`
}
type WorkspaceContext struct {
	SchemaVersion    string           `json:"schemaVersion"`
	WorkspaceID      string           `json:"workspaceId"`
	SettingsRevision int              `json:"settingsRevision"`
	Config           *WorkspaceConfig `json:"config"`
	RoleRefs         []RoleRef        `json:"roleRefs"`
}
type WorkspaceProposal struct {
	ID                 string          `json:"id"`
	WorkspaceID        string          `json:"workspaceId"`
	ConversationID     string          `json:"conversationId"`
	SourceRunID        string          `json:"sourceRunId"`
	BaseRevision       int             `json:"baseRevision"`
	ContextRevision    int64           `json:"contextRevision"`
	Status             string          `json:"status"`
	Content            WorkspaceConfig `json:"content"`
	ScopeHash          string          `json:"scopeHash"`
	ScopeConfirmed     bool            `json:"scopeConfirmed"`
	InvalidationReason *string         `json:"invalidationReason"`
	AppliedRevision    *int            `json:"appliedRevision"`
	CreatedAt          time.Time       `json:"createdAt"`
}
type WorkspaceConversation struct {
	ID                  string    `json:"id"`
	WorkspaceID         string    `json:"workspaceId"`
	OwnerType           string    `json:"ownerType"`
	ContextRevision     int64     `json:"contextRevision"`
	ConversationSummary *string   `json:"conversationSummary"`
	Messages            []Message `json:"messages"`
	ActiveRunID         *string   `json:"activeRunId"`
}

func configError() error { return fmt.Errorf("%w: invalid Workspace configuration fields", ErrInvalid) }
func normalizedOrigin(raw string) (string, error) {
	if !validWebsiteURL(raw) {
		return "", configError()
	}
	u, err := url.Parse(raw)
	if err != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || (u.Path != "" && u.Path != "/") || strings.Contains(u.Host, "*") || strings.Contains(u.Host, "%") {
		return "", configError()
	}
	host := strings.ToLower(u.Hostname())
	for _, c := range host {
		if c > 127 {
			return "", configError()
		}
	}
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	} else {
		for _, c := range host {
			if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-') {
				return "", configError()
			}
		}
	}
	port := u.Port()
	if port != "" {
		n, _ := strconv.Atoi(port) // validWebsiteURL already checks 1..65535.
		port = strconv.Itoa(n)
	}
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	if port != "" {
		host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	return u.Scheme + "://" + host, nil
}
func configText(value string, limit int) bool {
	return utf8.ValidString(value) && len(value) <= limit && !strings.ContainsRune(value, '\x00')
}
func configName(value string) bool { return validOutputText(value, 200) }
func normalizeConfig(c WorkspaceConfig, confirm bool) (WorkspaceConfig, error) {
	c.Name = strings.TrimSpace(c.Name)
	if !configName(c.Name) || !configText(c.Purpose, 8192) || !configText(c.BackgroundSummary, 8192) || !configText(c.Exclusions, 8192) || len(c.Targets) > 20 || len(c.Dependencies) > 20 || len(c.LoginRoles) > 10 || len(c.ExcludedOrigins) > 40 || c.TimeoutMS < 1 || c.TimeoutMS > 3600000 {
		return c, configError()
	}
	if confirm && (len(c.Targets) == 0 || strings.TrimSpace(c.Purpose) == "" || strings.TrimSpace(c.BackgroundSummary) == "") {
		return c, configError()
	}
	if c.Targets == nil {
		c.Targets = []WorkspaceOrigin{}
	}
	if c.Dependencies == nil {
		c.Dependencies = []WorkspaceOrigin{}
	}
	if c.LoginRoles == nil {
		c.LoginRoles = []WorkspaceRole{}
	}
	if c.ExcludedOrigins == nil {
		c.ExcludedOrigins = []string{}
	}
	all := map[string]bool{}
	targets := map[string]bool{}
	login := map[string]bool{}
	for group, items := range [][]WorkspaceOrigin{c.Targets, c.Dependencies} {
		for i := range items {
			items[i].Name = strings.TrimSpace(items[i].Name)
			origin, err := normalizedOrigin(items[i].Origin)
			if err != nil || !configName(items[i].Name) || !configText(items[i].Purpose, 8192) || all[origin] {
				return c, configError()
			}
			if group == 1 && items[i].Purpose != "login" && items[i].Purpose != "api" && items[i].Purpose != "cdn" {
				return c, configError()
			}
			items[i].Origin = origin
			all[origin] = true
			if group == 0 {
				targets[origin] = true
				login[origin] = true
			} else if items[i].Purpose == "login" {
				login[origin] = true
			}
		}
	}
	seenExclusions := map[string]bool{}
	for i, raw := range c.ExcludedOrigins {
		origin, err := normalizedOrigin(raw)
		if err != nil || all[origin] || seenExclusions[origin] {
			return c, configError()
		}
		seenExclusions[origin] = true
		c.ExcludedOrigins[i] = origin
	}
	seenRoles := map[string]bool{}
	for i := range c.LoginRoles {
		r := &c.LoginRoles[i]
		r.Name = strings.TrimSpace(r.Name)
		origin, err := normalizedOrigin(r.LoginOrigin)
		if err != nil || !configName(r.Name) || r.LoginMethod != "form" || !login[origin] {
			return c, configError()
		}
		r.LoginOrigin = origin
		if r.RoleID != nil {
			if !ValidID(*r.RoleID) || seenRoles[*r.RoleID] {
				return c, configError()
			}
			seenRoles[*r.RoleID] = true
		}
	}
	if c.DefaultTestURL != "" {
		if !validWebsiteURL(c.DefaultTestURL) {
			return c, configError()
		}
		u, _ := url.Parse(c.DefaultTestURL)
		origin, err := normalizedOrigin(u.Scheme + "://" + u.Host)
		if err != nil || !targets[origin] {
			return c, configError()
		}
	}
	return c, nil
}
func workspaceScopeHash(c WorkspaceConfig) string {
	parts := []string{}
	for _, t := range c.Targets {
		parts = append(parts, "target:"+t.Origin)
	}
	for _, d := range c.Dependencies {
		parts = append(parts, "dependency:"+d.Purpose+":"+d.Origin)
	}
	for _, x := range c.ExcludedOrigins {
		parts = append(parts, "exclude:"+x)
	}
	for _, r := range c.LoginRoles {
		parts = append(parts, "login:"+stringValue(r.RoleID)+":"+r.LoginOrigin)
	}
	sort.Strings(parts)
	return scriptHash(strings.Join(parts, "\n"))
}
