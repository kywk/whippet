package server

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func mcpBrowserResult(value any, limit int) *mcp.CallToolResult {
	data, err := json.Marshal(value)
	if err != nil || len(data) > limit {
		return mcpToolError()
	}
	var structured map[string]any
	if json.Unmarshal(data, &structured) != nil || structured == nil {
		return mcpToolError()
	}
	return &mcp.CallToolResult{StructuredContent: structured, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}
}

func mcpBrowserError(code string) *mcp.CallToolResult {
	if !validBrowserError(code) {
		code = "session_unavailable"
	}
	return &mcp.CallToolResult{IsError: true, StructuredContent: map[string]any{"error": code}, Content: []mcp.Content{&mcp.TextContent{Text: code}}}
}

func mcpBrowserMeta(req *mcp.CallToolRequest) (string, string, string, bool) {
	if req == nil || req.Params == nil {
		return "", "", "", false
	}
	whippet, ok := req.Params.GetMeta()["whippet"].(map[string]any)
	if !ok || len(whippet) != 3 {
		return "", "", "", false
	}
	sessionID, sOK := whippet["sessionId"].(string)
	leaseID, lOK := whippet["leaseId"].(string)
	callID, cOK := whippet["callId"].(string)
	if !sOK || !lOK || !cOK || !ValidID(sessionID) || !ValidID(leaseID) || !ValidID(callID) {
		return "", "", "", false
	}
	return sessionID, leaseID, callID, true
}

func (a *API) callMCPBrowser(ctx context.Context, p *Postgres, tool ToolDefinition, token AgentToken, req *mcp.CallToolRequest, canonical []byte) *mcp.CallToolResult {
	switch tool.Name {
	case "browser_session_open":
		var args struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(canonical, &args) != nil || !ValidID(args.RequestID) {
			return mcpToolError()
		}
		previous, err := p.BrowserLeaseByRequest(ctx, token.ID, args.RequestID)
		if err == nil {
			return mcpBrowserResult(previous, tool.Limits.MaxOutputBytes)
		}
		if !errors.Is(err, ErrNotFound) || a.engine == nil {
			return mcpToolFailure(ctx)
		}
		managerID, epoch, ready := a.engine.BrowserEndpoint()
		if !ready {
			return mcpToolError()
		}
		workspace, err := p.Workspace(ctx, token.WorkspaceID)
		if err != nil {
			return mcpToolFailure(ctx)
		}
		registry, err := loadToolRegistry()
		if err != nil {
			return mcpToolFailure(ctx)
		}
		lease, existed, err := p.OpenBrowserLease(ctx, token, args.RequestID, managerID, epoch, registry, workspace)
		if err != nil {
			return mcpToolError()
		}
		if existed {
			return mcpBrowserResult(lease, tool.Limits.MaxOutputBytes)
		}
		if err := a.engine.SendBrowserOpen(lease); err != nil {
			_ = p.MarkBrowserLeaseReclaimPending(ctx, lease.ManagerID)
			a.engine.Wake()
			lease.State = "reclaim_pending"
			return mcpBrowserResult(lease, tool.Limits.MaxOutputBytes)
		}
		wait, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for lease.State == "opening" {
			select {
			case <-wait.Done():
				return mcpBrowserResult(lease, tool.Limits.MaxOutputBytes)
			case <-ticker.C:
				current, err := p.BrowserLeaseOwned(wait, token, lease.SessionID, lease.LeaseID)
				if err != nil {
					return mcpToolFailure(ctx)
				}
				lease = current
			}
		}
		return mcpBrowserResult(lease, tool.Limits.MaxOutputBytes)
	case "browser_session_status", "browser_session_close":
		var args struct {
			SessionID string `json:"sessionId"`
			LeaseID   string `json:"leaseId"`
		}
		if json.Unmarshal(canonical, &args) != nil || !ValidID(args.SessionID) || !ValidID(args.LeaseID) {
			return mcpToolError()
		}
		var lease BrowserLease
		var err error
		if tool.Name == "browser_session_status" {
			lease, err = p.BrowserLeaseOwned(ctx, token, args.SessionID, args.LeaseID)
		} else {
			lease, err = p.CloseBrowserLease(ctx, token, args.SessionID, args.LeaseID)
			if err == nil && a.engine != nil {
				a.engine.endLiveBrowserSession(args.SessionID)
				a.engine.Wake()
			}
		}
		if err != nil {
			return mcpToolError()
		}
		return mcpBrowserResult(lease, tool.Limits.MaxOutputBytes)
	case "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login":
		return a.callMCPBrowserAction(ctx, p, tool, token, req, canonical)
	default:
		return mcpToolError()
	}
}

