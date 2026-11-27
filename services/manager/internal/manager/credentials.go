package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const credentialFrameLimit = 64 << 10

type credentialRequest struct {
	Kind          string `json:"kind"`
	RequestID     string `json:"requestId"`
	AttemptID     string `json:"attemptId"`
	RoleID        string `json:"roleId,omitempty"`
	AccountID     string `json:"accountId,omitempty"`
	TargetOrigin  string `json:"targetOrigin,omitempty"`
	SecretRef     string `json:"secretRef"`
	SecretVersion int64  `json:"secretVersion"`
}
type credentialValues struct {
	WorkspaceID   string `json:"workspaceId"`
	RunID         string `json:"runId"`
	AttemptID     string `json:"attemptId"`
	RoleID        string `json:"roleId,omitempty"`
	AccountID     string `json:"accountId,omitempty"`
	TargetOrigin  string `json:"targetOrigin,omitempty"`
	SecretRef     string `json:"secretRef"`
	SecretVersion int64  `json:"secretVersion"`
	LoginOrigin   string `json:"loginOrigin"`
	Username      string `json:"username"`
	Password      string `json:"password"`
}
type credentialReply struct {
	Kind        string            `json:"kind"`
	RequestID   string            `json:"requestId"`
	AttemptID   string            `json:"attemptId"`
	Credentials *credentialValues `json:"credentials,omitempty"`
	Error       string            `json:"error,omitempty"`
}

var errCredentials = errors.New("credential_operation_failed")

func resolveCredentials(ctx context.Context, cfg Config, r record, q credentialRequest, client *http.Client) (credentialValues, error) {
	var values credentialValues
	if !strings.HasPrefix(cfg.ServerURL, "https://") || !uuidPattern.MatchString(q.RequestID) || q.AttemptID != r.AttemptID {
		return values, errCredentials
	}
	snapshot, err := parseWorkspaceContext(r.WorkspaceContext, r.WorkspaceID)
	if err != nil || snapshot == nil {
		return values, errCredentials
	}
	body := map[string]any{"secretRef": q.SecretRef, "secretVersion": q.SecretVersion}
	fields := []string{"workspaceId", "runId", "attemptId", "secretRef", "secretVersion", "loginOrigin", "username", "password"}
	var loginOrigin string
	if q.AccountID != "" {
		var binding loginBinding
		var ok bool
		if r.Kind == workspaceLoginVerificationKind {
			binding, ok = parseVerificationBinding(r.LoginVerification, snapshot)
		} else {
			binding, ok = snapshot.accountBinding(q.AccountID, q.TargetOrigin)
		}
		if !ok || q.RoleID != "" || q.AccountID != binding.AccountID || q.TargetOrigin != binding.TargetOrigin ||
			q.SecretRef != binding.SecretRef || q.SecretVersion != binding.SecretVersion {
			return values, errCredentials
		}
		loginOrigin, _ = workspaceURLOrigin(binding.EntryURL)
		body["accountId"], body["targetOrigin"] = q.AccountID, q.TargetOrigin
		fields = append(fields, "accountId", "targetOrigin")
	} else {
		ref, origin, ok := snapshot.configuredRole(q.RoleID)
		if !ok || r.Kind == workspaceLoginVerificationKind || q.TargetOrigin != "" || *ref.SecretRef != q.SecretRef || *ref.SecretVersion != q.SecretVersion {
			return values, errCredentials
		}
		loginOrigin = origin
		body["roleId"] = q.RoleID
		fields = append(fields, "roleId")
	}
	path := "/api/manager/runs/" + r.RunID + "/attempts/" + r.AttemptID + "/credentials/resolve"
	raw, err := fetchCredentialJSON(ctx, cfg, path, body, client)
	if err != nil || !exactWorkspaceObject(raw, fields...) || json.Unmarshal(raw, &values) != nil {
		return credentialValues{}, errCredentials
	}
	actual, ok := workspaceOrigin(values.LoginOrigin)
	if !ok || loginOrigin != actual || values.WorkspaceID != r.WorkspaceID || values.RunID != r.RunID || values.AttemptID != r.AttemptID ||
		values.RoleID != q.RoleID || values.AccountID != q.AccountID || values.TargetOrigin != q.TargetOrigin || values.SecretRef != q.SecretRef ||
		values.SecretVersion != q.SecretVersion || !boundedAuthorText(values.Username, 4096, true) || !boundedAuthorText(values.Password, 4096, true) {
		return credentialValues{}, errCredentials
	}
	return values, nil
}

