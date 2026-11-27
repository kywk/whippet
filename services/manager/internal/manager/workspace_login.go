package manager

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
	"strings"
)

const workspaceLoginVerificationKind = "workspace_login_verification"
const maxWorkspaceAccountSnapshotBytes = 16 << 20

var scopeHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type loginBinding struct {
	AccountID          string          `json:"accountId"`
	TargetOrigin       string          `json:"targetOrigin"`
	LoginConfigVersion string          `json:"loginConfigVersion"`
	EntryURL           string          `json:"entryUrl"`
	Form               json.RawMessage `json:"form"`
	Success            json.RawMessage `json:"success"`
	SecretRef          string          `json:"secretRef"`
	SecretVersion      int64           `json:"secretVersion"`
}

type loginVerification struct {
	ProposalID      string          `json:"proposalId"`
	BaseRevision    int64           `json:"baseRevision"`
	ContextRevision *int64          `json:"contextRevision"`
	ScopeHash       string          `json:"scopeHash"`
	Binding         json.RawMessage `json:"binding"`
}

type accountSite struct{ account, origin string }

func parseLoginBinding(raw json.RawMessage, config workspaceConfig) (loginBinding, bool) {
	var binding loginBinding
	if !exactWorkspaceObject(raw, "accountId", "targetOrigin", "loginConfigVersion", "entryUrl", "form", "success", "secretRef", "secretVersion") ||
		json.Unmarshal(raw, &binding) != nil || !uuidPattern.MatchString(binding.AccountID) || !uuidPattern.MatchString(binding.LoginConfigVersion) ||
		!uuidPattern.MatchString(binding.SecretRef) || binding.SecretVersion < 1 || binding.SecretVersion > 9007199254740991 {
		return loginBinding{}, false
	}
	target, ok := workspaceOrigin(binding.TargetOrigin)
	entry, entryOK := workspaceURLOrigin(binding.EntryURL)
	if !ok || !entryOK || !validWorkspaceForm(binding.Form) || !validWorkspaceSuccess(binding.Success, target) {
		return loginBinding{}, false
	}
	targetFound, entryAllowed := false, target == entry
	for _, site := range config.Targets {
		origin, _ := workspaceOrigin(site.Origin)
		targetFound = targetFound || origin == target
	}
	for _, site := range config.Dependencies {
		origin, _ := workspaceOrigin(site.Origin)
		entryAllowed = entryAllowed || site.Purpose == "login" && origin == entry
	}
	if !targetFound || !entryAllowed {
		return loginBinding{}, false
	}
	binding.TargetOrigin = target
	return binding, true
}

func parseVerificationBinding(raw json.RawMessage, context *workspaceContext) (loginBinding, bool) {
	var config workspaceConfig
	var value loginVerification
	if context == nil || context.SchemaVersion != "1" || len(context.RoleRefs) != 0 || json.Unmarshal(context.Config, &config) != nil ||
		!exactWorkspaceObject(raw, "proposalId", "baseRevision", "contextRevision", "scopeHash", "binding") || json.Unmarshal(raw, &value) != nil ||
		!uuidPattern.MatchString(value.ProposalID) || value.BaseRevision != context.SettingsRevision ||
		value.ContextRevision == nil || *value.ContextRevision < 0 || *value.ContextRevision > 9007199254740991 || !scopeHashPattern.MatchString(value.ScopeHash) {
		return loginBinding{}, false
	}
	return parseLoginBinding(value.Binding, config)
}

func dispatchVerificationValid(d Dispatch) bool {
	if !uuidPattern.MatchString(d.WorkspaceID) || !bytes.Equal(bytes.TrimSpace(d.TestID), []byte("null")) || d.ScriptOrigin != "legacy" ||
		d.Script != "" || d.Files != nil || d.Author != nil || d.ModelCredential != nil || d.ModuleABI != nil || len(d.Retest) != 0 {
		return false
	}
	snapshot, err := parseWorkspaceContext(d.WorkspaceContext, d.WorkspaceID)
	if err != nil {
		return false
	}
	_, ok := parseVerificationBinding(d.LoginVerification, snapshot)
	return ok
}

