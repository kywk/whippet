package manager

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type sessionCredentialRequest struct {
	Kind      string `json:"kind"`
	SessionID string `json:"sessionId"`
	LeaseID   string `json:"leaseId"`
	CallID    string `json:"callId"`
	RequestID string `json:"requestId"`
	RoleID    string `json:"roleId,omitempty"`
	AccountID string `json:"accountId,omitempty"`
	Target    string `json:"targetOrigin,omitempty"`
}

type sessionCredentialValues struct {
	SessionID   string `json:"sessionId"`
	LeaseID     string `json:"leaseId"`
	WorkspaceID string `json:"workspaceId"`
	RoleID      string `json:"roleId,omitempty"`
	CallID      string `json:"callId,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
	Target      string `json:"targetOrigin,omitempty"`
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
	fields := []string{"sessionId", "leaseId", "workspaceId", "loginOrigin", "username", "password"}
	body := map[string]string{"roleId": q.RoleID}
	if q.AccountID != "" {
		fields = append(fields, "callId", "accountId", "targetOrigin")
		body = map[string]string{"callId": q.CallID, "accountId": q.AccountID, "targetOrigin": q.Target}
	} else {
		fields = append(fields, "roleId")
	}
	path := "/api/manager/browser-sessions/" + r.SessionID + "/leases/" + r.LeaseID + "/credentials/resolve"
	raw, err := fetchCredentialJSON(ctx, cfg, path, body, client)
	if err != nil || !exactWorkspaceObject(raw, fields...) || json.Unmarshal(raw, &values) != nil {
		return sessionCredentialValues{}, errCredentials
	}
	expected, valid := workspaceOrigin(origin)
	actual, actualValid := workspaceOrigin(values.LoginOrigin)
	if !valid || !actualValid || expected != actual || values.SessionID != r.SessionID || values.LeaseID != r.LeaseID ||
		values.WorkspaceID != r.WorkspaceID || values.RoleID != q.RoleID || values.AccountID != q.AccountID || values.Target != q.Target ||
		(q.AccountID != "" && values.CallID != q.CallID) || !boundedAuthorText(values.Username, 4096, true) || !boundedAuthorText(values.Password, 4096, true) {
		return sessionCredentialValues{}, errCredentials
	}
	return values, nil
}

func (q sessionCredentialRequest) matches(call *sessionCallState) bool {
	return call != nil && (q.RoleID != "" || q.AccountID != "") && call.roleID == q.RoleID && call.accountTarget == (accountSite{q.AccountID, q.Target})
}

func (m *Manager) handleSessionCredential(ctx context.Context, r sessionRecord, q sessionCredentialRequest, writer *attemptInputWriter) {
	m.mu.Lock()
	current, ok := m.sessions[r.SessionID]
	work := m.sessionWorking[r.SessionID]
	valid := ok && current.LeaseID == q.LeaseID && current.State == "ready" && !current.Reclaimed && time.Now().UnixMilli() < current.DeadlineAt &&
		work != nil && work.active == q.CallID && q.matches(work.calls[q.CallID]) &&
		!work.credentialPending && work.credentialCount < 20 && !work.credentialSeen[q.RequestID]
	origin := ""
	if valid {
		if q.AccountID != "" {
			binding, found := work.workspace.accountBinding(q.AccountID, q.Target)
			origin, valid = workspaceURLOrigin(binding.EntryURL)
			valid = valid && found
		} else {
			_, origin, valid = work.workspace.configuredRole(q.RoleID)
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
		work != nil && work.active == q.CallID && q.matches(work.calls[q.CallID])
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
