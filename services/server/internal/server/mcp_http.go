package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type agentAuthContextKey struct{}
type agentAuthContext struct {
	secret string
	token  AgentToken
}
type mcpAuditStateKey struct{}
type mcpAuditState struct{ failed bool }

const maxMCPHTTPBodyBytes = 1100 << 10

var mcpExposedTools = []string{
	"catalog_search", "catalog_get",
	"browser_session_open", "browser_session_status", "browser_session_close",
	"browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login",
	"task_claim", "task_heartbeat", "task_tool_call", "task_submit",
	"draft_create", "draft_get", "author_start", "validation_request", "validation_report",
}

func mcpToolConnected(tool ToolDefinition) bool {
	switch tool.Name {
	case "catalog_search", "catalog_get", "browser_session_status":
		return tool.Side == "server" && tool.Effect == "read"
	case "browser_session_open", "browser_session_close":
		return tool.Side == "server" && tool.Effect == "queue"
	case "browser_navigate", "browser_snapshot", "browser_click", "browser_fill", "browser_login":
		return tool.Side == "worker" && tool.Effect == "browser"
	case "task_claim", "task_heartbeat", "task_tool_call", "task_submit":
		return tool.Side == "server" && tool.Effect == "queue"
	case "draft_create", "author_start", "validation_request":
		return tool.Side == "server" && tool.Effect == "queue"
	case "draft_get", "validation_report":
		return tool.Side == "server" && tool.Effect == "read"
	}
	return false
}

func (a *API) newMCPHandler() http.Handler {
	p, ok := a.store.(*Postgres)
	if !ok {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusServiceUnavailable, "disabled", "MCP unavailable")
		})
	}
	registry, err := loadToolRegistry()
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusServiceUnavailable, "disabled", "MCP unavailable")
		})
	}
	for _, name := range mcpExposedTools {
		tool, found := registry.tool(name)
		if !found || !mcpToolConnected(tool) {
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeError(w, http.StatusServiceUnavailable, "disabled", "MCP unavailable")
			})
		}
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "whippet", Version: "0.11"}, nil)
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			if method != "tools/call" {
				return next(ctx, method, request)
			}
			auth, ok := ctx.Value(agentAuthContextKey{}).(agentAuthContext)
			if !ok {
				return nil, ErrHistoryUnavailable
			}
			name := "unknown"
			if params, ok := request.GetParams().(*mcp.CallToolParamsRaw); ok {
				for _, exposed := range mcpExposedTools {
					if params.Name == exposed {
						name = exposed
						break
					}
				}
			}
			if name == "unknown" {
				if auditErr := p.RecordAgentToolAudit(ctx, auth.token, name, "denied"); auditErr != nil {
					return nil, ErrHistoryUnavailable
				}
				return mcpToolError(), nil
			}
			state := &mcpAuditState{}
			result, err := next(context.WithValue(ctx, mcpAuditStateKey{}, state), method, request)
			decision := "allowed"
			if err != nil {
				decision = "failed"
			} else if toolResult, ok := result.(*mcp.CallToolResult); ok && toolResult.IsError {
				decision = "denied"
			}
			if state.failed {
				decision = "failed"
			}
			if auditErr := p.RecordAgentToolAudit(ctx, auth.token, name, decision); auditErr != nil {
				return nil, ErrHistoryUnavailable
			}
			return result, err
		}
	})
	for _, name := range mcpExposedTools {
		tool, found := registry.tool(name)
		if !found {
			continue
		}
		definition := tool
		server.AddTool(&mcp.Tool{Name: tool.Name, Description: tool.Description, InputSchema: tool.InputSchema}, func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return a.callMCPTool(ctx, p, definition, request)
		})
	}
	if !addMCPResources(server, registry, a, p) {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			writeError(w, http.StatusServiceUnavailable, "disabled", "MCP unavailable")
		})
	}
	sdk := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if a.adminToken == "" {
			writeError(w, http.StatusServiceUnavailable, "disabled", "MCP is disabled")
			return
		}
		if !a.mcpOriginAllowed(r) {
			writeError(w, http.StatusForbidden, "forbidden", "origin not allowed")
			return
		}
		if len(r.Header.Values("X-Whippet-Admin-Token")) != 0 {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Agent bearer token required")
			return
		}
		headers := r.Header.Values("Authorization")
		if len(headers) != 1 || !strings.HasPrefix(headers[0], "Bearer ") {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Agent bearer token required")
			return
		}
		secret := strings.TrimPrefix(headers[0], "Bearer ")
		if secret == "" || secret == a.token || secret == a.adminToken {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Agent bearer token required")
			return
		}
		token, err := p.AuthorizeAgentToken(r.Context(), secret)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Agent bearer token required")
			return
		}
		if !a.agentLimiter.allow(token.ID, time.Now()) {
			_ = p.RecordAgentToolAudit(r.Context(), token, "unknown", "rate_limited")
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Agent rate limit exceeded")
			return
		}
		if r.Method == http.MethodPost {
			if r.ContentLength > maxMCPHTTPBodyBytes {
				writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "MCP request exceeds limit")
				return
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMCPHTTPBodyBytes))
			if err != nil {
				writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "MCP request exceeds limit")
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		ctx := context.WithValue(r.Context(), agentAuthContextKey{}, agentAuthContext{secret: secret, token: token})
		sdk.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *API) mcpOriginAllowed(r *http.Request) bool {
	origins := r.Header.Values("Origin")
	return len(origins) == 0 || (len(origins) == 1 && a.publicOrigin != "" && origins[0] == a.publicOrigin)
}