func accountDirectoryBindings(context *workspaceContext) (map[accountSite]loginBinding, bool) {
	var config workspaceConfig
	var accounts []json.RawMessage
	if json.Unmarshal(context.Config, &config) != nil || json.Unmarshal(context.TestAccounts, &accounts) != nil || accounts == nil || len(accounts) > 10 || context.AccountBindings == nil {
		return nil, false
	}
	targets := make(map[string]bool)
	for _, site := range config.Targets {
		o, _ := workspaceOrigin(site.Origin)
		targets[o] = true
	}
	verified := make(map[accountSite]bool)
	seen := make(map[string]bool)
	for _, raw := range accounts {
		var account struct {
			ID      string            `json:"accountId"`
			Name    string            `json:"name"`
			Role    string            `json:"role"`
			Purpose *string           `json:"purpose"`
			Sites   []json.RawMessage `json:"sites"`
		}
		if !exactWorkspaceObject(raw, "accountId", "name", "role", "purpose", "sites") || json.Unmarshal(raw, &account) != nil ||
			!uuidPattern.MatchString(account.ID) || !workspaceName(account.Name) || !workspaceName(account.Role) ||
			account.Purpose == nil || !boundedAuthorText(*account.Purpose, 8192, false) || account.Sites == nil || len(account.Sites) > len(targets) {
			return nil, false
		}
		id := strings.ToLower(account.ID)
		if seen[id] {
			return nil, false
		}
		seen[id] = true
		sites := make(map[string]bool)
		for _, raw := range account.Sites {
			var site struct {
				Origin string `json:"targetOrigin"`
				State  string `json:"state"`
			}
			if !exactWorkspaceObject(raw, "targetOrigin", "state") || json.Unmarshal(raw, &site) != nil {
				return nil, false
			}
			o, ok := workspaceOrigin(site.Origin)
			if !ok || !targets[o] || sites[o] {
				return nil, false
			}
			sites[o] = true
			switch site.State {
			case "verified":
				verified[accountSite{id, o}] = true
			case "pending", "running", "failed":
			default:
				return nil, false
			}
		}
	}
	if len(context.AccountBindings) > len(verified) {
		return nil, false
	}
	bindings := make(map[accountSite]loginBinding)
	for _, raw := range context.AccountBindings {
		binding, ok := parseLoginBinding(raw, config)
		key := accountSite{strings.ToLower(binding.AccountID), binding.TargetOrigin}
		if !ok || !verified[key] {
			return nil, false
		}
		delete(verified, key)
		bindings[key] = binding
	}
	return bindings, true
}

func (c *workspaceContext) accountBinding(id, target string) (loginBinding, bool) {
	if c == nil || !uuidPattern.MatchString(id) {
		return loginBinding{}, false
	}
	origin, ok := workspaceOrigin(target)
	if !ok {
		return loginBinding{}, false
	}
	binding, found := c.bindings[accountSite{strings.ToLower(id), origin}]
	return binding, found
}

func failedVerification(reason string) Result {
	raw, _ := json.Marshal(map[string]string{"reason": reason})
	return Result{Status: "failed", LoginVerification: raw}
}

func verificationFailure(reason string) bool {
	switch reason {
	case "login_rejected", "mfa_required", "guest_accessible", "login_not_verified", "credential_unavailable", "invalid_evidence":
		return true
	}
	return false
}

func validVerificationResult(result Result, binding loginBinding) bool {
	if result.Error != "" || result.TargetOrigin != "" || result.Assertion != "" || len(result.Retest) > 0 {
		return false
	}
	raw := result.LoginVerification
	switch result.Status {
	case "cancelled", "timed_out":
		return len(raw) == 0
	case "failed":
		var failure struct {
			Reason string `json:"reason"`
		}
		return exactWorkspaceObject(raw, "reason") && json.Unmarshal(raw, &failure) == nil && verificationFailure(failure.Reason)
	case "succeeded":
		var proof struct {
			Origin        string `json:"observedOrigin"`
			Guest         string `json:"guest"`
			Submitted     bool   `json:"submitted"`
			Authenticated string `json:"authenticated"`
		}
		return exactWorkspaceObject(raw, "observedOrigin", "guest", "submitted", "authenticated") && json.Unmarshal(raw, &proof) == nil &&
			proof.Origin == binding.TargetOrigin && proof.Submitted && proof.Authenticated == "selector_visible" &&
			(proof.Guest == "denied" || proof.Guest == "login_redirect" || proof.Guest == "selector_hidden")
	}
	return false
}

func collectLoginVerification(r record, taskDir string, outcome execution) Result {
	if outcome.TimedOut {
		return Result{Status: "timed_out"}
	}
	f, err := openArtifact(taskDir, "result.json")
	if err != nil {
		return failedVerification("invalid_evidence")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 4097))
	var result Result
	if err != nil || len(raw) > 4096 || json.Unmarshal(raw, &result) != nil {
		return failedVerification("invalid_evidence")
	}
	keys := []string{"status"}
	if result.Status == "succeeded" || result.Status == "failed" {
		keys = append(keys, "loginVerification")
	}
	snapshot, err := parseWorkspaceContext(r.WorkspaceContext, r.WorkspaceID)
	binding, ok := parseVerificationBinding(r.LoginVerification, snapshot)
	if err != nil || !ok || !exactWorkspaceObject(raw, keys...) || !validVerificationResult(result, binding) || outcome.Error != "" && outcome.ExitCode < 0 ||
		(result.Status == "succeeded" && (outcome.ExitCode != 0 || outcome.Error != "" || !r.CredentialsUsed)) ||
		(result.Status != "succeeded" && outcome.ExitCode != map[string]int{"failed": 1, "cancelled": 130, "timed_out": 124}[result.Status]) {
		return failedVerification("invalid_evidence")
	}
	return result
}
