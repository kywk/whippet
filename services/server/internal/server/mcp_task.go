package server

import (
	"context"
	"encoding/json"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func (a *API) callMCPTask(ctx context.Context, p *Postgres, tool ToolDefinition, token AgentToken, canonical []byte) *mcp.CallToolResult {
	switch tool.Name {
	case "task_claim":
		var args struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(canonical, &args) != nil || !ValidID(args.RequestID) {
			return mcpToolError()
		}
		if err := p.ExpireExternalClaims(ctx); err != nil {
			return mcpToolFailure(ctx)
		}
		task, err := p.ClaimExternalAuthor(ctx, token, args.RequestID)
		if err != nil {
			return mcpToolError()
		}
		return mcpBrowserResult(map[string]any{"task": task}, tool.Limits.MaxOutputBytes)
	case "task_heartbeat":
		var args struct {
			RunID     string `json:"runId"`
			AttemptID string `json:"attemptId"`
			LeaseID   string `json:"leaseId"`
		}
		if json.Unmarshal(canonical, &args) != nil || !validExternalIDs(args.RunID, args.AttemptID, args.LeaseID) {
			return mcpToolError()
		}
		result, err := p.HeartbeatExternalAuthor(ctx, token, args.RunID, args.AttemptID, args.LeaseID)
		if err != nil {
			return mcpToolError()
		}
		return mcpBrowserResult(result, tool.Limits.MaxOutputBytes)
	case "task_tool_call":
		var args struct {
			RunID     string          `json:"runId"`
			AttemptID string          `json:"attemptId"`
			LeaseID   string          `json:"leaseId"`
			CallID    string          `json:"callId"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if json.Unmarshal(canonical, &args) != nil || !validExternalIDs(args.RunID, args.AttemptID, args.LeaseID) || !ValidID(args.CallID) {
			return mcpToolError()
		}
		return a.callExternalTool(ctx, p, token, tool, args.RunID, args.AttemptID, args.LeaseID, args.CallID, args.Name, args.Arguments)
	case "task_submit":
		var args struct {
			RunID     string          `json:"runId"`
			AttemptID string          `json:"attemptId"`
			LeaseID   string          `json:"leaseId"`
			SubmitID  string          `json:"submitId"`
			Output    json.RawMessage `json:"output"`
		}
		if json.Unmarshal(canonical, &args) != nil || !validExternalIDs(args.RunID, args.AttemptID, args.LeaseID) || !ValidID(args.SubmitID) {
			return mcpToolError()
		}
		if _, err := decodeExternalAuthorOutput(args.Output); err != nil {
			return mcpToolError()
		}
		// A task-owned anonymous browser is closed before the formal validation can run.
		sessionID, err := p.ExternalBrowser(ctx, token, args.RunID, args.AttemptID, args.LeaseID)
		if err != nil {
			// A committed identical retry must remain readable after the claim turned terminal.
			result, e := p.SubmitExternalAuthor(ctx, token, args.RunID, args.AttemptID, args.LeaseID, args.SubmitID, args.Output)
			if e != nil {
				return mcpToolError()
			}
			return mcpBrowserResult(result, tool.Limits.MaxOutputBytes)
		}
		if sessionID != nil {
			lease, e := p.BrowserLeaseBySession(ctx, *sessionID)
			if e != nil || lease.TokenID != token.ID || lease.WorkspaceID != token.WorkspaceID {
				return mcpToolError()
			}
			if !lease.Reclaimed {
				_, e = p.CloseBrowserLease(ctx, token, lease.SessionID, lease.LeaseID)
				if e != nil {
					return mcpToolFailure(ctx)
				}
				if a.engine != nil {
					a.engine.Wake()
				}
				return mcpBrowserError("busy")
			}
		}
		result, err := p.SubmitExternalAuthor(ctx, token, args.RunID, args.AttemptID, args.LeaseID, args.SubmitID, args.Output)
		if err != nil {
			return mcpToolError()
		}
		if a.engine != nil {
			a.engine.Wake()
		}
		return mcpBrowserResult(result, tool.Limits.MaxOutputBytes)
	}
	return mcpToolError()
}

func validExternalIDs(runID, attemptID, leaseID string) bool {
	return ValidID(runID) && ValidID(attemptID) && ValidID(leaseID)
}

func (a *API) callExternalTool(ctx context.Context, p *Postgres, token AgentToken, outer ToolDefinition, runID, attemptID, leaseID, callID, name string, args []byte) *mcp.CallToolResult {
	registry, err := loadToolRegistry()
	if err != nil {
		return mcpToolFailure(ctx)
	}
	nested, ok := registry.tool(name)
	if !ok {
		return mcpToolError()
	}
	canonical, err := validateToolArguments(nested, args)
	if err != nil {
		return mcpToolError()
	}
	c, prior, replay, err := p.ReserveExternalToolCall(ctx, token, runID, attemptID, leaseID, callID, name, canonical, registry)
	if err != nil {
		return mcpToolError()
	}
	if replay {
		return externalToolMCPResult(prior, outer.Limits.MaxOutputBytes)
	}
	toolCtx, cancel := context.WithTimeout(ctx, time.Duration(nested.Limits.TimeoutMS)*time.Millisecond)
	defer cancel()
	receipt := a.executeExternalTool(toolCtx, p, token, c, nested, callID, canonical)
	if len(receipt.Value) > outer.Limits.MaxOutputBytes || len(receipt.Value) > nested.Limits.MaxOutputBytes {
		receipt = externalToolReceipt{Error: "tool_unavailable"}
	}
	cleanupCtx, done := context.WithTimeout(context.Background(), 3*time.Second)
	if err = p.CompleteExternalToolCall(cleanupCtx, runID, callID, receipt); err != nil {
		receipt = externalToolReceipt{Error: "unknown_result"}
	}
	done()
	return externalToolMCPResult(receipt, outer.Limits.MaxOutputBytes)
}

func externalToolMCPResult(receipt externalToolReceipt, limit int) *mcp.CallToolResult {
	if receipt.Error != "" {
		if receipt.Error == "busy" || receipt.Error == "unknown_result" {
			return mcpBrowserError(receipt.Error)
		}
		return mcpToolError()
	}
	if len(receipt.Value) == 0 {
		return mcpToolError()
	}
	return mcpBrowserResult(json.RawMessage(receipt.Value), limit)
}

func (a *API) executeExternalTool(ctx context.Context, p *Postgres, token AgentToken, c externalClaim, tool ToolDefinition, callID string, canonical []byte) externalToolReceipt {
	switch tool.Name {
	case "read_draft":
		task, err := p.externalTask(ctx, p.DB, c)
		if err != nil {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		raw, _ := json.Marshal(map[string]any{"script": task.ContextBundle.Script, "baseRevision": task.ContextBundle.Author.BaseRevision})
		return externalToolReceipt{Value: raw}
	case "read_validation_report":
		task, err := p.externalTask(ctx, p.DB, c)
		if err != nil {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		var value any = map[string]any{"status": "none"}
		if task.ContextBundle.Author.Validation != nil {
			value = task.ContextBundle.Author.Validation
		}
		raw, _ := json.Marshal(value)
		return externalToolReceipt{Value: raw}
	case "read_conversation_history":
		cursor, err := harnessCursor(canonical)
		if err != nil {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		page, err := p.ExternalConversationHistory(ctx, c, cursor)
		if err != nil {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		raw, _ := json.Marshal(map[string]any{"items": page.Items, "nextCursor": page.NextCursor})
		return externalToolReceipt{Value: raw}
	case "browser_navigate", "browser_snapshot", "browser_click", "browser_fill":
		if a.engine == nil {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		var lease BrowserLease
		var err error
		if c.BrowserSessionID == nil {
			manager, epoch, ready := a.engine.BrowserEndpoint()
			if !ready {
				return externalToolReceipt{Error: "busy", Retryable: true}
			}
			workspace, e := p.Workspace(ctx, token.WorkspaceID)
			if e != nil {
				return externalToolReceipt{Error: "tool_unavailable"}
			}
			registry, e := loadToolRegistry()
			if e != nil {
				return externalToolReceipt{Error: "tool_unavailable"}
			}
			var existed bool
			lease, existed, err = p.OpenBrowserLease(ctx, token, c.LeaseID, manager, epoch, registry, workspace)
			if err != nil {
				return externalToolReceipt{Error: "busy", Retryable: true}
			}
			if err = p.BindExternalBrowser(ctx, token, c, lease.SessionID); err != nil {
				_, _ = p.CloseBrowserLease(ctx, token, lease.SessionID, lease.LeaseID)
				a.engine.Wake()
				return externalToolReceipt{Error: "tool_unavailable"}
			}
			if !existed {
				if err = a.engine.SendBrowserOpen(lease); err != nil {
					_ = p.MarkBrowserLeaseReclaimPending(ctx, lease.ManagerID)
					a.engine.Wake()
					return externalToolReceipt{Error: "unknown_result"}
				}
			}
		} else {
			lease, err = p.BrowserLeaseBySession(ctx, *c.BrowserSessionID)
			if err != nil {
				return externalToolReceipt{Error: "tool_unavailable"}
			}
		}
		if lease.State == "opening" {
			wait, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			for lease.State == "opening" {
				select {
				case <-wait.Done():
					return externalToolReceipt{Error: "busy", Retryable: true}
				case <-ticker.C:
					lease, err = p.BrowserLeaseOwned(wait, token, lease.SessionID, lease.LeaseID)
					if err != nil {
						return externalToolReceipt{Error: "tool_unavailable"}
					}
				}
			}
		}
		if lease.State != "ready" || lease.Reclaimed {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		if _, err = p.ExternalBrowser(ctx, token, c.RunID, c.AttemptID, c.LeaseID); err != nil {
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		response := a.callMCPBrowserActionOwned(ctx, p, tool, token, lease.SessionID, lease.LeaseID, callID, canonical)
		if response == nil {
			return externalToolReceipt{Error: "unknown_result"}
		}
		if response.IsError {
			if structured, ok := response.StructuredContent.(map[string]any); ok {
				if code, ok := structured["error"].(string); ok && (code == "busy" || code == "unknown_result") {
					return externalToolReceipt{Error: code}
				}
			}
			return externalToolReceipt{Error: "tool_unavailable"}
		}
		raw, err := json.Marshal(response.StructuredContent)
		if err != nil {
			return externalToolReceipt{Error: "unknown_result"}
		}
		return externalToolReceipt{Value: raw}
	}
	return externalToolReceipt{Error: "tool_unavailable"}
}