func (a *API) callMCPBrowserAction(ctx context.Context, p *Postgres, tool ToolDefinition, token AgentToken, req *mcp.CallToolRequest, canonical []byte) *mcp.CallToolResult {
	sessionID, leaseID, callID, ok := mcpBrowserMeta(req)
	if !ok {
		return mcpToolError()
	}
	return a.callMCPBrowserActionOwned(ctx, p, tool, token, sessionID, leaseID, callID, canonical)
}

func (a *API) callMCPBrowserActionOwned(ctx context.Context, p *Postgres, tool ToolDefinition, token AgentToken, sessionID, leaseID, callID string, canonical []byte) *mcp.CallToolResult {
	if a.engine == nil {
		return mcpToolError()
	}
	lease, err := p.BrowserLeaseOwned(ctx, token, sessionID, leaseID)
	if err != nil || lease.State != "ready" || lease.Reclaimed {
		return mcpToolError()
	}
	existed, err := p.ReserveBrowserCall(ctx, token, lease, callID, tool.Name, canonical)
	if err != nil {
		if errors.Is(err, errBrowserScopeInvalid) {
			_, _ = p.CloseBrowserLease(ctx, token, sessionID, leaseID)
			a.engine.endLiveBrowserSession(sessionID)
			a.engine.Wake()
		}
		if errors.Is(err, errBrowserBusy) {
			return mcpBrowserError("busy")
		}
		return mcpToolError()
	}
	if existed {
		result, code, found, complete := a.engine.BrowserCachedCall(sessionID, callID)
		if !found {
			return mcpBrowserError("unknown_result")
		}
		if !complete {
			return mcpBrowserError("busy")
		}
		if code != "" {
			return mcpBrowserError(code)
		}
		return mcpBrowserResult(json.RawMessage(result), tool.Limits.MaxOutputBytes)
	}
	if _, err := a.recheckAgent(ctx, p); err != nil {
		_ = p.UnknownBrowserCall(ctx, sessionID, callID)
		return mcpToolError()
	}
	flight, err := a.engine.SendBrowserCall(lease, callID, tool.Name, json.RawMessage(canonical))
	if err != nil {
		_ = p.UnknownBrowserCall(ctx, sessionID, callID)
		_ = p.MarkBrowserLeaseReclaimPending(ctx, lease.ManagerID)
		a.engine.Wake()
		return mcpBrowserError("unknown_result")
	}
	result, code := a.engine.AwaitBrowserCall(ctx, flight)
	if code != "" || len(result) == 0 {
		if code == "unknown_result" {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_ = p.UnknownBrowserCall(cleanupCtx, sessionID, callID)
			_, _ = p.CloseBrowserLease(cleanupCtx, token, sessionID, leaseID)
			cancel()
			a.engine.Wake()
		}
		if code == "" {
			code = "unknown_result"
		}
		return mcpBrowserError(code)
	}
	if _, err := a.recheckAgent(ctx, p); err != nil {
		return mcpToolError()
	}
	return mcpBrowserResult(json.RawMessage(result), tool.Limits.MaxOutputBytes)
}
