package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

var ErrWorkspaceSetupIncomplete = errors.New("workspace_setup_incomplete")

type TestScope string

const (
	testScopeUnknown       TestScope = "unknown"
	testScopeGuest         TestScope = "guest"
	testScopeAuthenticated TestScope = "authenticated"
	testScopeBoth          TestScope = "both"
)

func (s *TestScope) UnmarshalJSON(data []byte) error {
	var value string
	if json.Unmarshal(data, &value) != nil {
		return configError()
	}
	switch TestScope(value) {
	case testScopeUnknown, testScopeGuest, testScopeAuthenticated, testScopeBoth:
		*s = TestScope(value)
		return nil
	default:
		return configError()
	}
}

type TestAccount struct {
	AccountID *string     `json:"accountId"`
	Name      string      `json:"name"`
	Role      string      `json:"role"`
	Purpose   string      `json:"purpose"`
	Sites     []SiteLogin `json:"sites"`
}

type SiteLogin struct {
	TargetOrigin string         `json:"targetOrigin"`
	LoginMethod  *string        `json:"loginMethod"`
	EntryURL     *string        `json:"entryUrl"`
	Form         *FormSelectors `json:"form"`
	Success      *SuccessCheck  `json:"success"`
}

type FormSelectors struct {
	UsernameSelector      string  `json:"usernameSelector"`
	PasswordSelector      string  `json:"passwordSelector"`
	SubmitSelector        string  `json:"submitSelector"`
	LoginRejectedSelector *string `json:"loginRejectedSelector,omitempty"`
	MFASelector           *string `json:"mfaSelector,omitempty"`
}

type SuccessCheck struct {
	URL             string `json:"url"`
	VisibleSelector string `json:"visibleSelector"`
}

type SiteReadiness struct {
	TargetOrigin string                    `json:"targetOrigin"`
	TestScope    TestScope                 `json:"testScope"`
	Ready        bool                      `json:"ready"`
	Reason       *string                   `json:"reason"`
	Accounts     []SiteAccountVerification `json:"accounts"`
}

type SiteAccountVerification struct {
	AccountID  string     `json:"accountId"`
	State      string     `json:"state"`
	Reason     *string    `json:"reason"`
	RunID      *string    `json:"runId"`
	VerifiedAt *time.Time `json:"verifiedAt"`
}

type AccountCredentialStatus struct {
	AccountID     string `json:"accountId"`
	Configured    bool   `json:"configured"`
	SecretVersion *int   `json:"secretVersion"`
}

type WorkspaceInterviewProposal struct {
	Content       WorkspaceConfig `json:"content"`
	SiteReadiness []SiteReadiness `json:"siteReadiness"`
}

// These defaults are also the read projection for pre-v15 JSONB rows.
func setWorkspaceTestDefaults(c *WorkspaceConfig) {
	if c == nil {
		return
	}
	for i := range c.Targets {
		if c.Targets[i].TestScope == "" {
			c.Targets[i].TestScope = testScopeUnknown
		}
	}
	if c.TestAccounts == nil {
		c.TestAccounts = []TestAccount{}
	}
}

// The configuration within a WorkspaceContext has the original v8 shape.
func workspaceScopeConfig(c *WorkspaceConfig) *WorkspaceConfig {
	if c == nil {
		return nil
	}
	scope := *c
	scope.TestAccounts = nil
	scope.Targets = slices.Clone(c.Targets)
	for i := range scope.Targets {
		scope.Targets[i].TestScope = ""
	}
	return &scope
}

func validLoginSelector(value string) bool {
	if strings.TrimSpace(value) == "" || !utf8.ValidString(value) || strings.ContainsRune(value, '\x00') {
		return false
	}
	// The Worker enforces the limit in UTF-16 code units.
	length := 0
	for _, r := range value {
		length += utf16.RuneLen(r)
		if length > 1000 {
			return false
		}
	}
	return true
}

