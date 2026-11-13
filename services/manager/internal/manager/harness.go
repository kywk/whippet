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

var errCatalogSearchInput = errors.New("catalog_search_invalid_request")

const toolFrameLimit = 14 << 20
const moduleToolFrameLimit = 26 << 20

func harnessFrameLimit(name string) int {
	if name == "catalog_get" || name == "read_module_draft" || name == "update_module_candidate" {
		return moduleToolFrameLimit
	}
	return toolFrameLimit
}

type toolRequest struct {
	Kind      string          `json:"kind"`
	RequestID string          `json:"requestId"`
	AttemptID string          `json:"attemptId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}
type toolReply struct {
	Kind      string          `json:"kind"`
	RequestID string          `json:"requestId"`
	AttemptID string          `json:"attemptId"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
}

func readHarnessTool(ctx context.Context, cfg Config, r record, q toolRequest, tool registryTool, client *http.Client) (json.RawMessage, error) {
	if ctx.Err() != nil || !strings.HasPrefix(cfg.ServerURL, "https://") || q.AttemptID != r.AttemptID || !uuidPattern.MatchString(q.RequestID) {
		return nil, errCapability
	}
	body, _ := json.Marshal(struct {
		CallID    string          `json:"callId"`
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}{q.RequestID, q.Name, q.Arguments})
	if len(body) > harnessFrameLimit(q.Name) {
		return nil, errCapability
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.ServerURL+"/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/tools", bytes.NewReader(body))
	if err != nil {
		return nil, errCapability
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	isolated := *client
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return errCapability }
	resp, err := isolated.Do(req)
	if err != nil {
		return nil, errCapability
	}
	defer resp.Body.Close()
	if q.Name == "catalog_search" && resp.StatusCode == http.StatusBadRequest && hasNoStore(resp.Header.Get("Cache-Control")) {
		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 4097))
		if readErr == nil && len(raw) <= 4096 && utf8.Valid(raw) && exactWorkspaceObject(raw, "error") {
			var outer struct {
				Error json.RawMessage `json:"error"`
			}
			var detail struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			}
			if json.Unmarshal(raw, &outer) == nil && exactWorkspaceObject(outer.Error, "code", "message") && json.Unmarshal(outer.Error, &detail) == nil && detail.Code == "invalid_request" && validCatalogErrorTypes(outer.Error) && ctx.Err() == nil {
				return nil, errCatalogSearchInput
			}
		}
		return nil, errCapability
	}
	if resp.StatusCode != http.StatusOK || !hasNoStore(resp.Header.Get("Cache-Control")) {
		return nil, errCapability
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, int64(harnessFrameLimit(q.Name))+1))
	if err != nil || len(raw) > harnessFrameLimit(q.Name) || !utf8.Valid(raw) || !exactWorkspaceObject(raw, "runId", "attemptId", "callId", "result") {
		return nil, errCapability
	}
	var reply struct {
		RunID     string          `json:"runId"`
		AttemptID string          `json:"attemptId"`
		CallID    string          `json:"callId"`
		Result    json.RawMessage `json:"result"`
	}
	if json.Unmarshal(raw, &reply) != nil || reply.RunID != r.RunID || reply.AttemptID != r.AttemptID || reply.CallID != q.RequestID || ctx.Err() != nil {
		return nil, errCapability
	}
	var compact bytes.Buffer
	if json.Compact(&compact, reply.Result) != nil || int64(compact.Len()) > tool.Limits.MaxOutputBytes {
		return nil, errCapability
	}
	if q.Name == "read_conversation_history" {
		// History has an additional payload scope envelope.
		var args struct {
			Cursor *string `json:"cursor"`
		}
		if json.Unmarshal(q.Arguments, &args) != nil {
			return nil, errCapability
		}
		if _, err := validHistoryPage(reply.Result, r, historyRequest{RequestID: q.RequestID, AttemptID: q.AttemptID, Cursor: args.Cursor}); err != nil {
			return nil, errCapability
		}
	}
	return append(json.RawMessage(nil), compact.Bytes()...), nil
}

type toolCallState struct {
	fingerprint   string
	result        json.RawMessage
	done          bool
	inputRejected bool
}
type toolChannel struct {
	ctx     context.Context
	cfg     Config
	r       record
	input   io.Writer
	client  *http.Client
	mu      sync.Mutex
	calls   map[string]*toolCallState
	pending bool
}