func (a *API) recheckAgent(ctx context.Context, p *Postgres) (AgentToken, error) {
	auth, ok := ctx.Value(agentAuthContextKey{}).(agentAuthContext)
	if !ok {
		return AgentToken{}, ErrNotFound
	}
	token, err := p.AuthorizeAgentToken(ctx, auth.secret)
	if err != nil || token.ID != auth.token.ID || token.WorkspaceID != auth.token.WorkspaceID {
		return AgentToken{}, ErrNotFound
	}
	return token, nil
}

func mcpToolError() *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: "tool unavailable"}}}
}

func mcpToolFailure(ctx context.Context) *mcp.CallToolResult {
	if state, ok := ctx.Value(mcpAuditStateKey{}).(*mcpAuditState); ok {
		state.failed = true
	}
	return mcpToolError()
}

func (a *API) callMCPTool(ctx context.Context, p *Postgres, tool ToolDefinition, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	if req == nil || req.Params == nil || req.Params.Name != tool.Name {
		return mcpToolError(), nil
	}
	token, err := a.recheckAgent(ctx, p)
	if err != nil {
		return mcpToolError(), nil
	}
	if len(req.Params.Arguments) > tool.Limits.MaxInputBytes || strictJSONNoDuplicates(req.Params.Arguments) != nil {
		return mcpToolError(), nil
	}
	canonical, err := validateToolArguments(tool, req.Params.Arguments)
	if err != nil {
		return mcpToolError(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(tool.Limits.TimeoutMS)*time.Millisecond)
	defer cancel()
	if strings.HasPrefix(tool.Name, "browser_") {
		return a.callMCPBrowser(ctx, p, tool, token, req, canonical), nil
	}
	if strings.HasPrefix(tool.Name, "task_") {
		return a.callMCPTask(ctx, p, tool, token, canonical), nil
	}
	if tool.Name == "draft_create" || tool.Name == "draft_get" || tool.Name == "author_start" || tool.Name == "validation_request" || tool.Name == "validation_report" {
		return a.callMCPInteractive(ctx, p, tool, token, canonical), nil
	}
	var output any
	switch tool.Name {
	case "catalog_search":
		var tx *sql.Tx
		tx, err = p.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return mcpToolFailure(ctx), nil
		}
		defer tx.Rollback()
		output, err = searchToolCatalog(ctx, tx, token.WorkspaceID, canonical)
		if err == nil {
			err = tx.Commit()
		}
	case "catalog_get":
		var args struct {
			ModuleVersionID string `json:"moduleVersionId"`
		}
		if json.Unmarshal(canonical, &args) != nil {
			return mcpToolError(), nil
		}
		var testID, versionID, script, origin string
		var module json.RawMessage
		err = p.DB.QueryRowContext(ctx, `SELECT t.id,v.id,v.script,v.script_origin,v.module FROM test_versions v JOIN tests t ON t.id=v.test_id
			WHERE v.id=$1 AND t.workspace_id=$2 AND t.kind='module' AND t.published_version_id IS NOT NULL AND v.module IS NOT NULL`, args.ModuleVersionID, token.WorkspaceID).Scan(&testID, &versionID, &script, &origin, &module)
		if err == nil {
			output = map[string]any{"testId": testID, "versionId": versionID, "script": script, "scriptOrigin": origin, "module": module}
		}
	default:
		return mcpToolError(), nil
	}
	if err != nil {
		return mcpToolFailure(ctx), nil
	}
	data, err := json.Marshal(output)
	if err != nil || len(data) > tool.Limits.MaxOutputBytes {
		return mcpToolFailure(ctx), nil
	}
	var structured map[string]any
	if json.Unmarshal(data, &structured) != nil {
		return mcpToolFailure(ctx), nil
	}
	return &mcp.CallToolResult{StructuredContent: structured, Content: []mcp.Content{&mcp.TextContent{Text: string(data)}}}, nil
}
