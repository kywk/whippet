package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const modelKeyFrameLimit = 32 << 10
const modelKeyTimeout = 15 * time.Second

var errModelKey = errors.New("credential_unavailable")

type modelCredential struct {
	AgentID       string `json:"agentId"`
	SecretVersion int64  `json:"secretVersion"`
}

func (c modelCredential) valid() bool {
	return uuidPattern.MatchString(c.AgentID) && c.SecretVersion > 0 && c.SecretVersion <= 9007199254740991
}

func (c *modelCredential) UnmarshalJSON(raw []byte) error {
	type fields modelCredential
	if !exactAdminFields(raw, "agentId", "secretVersion") || json.Unmarshal(raw, (*fields)(c)) != nil || !c.valid() {
		return errModelKey
	}
	return nil
}

func sameModelCredential(a, b *modelCredential) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

type modelKeyRequest struct {
	modelCredential
	Purpose     string `json:"purpose"`
	RunID       string `json:"runId,omitempty"`
	AttemptID   string `json:"attemptId,omitempty"`
	OperationID string `json:"operationId,omitempty"`
}

func (m *Manager) resolveModelKey(ctx context.Context, q modelKeyRequest, workspaceID string) (string, error) {
	session := m.currentKeySession()
	if session == nil || !strings.HasPrefix(m.cfg.ServerURL, "https://") || !q.modelCredential.valid() || !uuidPattern.MatchString(workspaceID) {
		return "", errModelKey
	}
	keys := []string{"agentId", "secretVersion", "purpose", "workspaceId", "apiKey"}
	switch q.Purpose {
	case "run":
		if !uuidPattern.MatchString(q.RunID) || !uuidPattern.MatchString(q.AttemptID) || q.OperationID != "" {
			return "", errModelKey
		}
		keys = append(keys, "runId", "attemptId")
	case "probe":
		if !uuidPattern.MatchString(q.OperationID) || q.RunID != "" || q.AttemptID != "" {
			return "", errModelKey
		}
		keys = append(keys, "operationId")
	default:
		return "", errModelKey
	}
	ctx, cancel := context.WithTimeout(ctx, modelKeyTimeout)
	defer cancel()
	stop := context.AfterFunc(session.ctx, cancel)
	defer stop()
	body, _ := json.Marshal(q)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.cfg.ServerURL+"/api/manager/agent-keys/resolve", bytes.NewReader(body))
	if err != nil {
		return "", errModelKey
	}
	req.Header.Set("Authorization", "Bearer "+m.cfg.Token)
	req.Header.Set("X-Whippet-Manager-Session", session.nonce)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	client := *m.http
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errModelKey }
	resp, err := client.Do(req)
	if err != nil {
		return "", errModelKey
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !hasNoStore(resp.Header.Get("Cache-Control")) {
		return "", errModelKey
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, modelKeyFrameLimit+1))
	var reply struct {
		AgentID       string `json:"agentId"`
		SecretVersion int64  `json:"secretVersion"`
		Purpose       string `json:"purpose"`
		RunID         string `json:"runId"`
		AttemptID     string `json:"attemptId"`
		OperationID   string `json:"operationId"`
		WorkspaceID   string `json:"workspaceId"`
		APIKey        string `json:"apiKey"`
	}
	if err != nil || len(raw) > modelKeyFrameLimit || !exactAdminFields(raw, keys...) || json.Unmarshal(raw, &reply) != nil ||
		q.AgentID != reply.AgentID || q.SecretVersion != reply.SecretVersion || q.Purpose != reply.Purpose || q.RunID != reply.RunID ||
		q.AttemptID != reply.AttemptID || q.OperationID != reply.OperationID || workspaceID != reply.WorkspaceID || !validModelKey(reply.APIKey) ||
		ctx.Err() != nil || m.currentKeySession() != session {
		return "", errModelKey
	}
	return reply.APIKey, nil
}

func validModelKey(key string) bool {
	if len(key) == 0 || len(key) > 4096 {
		return false
	}
	for i := range len(key) {
		if key[i] < 0x21 || key[i] > 0x7e {
			return false
		}
	}
	return true
}

type modelKeyResolver func(context.Context, modelKeyRequest, string) (string, error)

type modelKeyChannel struct {
	ctx         context.Context
	request     modelKeyRequest
	workspaceID string
	input       io.Writer
	resolve     modelKeyResolver
	remember    func(string) error
	used        bool // Called only by the attached container's stdout reader.
}

func (c *modelKeyChannel) handle(line string) bool {
	raw := json.RawMessage(line)
	var frame struct {
		Kind          string `json:"kind"`
		RequestID     string `json:"requestId"`
		AgentID       string `json:"agentId"`
		SecretVersion int64  `json:"secretVersion"`
	}
	if json.Unmarshal(raw, &frame) != nil || frame.Kind != "model_key_request" {
		return false
	}
	if c.resolve == nil || c.used || c.ctx.Err() != nil || len(raw)+1 > modelKeyFrameLimit ||
		!exactAdminFields(raw, "kind", "requestId", "agentId", "secretVersion") || !uuidPattern.MatchString(frame.RequestID) ||
		frame.AgentID != c.request.AgentID || frame.SecretVersion != c.request.SecretVersion {
		return true
	}
	c.used = true
	go func() {
		ctx, cancel := context.WithTimeout(c.ctx, modelKeyTimeout)
		defer cancel()
		key, err := c.resolve(ctx, c.request, c.workspaceID)
		if ctx.Err() != nil {
			return
		}
		if err == nil && !validModelKey(key) {
			err = errModelKey
		}
		if err == nil && c.remember != nil {
			err = c.remember(key)
		}
		reply := map[string]any{"kind": "model_key_response", "requestId": frame.RequestID}
		if err != nil {
			reply["code"] = "credential_unavailable"
		} else {
			reply["agentId"], reply["secretVersion"], reply["apiKey"] = frame.AgentID, frame.SecretVersion, key
		}
		data, _ := json.Marshal(reply)
		if len(data)+1 <= modelKeyFrameLimit && ctx.Err() == nil {
			_, _ = c.input.Write(append(data, '\n'))
		}
	}()
	return true
}