func (c *toolChannel) reply(q toolRequest, result json.RawMessage, rejected ...bool) {
	if c.ctx.Err() != nil {
		return
	}
	out := toolReply{Kind: "tool_response", RequestID: q.RequestID, AttemptID: c.r.AttemptID, Result: result}
	if result == nil {
		out.Error = "tool_unavailable"
		if q.Name == "catalog_search" && len(rejected) > 0 && rejected[0] {
			out.Error = "catalog_search_invalid_request"
		}
	}
	raw, err := json.Marshal(out)
	if err == nil && len(raw)+1 <= harnessFrameLimit(q.Name) && c.ctx.Err() == nil {
		_, _ = c.input.Write(append(raw, '\n'))
	}
}
func (c *toolChannel) handle(line string) bool {
	var kind struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal([]byte(line), &kind) != nil || kind.Kind != "tool_request" {
		return false
	}
	var q toolRequest
	if len(line)+1 > moduleToolFrameLimit || !utf8.ValidString(line) || !exactWorkspaceObject([]byte(line), "kind", "requestId", "attemptId", "name", "arguments") || json.Unmarshal([]byte(line), &q) != nil || !uuidPattern.MatchString(q.RequestID) || q.AttemptID != c.r.AttemptID {
		return true
	}
	if c.ctx.Err() != nil {
		return true
	}
	registry, err := validCapabilitySnapshot(c.r.Author)
	if err != nil || registry == nil || !hasAllowedTool(c.r.Author, q.Name) || !allowedPlatformTool(c.r.Author, q.Name) || q.Name != "read_conversation_history" && !platformServerTool(q.Name) || q.Name == "read_conversation_history" && !historyAuthor(c.r.Author) {
		c.reply(q, nil)
		return true
	}
	var tool *registryTool
	for i := range registry.Tools {
		if registry.Tools[i].Name == q.Name {
			tool = &registry.Tools[i]
			break
		}
	}
	var compact bytes.Buffer
	var args struct {
		Cursor *string `json:"cursor"`
	}
	if tool == nil || tool.Side != "server" || json.Compact(&compact, q.Arguments) != nil || int64(compact.Len()) > tool.Limits.MaxInputBytes || !validToolArguments(*tool, q.Arguments) || len(line)+1 > harnessFrameLimit(q.Name) {
		c.reply(q, nil)
		return true
	}
	if q.Name == "read_conversation_history" {
		if json.Unmarshal(q.Arguments, &args) != nil {
			c.reply(q, nil)
			return true
		}
		if _, _, ok := parseHistoryCursor(args.Cursor, c.r.Author.History.MaxSequence); !ok {
			c.reply(q, nil)
			return true
		}
	}
	q.Arguments = append(json.RawMessage(nil), compact.Bytes()...)
	fingerprint := q.Name + ":" + string(q.Arguments)
	var budget skillBudget
	_ = json.Unmarshal(c.r.Author.Budget, &budget)
	c.mu.Lock()
	if c.calls == nil {
		c.calls = map[string]*toolCallState{}
	}
	if old, ok := c.calls[q.RequestID]; ok {
		same, done, result, rejected := old.fingerprint == fingerprint, old.done, old.result, old.inputRejected
		c.mu.Unlock()
		if !same {
			c.reply(q, nil)
		} else if done {
			c.reply(q, result, rejected)
		}
		return true
	}
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		return true
	}
	historyCalls := 0
	for _, state := range c.calls {
		if strings.HasPrefix(state.fingerprint, "read_conversation_history:") {
			historyCalls++
		}
	}
	if c.pending || q.Name == "read_conversation_history" && historyCalls >= 4 || int64(len(c.calls)) >= budget.MaxToolCalls {
		c.mu.Unlock()
		c.reply(q, nil)
		return true
	}
	state := &toolCallState{fingerprint: fingerprint}
	c.calls[q.RequestID] = state
	c.pending = true
	c.mu.Unlock()
	go func() {
		timeout := tool.Limits.TimeoutMS
		if c.r.TimeoutMS > 0 && timeout > c.r.TimeoutMS {
			timeout = c.r.TimeoutMS
		}
		ctx, cancel := context.WithTimeout(c.ctx, time.Duration(timeout)*time.Millisecond)
		defer cancel()
		result, err := readHarnessTool(ctx, c.cfg, c.r, q, *tool, c.client)
		if err != nil {
			result = nil
		}
		c.mu.Lock()
		state.inputRejected = errors.Is(err, errCatalogSearchInput)
		state.result = result
		state.done = true
		c.pending = false
		c.mu.Unlock()
		c.reply(q, result, errors.Is(err, errCatalogSearchInput))
	}()
	return true
}

// JSON null must not silently decode into a Go string zero value.
func validCatalogErrorTypes(raw []byte) bool {
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	_, code := value["code"].(string)
	_, message := value["message"].(string)
	return code && message
}
