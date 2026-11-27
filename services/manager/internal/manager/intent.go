package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

type managerIntentProvider struct {
	client              *http.Client
	baseURL, model, key string
}

func intentSetting(name, fallback string) string {
	if value := os.Getenv("WHIPPET_AUTHOR_INTENT_" + name); value != "" {
		return value
	}
	return os.Getenv(fallback)
}

func loadIntentProvider() *managerIntentProvider {
	if os.Getenv("WHIPPET_AI_ENABLED") != "true" && os.Getenv("WHIPPET_AUTHOR_INTENT_API_KEY") == "" {
		return nil
	}
	base := strings.TrimRight(intentSetting("BASE_URL", "WHIPPET_AI_BASE_URL"), "/")
	u, err := url.Parse(base)
	model, key := intentSetting("MODEL", "WHIPPET_AI_MODEL"), intentSetting("API_KEY", "OPENCODE_API_KEY")
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || model == "" || key == "" {
		return nil
	}
	client := &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if caFile := os.Getenv("WHIPPET_AUTHOR_INTENT_CA_FILE"); caFile != "" {
		config, err := pinnedTLSConfig(caFile)
		if err != nil {
			return nil
		}
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.TLSClientConfig = config
		client.Transport = transport
	}
	return &managerIntentProvider{client, base, model, key}
}

type intentMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type intentCandidate struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
}
type managerIntentInput struct {
	Mode       string            `json:"mode"`
	Earlier    []intentMessage   `json:"earlierConversation"`
	Latest     string            `json:"latestRequest"`
	Candidates []intentCandidate `json:"candidates,omitempty"`
}
type managerIntentRequest struct {
	RequestID    string             `json:"requestId"`
	Instructions string             `json:"instructions"`
	Input        managerIntentInput `json:"input"`
}

func (m *Manager) handleIntent(ctx context.Context, conn *websocket.Conn, slots chan struct{}, env Envelope) {
	var req managerIntentRequest
	if env.RunID != "" || env.AttemptID != "" || len(env.Payload) > 256<<10 || json.Unmarshal(env.Payload, &req) != nil || !uuidPattern.MatchString(req.RequestID) {
		return
	}
	send := func(reply string) {
		m.connMu.Lock()
		defer m.connMu.Unlock()
		if m.conn == conn && ctx.Err() == nil {
			err := writeManagerEnvelope(conn, message(m.cfg.ManagerID, "agent.intent_result", "", "", map[string]string{"requestId": req.RequestID, "reply": reply}))
			if err != nil {
				conn.Close()
			}
		}
	}
	select {
	case slots <- struct{}{}:
	default:
		send("unavailable")
		return
	}
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		defer func() { <-slots }()
		send(m.intent.decide(ctx, req))
	}()
}

func (p *managerIntentProvider) decide(ctx context.Context, r managerIntentRequest) string {
	if p == nil || r.Instructions == "" || r.Input.Latest == "" || strings.Contains(r.Instructions, p.key) || strings.Contains(r.Input.Mode, p.key) {
		return "unavailable"
	}
	if strings.Contains(r.Input.Latest, p.key) {
		return "refuse"
	}
	r.Input.Earlier = slices.DeleteFunc(r.Input.Earlier, func(m intentMessage) bool {
		return strings.Contains(m.Content, p.key) || strings.Contains(m.Role, p.key)
	})
	r.Input.Candidates = slices.DeleteFunc(r.Input.Candidates, func(c intentCandidate) bool {
		return strings.Contains(c.ID, p.key) || strings.Contains(c.Name, p.key) || strings.Contains(c.Description, p.key) || strings.Contains(strings.Join(c.Tags, "\n"), p.key)
	})
	input, _ := json.Marshal(r.Input)
	body, _ := json.Marshal(map[string]any{"instructions": r.Instructions, "input": string(input), "model": p.model, "tools": []any{}, "store": false, "reasoning": map[string]string{"effort": "low"}, "max_output_tokens": 1024})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/responses", bytes.NewReader(body))
	if err != nil {
		return "unavailable"
	}
	req.Header.Set("Authorization", "Bearer "+p.key)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-opencode-session", newID())
	res, err := p.client.Do(req)
	if err != nil {
		return "unavailable"
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "unavailable"
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 65537))
	if err != nil || len(raw) > 65536 {
		return "unavailable"
	}
	reply := intentReply(raw)
	if id, ok := strings.CutPrefix(reply, "similar:"); ok {
		if !uuidPattern.MatchString(id) || !slices.ContainsFunc(r.Input.Candidates, func(c intentCandidate) bool { return c.ID == id }) {
			return "unavailable"
		}
		return reply
	}
	switch reply {
	case "allow", "clarify", "refuse":
		return reply
	}
	return "unavailable"
}

func intentReply(raw []byte) string {
	var result struct {
		Status string
		Error  json.RawMessage
		Output []struct {
			Type    string
			Content []struct{ Type, Text string }
		}
		OutputText string `json:"output_text"`
	}
	if validateJSONObjectStrings(raw, func(string) error { return nil }) != nil || json.Unmarshal(raw, &result) != nil || result.Status != "completed" || len(result.Error) > 0 && string(result.Error) != "null" {
		return ""
	}
	reply := ""
	for _, item := range result.Output {
		if item.Type == "reasoning" {
			continue
		}
		if item.Type != "message" || len(item.Content) != 1 || item.Content[0].Type != "output_text" || reply != "" {
			return ""
		}
		reply = strings.TrimSpace(item.Content[0].Text)
		if reply == "" {
			return ""
		}
	}
	if reply == "" {
		return strings.TrimSpace(result.OutputText)
	}
	if result.OutputText != "" && strings.TrimSpace(result.OutputText) != reply {
		return ""
	}
	return reply
}