func (c *workspaceContext) configuredRole(id string) (workspaceRoleRef, string, bool) {
	var config workspaceConfig
	if c == nil || json.Unmarshal(c.Config, &config) != nil {
		return workspaceRoleRef{}, "", false
	}
	for _, ref := range c.RoleRefs {
		if ref.RoleID != id || !ref.Configured || ref.SecretRef == nil || ref.SecretVersion == nil {
			continue
		}
		for _, role := range config.LoginRoles {
			if role.RoleID != nil && *role.RoleID == id && role.LoginMethod == "form" {
				origin, ok := workspaceOrigin(role.LoginOrigin)
				return ref, origin, ok
			}
		}
	}
	return workspaceRoleRef{}, "", false
}

func fetchCredentialJSON(ctx context.Context, cfg Config, path string, fields any, client *http.Client) ([]byte, error) {
	if !strings.HasPrefix(cfg.ServerURL, "https://") {
		return nil, errCredentials
	}
	body, err := json.Marshal(fields)
	if err != nil {
		return nil, errCredentials
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.ServerURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, errCredentials
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	// A cloned client preserves configured CA trust, but never follows redirects.
	isolated := *client
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return errCredentials }
	resp, err := isolated.Do(req)
	if err != nil {
		return nil, errCredentials
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !hasNoStore(resp.Header.Get("Cache-Control")) {
		return nil, errCredentials
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, credentialFrameLimit+1))
	if err != nil || len(raw) > credentialFrameLimit || !utf8.Valid(raw) {
		return nil, errCredentials
	}
	return raw, nil
}

// A resolver is attempt-local. Stdout metadata is consumed before any log path;
// secret responses go only to this attached container's stdin.
type credentialChannel struct {
	ctx      context.Context
	cfg      Config
	r        record
	input    io.Writer
	client   *http.Client
	mu       sync.Mutex
	seen     map[string]bool
	pending  bool
	count    int
	remember func(credentialValues) error
}

func (c *credentialChannel) handle(line string) bool {
	var kind struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal([]byte(line), &kind) != nil || kind.Kind != "credential_request" {
		return false
	}
	var q credentialRequest
	if len(line)+1 > credentialFrameLimit || json.Unmarshal([]byte(line), &q) != nil {
		return true
	}
	fields := []string{"kind", "requestId", "attemptId", "secretRef", "secretVersion"}
	if q.AccountID != "" {
		fields = append(fields, "accountId", "targetOrigin")
	} else {
		fields = append(fields, "roleId")
	}
	if !exactWorkspaceObject([]byte(line), fields...) {
		return true
	}
	c.mu.Lock()
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	if c.ctx.Err() != nil || c.pending || c.count >= 20 || c.seen[q.RequestID] || !uuidPattern.MatchString(q.RequestID) || q.AttemptID != c.r.AttemptID {
		c.mu.Unlock()
		return true
	}
	c.seen[q.RequestID] = true
	c.pending = true
	c.count++
	c.mu.Unlock()
	go func() {
		defer func() { c.mu.Lock(); c.pending = false; c.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
		defer cancel()
		values, err := resolveCredentials(ctx, c.cfg, c.r, q, c.client)
		if ctx.Err() != nil {
			return
		}
		if err == nil && c.remember != nil {
			err = c.remember(values)
		}
		reply := credentialReply{Kind: "credential_response", RequestID: q.RequestID, AttemptID: c.r.AttemptID}
		if err != nil {
			reply.Error = "credential_operation_failed"
		} else {
			reply.Credentials = &values
		}
		data, marshalErr := json.Marshal(reply)
		if marshalErr == nil && len(data) <= credentialFrameLimit && ctx.Err() == nil {
			_, _ = c.input.Write(append(data, '\n'))
		}
		values.Username = ""
		values.Password = ""
	}()
	return true
}

func hasNoStore(value string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), "no-store") {
			return true
		}
	}
	return false
}
