package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type sessionCredentialRequest struct {
	Kind      string `json:"kind"`
	SessionID string `json:"sessionId"`
	LeaseID   string `json:"leaseId"`
	CallID    string `json:"callId"`
	RequestID string `json:"requestId"`
	RoleID    string `json:"roleId"`
}

type sessionCredentialValues struct {
	SessionID   string `json:"sessionId"`
	LeaseID     string `json:"leaseId"`
	WorkspaceID string `json:"workspaceId"`
	RoleID      string `json:"roleId"`
	LoginOrigin string `json:"loginOrigin"`
	Username    string `json:"username"`
	Password    string `json:"password"`
}

type sessionCredentialReply struct {
	Kind        string                   `json:"kind"`
	SessionID   string                   `json:"sessionId"`
	LeaseID     string                   `json:"leaseId"`
	CallID      string                   `json:"callId"`
	RequestID   string                   `json:"requestId"`
	Credentials *sessionCredentialValues `json:"credentials,omitempty"`
	Error       string                   `json:"error,omitempty"`
}

func resolveSessionCredentials(ctx context.Context, cfg Config, r sessionRecord, q sessionCredentialRequest, origin string, client *http.Client) (sessionCredentialValues, error) {
	var values sessionCredentialValues
	if !strings.HasPrefix(cfg.ServerURL, "https://") {
		return values, errCredentials
	}
	body, _ := json.Marshal(map[string]string{"roleId": q.RoleID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.ServerURL+"/api/manager/browser-sessions/"+r.SessionID+"/leases/"+r.LeaseID+"/credentials/resolve", bytes.NewReader(body))
	if err != nil {
		return values, errCredentials
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	isolated := *client
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return errCredentials }
	resp, err := isolated.Do(req)
	if err != nil {
		return values, errCredentials
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !hasNoStore(resp.Header.Get("Cache-Control")) {
		return values, errCredentials
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, credentialFrameLimit+1))
	if err != nil || len(raw) > credentialFrameLimit || !exactWorkspaceObject(raw, "sessionId", "leaseId", "workspaceId", "roleId", "loginOrigin", "username", "password") {
		return values, errCredentials
	}
	if json.Unmarshal(raw, &values) != nil {
		return sessionCredentialValues{}, errCredentials
	}
	expected, valid := workspaceOrigin(origin)
	actual, actualValid := workspaceOrigin(values.LoginOrigin)
	if !valid || !actualValid || expected != actual || values.SessionID != r.SessionID || values.LeaseID != r.LeaseID ||
		values.WorkspaceID != r.WorkspaceID || values.RoleID != q.RoleID || !boundedAuthorText(values.Username, 4096, true) || !boundedAuthorText(values.Password, 4096, true) {
		return sessionCredentialValues{}, errCredentials
	}
	return values, nil
}

func (m *Manager) handleSessionCredential(ctx context.Context, r sessionRecord, q sessionCredentialRequest, writer *attemptInputWriter) {
	m.mu.Lock()
	current, ok := m.sessions[r.SessionID]
	work := m.sessionWorking[r.SessionID]
	valid := ok && current.LeaseID == q.LeaseID && current.State == "ready" && !current.Reclaimed && time.Now().UnixMilli() < current.DeadlineAt &&
		work != nil && work.active == q.CallID && work.calls[q.CallID] != nil && work.calls[q.CallID].roleID == q.RoleID &&
		!work.credentialPending && work.credentialCount < 20 && !work.credentialSeen[q.RequestID]
	origin := ""
	if valid {
		var config workspaceConfig
		if work.workspace == nil || json.Unmarshal(work.workspace.Config, &config) != nil {
			valid = false
		} else {
			foundRef := false
			for _, ref := range work.workspace.RoleRefs {
				if ref.RoleID == q.RoleID && ref.Configured && ref.SecretRef != nil && ref.SecretVersion != nil {
					foundRef = true
				}
			}
			for _, role := range config.LoginRoles {
				if role.RoleID != nil && *role.RoleID == q.RoleID && role.LoginMethod == "form" {
					origin = role.LoginOrigin
				}
			}
			valid = foundRef && origin != ""
		}
	}
	if valid {
		work.credentialSeen[q.RequestID] = true
		work.credentialPending = true
		work.credentialCount++
	}
	m.mu.Unlock()
	if !valid {
		m.sendSessionCredentialReply(ctx, r, q, writer, nil)
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer func() {
			m.mu.Lock()
			if state := m.sessionWorking[r.SessionID]; state == work {
				state.credentialPending = false
			}
			m.mu.Unlock()
		}()
		resolveCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		client := m.http
		if client == nil {
			client = newHTTPClient()
		}
		values, err := resolveSessionCredentials(resolveCtx, m.cfg, r, q, origin, client)
		if err != nil {
			m.sendSessionCredentialReply(ctx, r, q, writer, nil)
			return
		}
		m.sendSessionCredentialReply(ctx, r, q, writer, &values)
		values.Username, values.Password = "", ""
	}()
}

func (m *Manager) sendSessionCredentialReply(ctx context.Context, r sessionRecord, q sessionCredentialRequest, writer *attemptInputWriter, values *sessionCredentialValues) {
	if ctx.Err() != nil {
		return
	}
	m.mu.Lock()
	current := m.sessions[r.SessionID]
	work := m.sessionWorking[r.SessionID]
	active := current.LeaseID == r.LeaseID && current.State == "ready" && !current.Reclaimed && time.Now().UnixMilli() < current.DeadlineAt &&
		work != nil && work.active == q.CallID && work.calls[q.CallID] != nil && work.calls[q.CallID].roleID == q.RoleID
	m.mu.Unlock()
	if !active {
		return
	}
	reply := sessionCredentialReply{Kind: "credential_response", SessionID: r.SessionID, LeaseID: r.LeaseID, CallID: q.CallID, RequestID: q.RequestID, Credentials: values}
	if values == nil {
		reply.Error = "credential_operation_failed"
	}
	raw, err := json.Marshal(reply)
	if err == nil && len(raw)+1 <= credentialFrameLimit && ctx.Err() == nil {
		_, _ = writer.Write(append(raw, '\n'))
	}
}