func normalizeWorkspaceTestAccounts(c *WorkspaceConfig, targets map[string]bool) error {
	if len(c.TestAccounts) > 10 {
		return configError()
	}
	loginDependencies := make(map[string]bool)
	for _, d := range c.Dependencies {
		if d.Purpose == "login" {
			loginDependencies[d.Origin] = true
		}
	}
	seenAccounts := make(map[string]bool)
	for i := range c.TestAccounts {
		account := &c.TestAccounts[i]
		account.Name = strings.TrimSpace(account.Name)
		account.Role = strings.TrimSpace(account.Role)
		if !configName(account.Name) || !configName(account.Role) || !configText(account.Purpose, 8192) || len(account.Sites) > len(targets) {
			return configError()
		}
		if account.AccountID != nil {
			id := strings.ToLower(*account.AccountID)
			if !ValidID(id) || seenAccounts[id] {
				return configError()
			}
			seenAccounts[id] = true
			account.AccountID = &id
		}
		seenSites := make(map[string]bool)
		for j := range account.Sites {
			site := &account.Sites[j]
			origin, err := normalizedOrigin(site.TargetOrigin)
			if err != nil || !targets[origin] || seenSites[origin] {
				return configError()
			}
			site.TargetOrigin = origin
			seenSites[origin] = true
			if err := validateSiteLogin(*site, loginDependencies); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateSiteLogin(site SiteLogin, loginDependencies map[string]bool) error {
	if site.LoginMethod != nil {
		switch *site.LoginMethod {
		case "form", "sso", "mfa", "other":
		default:
			return configError()
		}
	}
	if site.EntryURL != nil {
		origin, err := workspaceURLOrigin(*site.EntryURL)
		if err != nil || origin != site.TargetOrigin && !loginDependencies[origin] {
			return configError()
		}
	}
	if form := site.Form; form != nil {
		if !validLoginSelector(form.UsernameSelector) || !validLoginSelector(form.PasswordSelector) || !validLoginSelector(form.SubmitSelector) ||
			form.LoginRejectedSelector != nil && !validLoginSelector(*form.LoginRejectedSelector) || form.MFASelector != nil && !validLoginSelector(*form.MFASelector) {
			return configError()
		}
	}
	if success := site.Success; success != nil {
		origin, err := workspaceURLOrigin(success.URL)
		if err != nil || origin != site.TargetOrigin || !validLoginSelector(success.VisibleSelector) {
			return configError()
		}
	}
	return nil
}

// Match the author validator's whitelist from the same frozen input.
func assignWorkspaceTestAccounts(c *WorkspaceConfig, previous *WorkspaceInterviewProposal, roles []RoleRef) error {
	known := make(map[string]bool)
	if previous != nil {
		for _, account := range previous.Content.TestAccounts {
			known[strings.ToLower(stringValue(account.AccountID))] = true
		}
	}
	for _, role := range roles {
		known[strings.ToLower(role.RoleID)] = true
	}
	for i := range c.TestAccounts {
		account := &c.TestAccounts[i]
		if account.AccountID == nil {
			account.AccountID = stringPointer(NewID())
		} else if !known[*account.AccountID] {
			return configError()
		}
	}
	return nil
}

func pendingSiteAccountReason(site SiteLogin, scopeConfirmed bool) string {
	if site.LoginMethod != nil && *site.LoginMethod != "form" {
		return "unsupported_login_method"
	}
	if site.LoginMethod == nil || site.EntryURL == nil || site.Form == nil || site.Success == nil {
		return "login_setup_required"
	}
	if !scopeConfirmed {
		return "scope_confirmation_required"
	}
	return "credentials_required"
}

func workspaceSiteReadiness(config *WorkspaceConfig, scopeConfirmed bool) []SiteReadiness {
	readiness := []SiteReadiness{}
	if config == nil {
		return readiness
	}
	accountsBySite := make(map[string][]SiteAccountVerification)
	for _, account := range config.TestAccounts {
		for _, site := range account.Sites {
			accountsBySite[site.TargetOrigin] = append(accountsBySite[site.TargetOrigin], SiteAccountVerification{
				AccountID: stringValue(account.AccountID), State: "pending", Reason: stringPointer(pendingSiteAccountReason(site, scopeConfirmed)),
			})
		}
	}
	for _, target := range config.Targets {
		site := SiteReadiness{TargetOrigin: target.Origin, TestScope: target.TestScope, Accounts: accountsBySite[target.Origin]}
		if site.Accounts == nil {
			site.Accounts = []SiteAccountVerification{}
		}
		switch site.TestScope {
		case testScopeGuest:
			site.Ready = true
		case testScopeAuthenticated, testScopeBoth:
			site.Reason = stringPointer("login_verification_required")
		default:
			site.TestScope = testScopeUnknown
			site.Reason = stringPointer("scope_choice_required")
		}
		readiness = append(readiness, site)
	}
	return readiness
}

// Unlike encoding/json's struct matching, these checks require exact keys and
// distinguish an omitted legacy field from null in a non-null v15 field.
func workspaceJSONFields(data []byte, allowed ...string) (map[string]json.RawMessage, bool) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return nil, false
	}
	for key := range fields {
		if !slices.Contains(allowed, key) {
			return nil, false
		}
	}
	return fields, true
}

func validWorkspaceProposalFields(data []byte) bool {
	fields, ok := workspaceJSONFields(data, "name", "purpose", "backgroundSummary", "targets", "dependencies", "excludedOrigins", "exclusions",
		"loginRoles", "testAccounts", "defaultTestUrl", "timeoutMs")
	if !ok {
		return false
	}
	if raw, exists := fields["targets"]; exists {
		var targets []json.RawMessage
		if json.Unmarshal(raw, &targets) != nil {
			return false
		}
		for _, target := range targets {
			if _, ok := workspaceJSONFields(target, "name", "purpose", "origin", "testScope"); !ok {
				return false
			}
		}
	}
	raw, exists := fields["testAccounts"]
	if !exists {
		return true
	}
	var accounts []json.RawMessage
	if json.Unmarshal(raw, &accounts) != nil || accounts == nil || len(accounts) > 10 {
		return false
	}
	for _, account := range accounts {
		fields, ok := workspaceJSONFields(account, "accountId", "name", "role", "purpose", "sites")
		if !ok || len(fields) != 5 || bytes.Equal(fields["purpose"], []byte("null")) {
			return false
		}
		var sites []json.RawMessage
		if json.Unmarshal(fields["sites"], &sites) != nil || sites == nil || len(sites) > 20 {
			return false
		}
		for _, site := range sites {
			if !validSiteLoginFields(site) {
				return false
			}
		}
	}
	return true
}

func validSiteLoginFields(data []byte) bool {
	fields, ok := workspaceJSONFields(data, "targetOrigin", "loginMethod", "entryUrl", "form", "success")
	if !ok || len(fields) != 5 {
		return false
	}
	if form := fields["form"]; !bytes.Equal(form, []byte("null")) {
		selectors, ok := workspaceJSONFields(form, "usernameSelector", "passwordSelector", "submitSelector", "loginRejectedSelector", "mfaSelector")
		if !ok || bytes.Equal(selectors["loginRejectedSelector"], []byte("null")) || bytes.Equal(selectors["mfaSelector"], []byte("null")) {
			return false
		}
	}
	return bytes.Equal(fields["success"], []byte("null")) || requiredJSONFields(fields["success"], "url", "visibleSelector")
}
