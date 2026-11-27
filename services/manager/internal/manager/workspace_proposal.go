package manager

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf16"
)

type workspaceProposalConfig struct {
	scopes   map[string]string
	accounts map[string]map[string]bool
	aliases  []workspaceRole
}

type workspaceSiteLogin struct {
	TargetOrigin string          `json:"targetOrigin"`
	LoginMethod  *string         `json:"loginMethod"`
	EntryURL     *string         `json:"entryUrl"`
	Form         json.RawMessage `json:"form"`
	Success      json.RawMessage `json:"success"`
}

func validTestScope(scope string) bool {
	switch scope {
	case "unknown", "guest", "authenticated", "both":
		return true
	}
	return false
}

func parseWorkspaceProposalConfig(raw json.RawMessage, assigned bool) (*workspaceProposalConfig, error) {
	fields, ok := uniqueBudgetFields(raw)
	var targets, accounts []json.RawMessage
	if !ok || json.Unmarshal(fields["targets"], &targets) != nil || targets == nil || len(targets) > 20 ||
		json.Unmarshal(fields["testAccounts"], &accounts) != nil || accounts == nil || len(accounts) > 10 {
		return nil, errWorkspaceSnapshot
	}
	proposal := &workspaceProposalConfig{scopes: make(map[string]string), accounts: make(map[string]map[string]bool)}
	// Strip proposal fields before validating the v8 network scope projection.
	baseTargets := make([]map[string]json.RawMessage, 0, len(targets))
	for _, target := range targets {
		site, ok := uniqueBudgetFields(target)
		var scope, origin string
		if !ok || json.Unmarshal(site["testScope"], &scope) != nil || !validTestScope(scope) || json.Unmarshal(site["origin"], &origin) != nil {
			return nil, errWorkspaceSnapshot
		}
		normalized, ok := workspaceOrigin(origin)
		if !ok {
			return nil, errWorkspaceSnapshot
		}
		proposal.scopes[normalized] = scope
		delete(site, "testScope")
		baseTargets = append(baseTargets, site)
	}
	delete(fields, "testAccounts")
	fields["targets"], _ = json.Marshal(baseTargets)
	projected, _ := json.Marshal(fields)
	var config workspaceConfig
	if decodeWorkspaceConfig(projected, nil, &config) != nil {
		return nil, errWorkspaceSnapshot
	}
	for _, alias := range config.LoginRoles {
		if alias.RoleID == nil {
			return nil, errWorkspaceSnapshot
		}
	}
	proposal.aliases = config.LoginRoles
	loginOrigins := make(map[string]bool)
	for _, site := range config.Dependencies {
		if site.Purpose == "login" {
			origin, _ := workspaceOrigin(site.Origin)
			loginOrigins[origin] = true
		}
	}
	for _, raw := range accounts {
		var account struct {
			ID      *string           `json:"accountId"`
			Name    string            `json:"name"`
			Role    string            `json:"role"`
			Purpose *string           `json:"purpose"`
			Sites   []json.RawMessage `json:"sites"`
		}
		if !exactWorkspaceObject(raw, "accountId", "name", "role", "purpose", "sites") || json.Unmarshal(raw, &account) != nil ||
			!workspaceName(account.Name) || !workspaceName(account.Role) || account.Purpose == nil || !boundedAuthorText(*account.Purpose, 8192, false) ||
			account.Sites == nil || len(account.Sites) > len(proposal.scopes) {
			return nil, errWorkspaceSnapshot
		}
		origins := make(map[string]bool)
		for _, raw := range account.Sites {
			origin, ok := proposal.loginSite(raw, loginOrigins)
			if !ok || origins[origin] {
				return nil, errWorkspaceSnapshot
			}
			origins[origin] = true
		}
		if account.ID != nil {
			id := strings.ToLower(*account.ID)
			if !uuidPattern.MatchString(id) || proposal.accounts[id] != nil {
				return nil, errWorkspaceSnapshot
			}
			proposal.accounts[id] = origins
		} else if assigned {
			return nil, errWorkspaceSnapshot
		}
	}
	return proposal, nil
}

func (p *workspaceProposalConfig) loginSite(raw json.RawMessage, loginOrigins map[string]bool) (string, bool) {
	var site workspaceSiteLogin
	if !exactWorkspaceObject(raw, "targetOrigin", "loginMethod", "entryUrl", "form", "success") || json.Unmarshal(raw, &site) != nil {
		return "", false
	}
	target, ok := workspaceOrigin(site.TargetOrigin)
	if !ok || p.scopes[target] == "" {
		return "", false
	}
	if site.LoginMethod != nil {
		switch *site.LoginMethod {
		case "form", "sso", "mfa", "other":
		default:
			return "", false
		}
	}
	if site.EntryURL != nil {
		origin, ok := workspaceURLOrigin(*site.EntryURL)
		if !ok || (origin != target && !loginOrigins[origin]) {
			return "", false
		}
	}
	if !bytes.Equal(site.Form, []byte("null")) {
		form, ok := uniqueBudgetFields(site.Form)
		if !ok || form["usernameSelector"] == nil || form["passwordSelector"] == nil || form["submitSelector"] == nil {
			return "", false
		}
		for key, raw := range form {
			switch key {
			case "usernameSelector", "passwordSelector", "submitSelector", "loginRejectedSelector", "mfaSelector":
				var selector string
				if json.Unmarshal(raw, &selector) != nil || !workspaceSelector(selector) {
					return "", false
				}
			default:
				return "", false
			}
		}
	}
	if !bytes.Equal(site.Success, []byte("null")) {
		var success struct {
			URL      string `json:"url"`
			Selector string `json:"visibleSelector"`
		}
		if !exactWorkspaceObject(site.Success, "url", "visibleSelector") || json.Unmarshal(site.Success, &success) != nil || !workspaceSelector(success.Selector) {
			return "", false
		}
		if origin, ok := workspaceURLOrigin(success.URL); !ok || origin != target {
			return "", false
		}
	}
	return target, true
}

