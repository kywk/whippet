package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"
)

const maxHarnessFrameBytes = 14 << 20

type HarnessToolRequest struct {
	CallID    string          `json:"callId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}
type harnessStore interface {
	HarnessHistory(context.Context, string, string, string, HarnessToolRequest, *ToolRegistry) (HistoryPage, error)
}

func decodeHarnessRequest(data []byte, registry *ToolRegistry) (HarnessToolRequest, ToolDefinition, error) {
	var request HarnessToolRequest
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if len(data) > maxHarnessFrameBytes || dec.Decode(&request) != nil || dec.Decode(new(any)) != io.EOF || !ValidID(request.CallID) {
		return request, ToolDefinition{}, ErrInvalid
	}
	if request.Name == "read_conversation_history" && len(data) > 64<<10 {
		return request, ToolDefinition{}, ErrInvalid
	}
	tool, ok := registry.tool(request.Name)
	if !ok || tool.Side != "server" || (request.Name != "read_conversation_history" && !platformServerTool(request.Name)) {
		return request, tool, ErrHistoryUnavailable
	}
	canonical, err := validateToolArguments(tool, request.Arguments)
	if err != nil {
		return request, tool, ErrInvalid
	}
	if request.Name == "read_conversation_history" {
		if _, err := harnessCursor(request.Arguments); err != nil {
			return request, tool, err
		}
	}
	request.Arguments = canonical
	return request, tool, nil
}
func harnessCursor(args []byte) (*string, error) {
	var body struct {
		Cursor json.RawMessage `json:"cursor"`
	}
	dec := json.NewDecoder(bytes.NewReader(args))
	dec.DisallowUnknownFields()
	var cursor *string
	if dec.Decode(&body) != nil || dec.Decode(new(any)) != io.EOF || len(body.Cursor) == 0 || json.Unmarshal(body.Cursor, &cursor) != nil {
		return nil, ErrInvalid
	}
	if _, _, err := historyCursor(cursor, 9223372036854775807); err != nil {
		return nil, err
	}
	return cursor, nil
}
func (a *API) harnessTool(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.TLS == nil {
		writeError(w, 400, "protected_transport_required", "Manager tools require TLS")
		return
	}
	run, attempt := r.PathValue("id"), r.PathValue("attemptId")
	if !ValidID(run) || !ValidID(attempt) {
		a.fail(w, ErrInvalid)
		return
	}
	registry, err := loadToolRegistry()
	if err != nil {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxHarnessFrameBytes))
	if err != nil {
		a.fail(w, ErrInvalid)
		return
	}
	request, tool, err := decodeHarnessRequest(data, registry)
	if err != nil {
		a.fail(w, err)
		return
	}
	manager, epoch, ready := a.engine.credentialManager()
	if !ready {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	store, ok := a.store.(harnessStore)
	if !ok {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), time.Duration(tool.Limits.TimeoutMS)*time.Millisecond)
	defer cancel()
	var page any
	if request.Name == "read_conversation_history" {
		page, err = store.HarnessHistory(ctx, manager, run, attempt, request, registry)
	} else {
		platform, ok := a.store.(interface {
			HarnessPlatform(context.Context, string, string, string, HarnessToolRequest, *ToolRegistry, func() bool) (any, error)
		})
		if !ok {
			a.fail(w, ErrHistoryUnavailable)
			return
		}
		page, err = platform.HarnessPlatform(ctx, manager, run, attempt, request, registry, func() bool { m, e, ready := a.engine.credentialManager(); return ready && m == manager && e == epoch })
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	current, currentEpoch, ready := a.engine.credentialManager()
	if !ready || current != manager || currentEpoch != epoch {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	result, err := json.Marshal(page)
	if err != nil || len(result) > tool.Limits.MaxOutputBytes {
		a.fail(w, ErrHistoryUnavailable)
		return
	}
	writeJSON(w, 200, struct {
		RunID     string `json:"runId"`
		AttemptID string `json:"attemptId"`
		CallID    string `json:"callId"`
		Result    any    `json:"result"`
	}{run, attempt, request.CallID, page})
}
func (p *Postgres) HarnessHistory(ctx context.Context, manager, run, attempt string, request HarnessToolRequest, registry *ToolRegistry) (HistoryPage, error) {
	if !ValidID(request.CallID) || request.Name != "read_conversation_history" {
		return HistoryPage{}, ErrInvalid
	}
	cursor, err := harnessCursor(request.Arguments)
	if err != nil {
		return HistoryPage{}, err
	}
	return p.conversationHistory(ctx, manager, run, attempt, cursor, &request, registry)
}