func workspaceSelector(value string) bool {
	return boundedAuthorText(value, 4000, true) && len(utf16.Encode([]rune(value))) <= 1000
}

func parseWorkspaceProposalSnapshot(raw json.RawMessage) (*workspaceProposalConfig, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var snapshot struct {
		Content   json.RawMessage   `json:"content"`
		Readiness []json.RawMessage `json:"siteReadiness"`
	}
	if !exactWorkspaceObject(raw, "content", "siteReadiness") || json.Unmarshal(raw, &snapshot) != nil || snapshot.Readiness == nil {
		return nil, errWorkspaceSnapshot
	}
	config, err := parseWorkspaceProposalConfig(snapshot.Content, true)
	if err != nil || len(snapshot.Readiness) != len(config.scopes) {
		return nil, errWorkspaceSnapshot
	}
	seen := make(map[string]bool)
	for _, raw := range snapshot.Readiness {
		var site struct {
			Origin   string            `json:"targetOrigin"`
			Scope    string            `json:"testScope"`
			Ready    *bool             `json:"ready"`
			Reason   *string           `json:"reason"`
			Accounts []json.RawMessage `json:"accounts"`
		}
		if !exactWorkspaceObject(raw, "targetOrigin", "testScope", "ready", "reason", "accounts") || json.Unmarshal(raw, &site) != nil ||
			site.Ready == nil || site.Accounts == nil || len(site.Accounts) > len(config.accounts) {
			return nil, errWorkspaceSnapshot
		}
		origin, ok := workspaceOrigin(site.Origin)
		if !ok || seen[origin] || site.Scope == "" || config.scopes[origin] != site.Scope {
			return nil, errWorkspaceSnapshot
		}
		seen[origin] = true
		verified, ok := config.verifiedAccountAt(origin, site.Accounts)
		if !ok {
			return nil, errWorkspaceSnapshot
		}
		reason := ""
		if site.Scope == "unknown" {
			reason = "scope_choice_required"
		} else if site.Scope != "guest" && !verified {
			reason = "login_verification_required"
		}
		if *site.Ready != (reason == "") || (reason == "" && site.Reason != nil) || (reason != "" && (site.Reason == nil || *site.Reason != reason)) {
			return nil, errWorkspaceSnapshot
		}
	}
	return config, nil
}

func (p *workspaceProposalConfig) verifiedAccountAt(origin string, entries []json.RawMessage) (bool, bool) {
	seen := make(map[string]bool)
	verified := false
	for _, raw := range entries {
		var account struct {
			ID         string  `json:"accountId"`
			State      string  `json:"state"`
			Reason     *string `json:"reason"`
			RunID      *string `json:"runId"`
			VerifiedAt *string `json:"verifiedAt"`
		}
		if !exactWorkspaceObject(raw, "accountId", "state", "reason", "runId", "verifiedAt") || json.Unmarshal(raw, &account) != nil ||
			(account.RunID != nil && !uuidPattern.MatchString(*account.RunID)) ||
			(account.Reason != nil && !validVerificationReason(*account.Reason)) {
			return false, false
		}
		id := strings.ToLower(account.ID)
		if !p.accounts[id][origin] || seen[id] {
			return false, false
		}
		seen[id] = true
		switch account.State {
		case "verified":
			verified = true
		case "pending", "running", "failed":
		default:
			return false, false
		}
	}
	return verified, true
}

func validVerificationReason(reason string) bool {
	switch reason {
	case "scope_confirmation_required", "login_setup_required", "credentials_required", "unsupported_login_method",
		"login_rejected", "mfa_required", "guest_accessible", "login_not_verified", "credential_unavailable", "invalid_evidence", "timed_out", "cancelled", "interrupted":
		return true
	}
	return false
}

func validWorkspaceProposalOutput(raw, previous json.RawMessage, context *workspaceContext) bool {
	proposal, err := parseWorkspaceProposalConfig(raw, false)
	if err != nil {
		return false
	}
	prior, err := parseWorkspaceProposalSnapshot(previous)
	if err != nil {
		return false
	}
	var base workspaceConfig
	if json.Unmarshal(context.Config, &base) != nil {
		return false
	}
	aliases := make(map[string]string)
	roles := base.LoginRoles
	if prior != nil {
		roles = append(roles, prior.aliases...)
	}
	for _, role := range roles {
		if role.RoleID != nil {
			aliases[*role.RoleID], _ = workspaceOrigin(role.LoginOrigin)
		}
	}
	for id := range proposal.accounts {
		if prior == nil || prior.accounts[id] == nil {
			return false
		}
	}
	for _, role := range proposal.aliases {
		origin, _ := workspaceOrigin(role.LoginOrigin)
		if aliases[*role.RoleID] != origin {
			return false
		}
	}
	return true
}
