package manager

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type HistoryPin struct {
	MaxSequence string `json:"maxSequence"`
}
type historyRequest struct {
	Kind      string  `json:"kind"`
	RequestID string  `json:"requestId"`
	AttemptID string  `json:"attemptId"`
	Cursor    *string `json:"cursor"`
}
type historyItem struct {
	Sequence       string `json:"sequence"`
	Role           string `json:"role"`
	Content        string `json:"content"`
	OffsetBytes    int64  `json:"offsetBytes"`
	HasMoreContent bool   `json:"hasMoreContent"`
}
type historyPage struct {
	WorkspaceID      string        `json:"workspaceId"`
	TestID           *string       `json:"testId"`
	RunID            string        `json:"runId"`
	AttemptID        string        `json:"attemptId"`
	EditingSessionID *string       `json:"editingSessionId"`
	ConversationID   string        `json:"conversationId"`
	MaxSequence      string        `json:"maxSequence"`
	Items            []historyItem `json:"items"`
	NextCursor       *string       `json:"nextCursor"`
}
type historyReply struct {
	Kind      string       `json:"kind"`
	RequestID string       `json:"requestId"`
	AttemptID string       `json:"attemptId"`
	History   *historyPage `json:"history,omitempty"`
	Error     string       `json:"error,omitempty"`
}

var errHistory = errors.New("history_unavailable")

func historySequence(s string) (int64, bool) {
	if s == "" || len(s) > 19 || len(s) > 1 && s[0] == '0' {
		return 0, false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	n, e := strconv.ParseInt(s, 10, 64)
	return n, e == nil && n >= 0
}
func parseHistoryCursor(cursor *string, maximum string) (int64, int64, bool) {
	max, ok := historySequence(maximum)
	if !ok {
		return 0, 0, false
	}
	if cursor == nil {
		return max, 0, true
	}
	if len(*cursor) > 40 {
		return 0, 0, false
	}
	parts := strings.Split(*cursor, ":")
	if len(parts) != 2 {
		return 0, 0, false
	}
	seq, ok := historySequence(parts[0])
	offset, valid := historySequence(parts[1])
	return seq, offset, ok && valid && seq <= max && offset <= 9007199254740991
}
func historyAuthor(a *AuthorTask) bool {
	if a == nil || a.History == nil || a.SkillID == nil || a.AllowedTools == nil || (*a.SkillID != "test-author" && *a.SkillID != "workspace-author" && !moduleAuthor(a) && !plannerAuthor(a)) {
		return false
	}
	for _, tool := range *a.AllowedTools {
		if tool == "read_conversation_history" {
			return true
		}
	}
	return false
}
func validHistoryPage(raw []byte, r record, q historyRequest) (historyPage, error) {
	var page historyPage
	// Go's JSON decoder replaces malformed UTF-8, so check the original bytes.
	if !utf8.Valid(raw) || !historyAuthor(r.Author) || !exactWorkspaceObject(raw, "workspaceId", "testId", "runId", "attemptId", "editingSessionId", "conversationId", "maxSequence", "items", "nextCursor") {
		return page, errHistory
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&page) != nil || d.Decode(new(any)) != io.EOF {
		return page, errHistory
	}
	var test *string
	if json.Unmarshal(r.TestID, &test) != nil {
		return page, errHistory
	}
	if page.WorkspaceID != r.WorkspaceID || page.RunID != r.RunID || page.AttemptID != r.AttemptID || !sameHistoryID(page.TestID, test) || !sameHistoryID(page.EditingSessionID, r.Author.EditingSessionID) || page.ConversationID != r.Author.ConversationID || page.MaxSequence != r.Author.History.MaxSequence || page.Items == nil || len(page.Items) > 6 {
		return page, errHistory
	}
	seq, offset, ok := parseHistoryCursor(q.Cursor, page.MaxSequence)
	if !ok {
		return page, errHistory
	}
	var itemObjects []json.RawMessage
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if json.Unmarshal(fields["items"], &itemObjects) != nil {
		return page, errHistory
	}
	bytesUsed := 0
	for i, item := range page.Items {
		if !exactWorkspaceObject(itemObjects[i], "sequence", "role", "content", "offsetBytes", "hasMoreContent") {
			return page, errHistory
		}
		var itemFields map[string]json.RawMessage
		_ = json.Unmarshal(itemObjects[i], &itemFields)
		if bytes.Equal(itemFields["offsetBytes"], []byte("null")) || bytes.Equal(itemFields["hasMoreContent"], []byte("null")) {
			return page, errHistory
		}
		n, valid := historySequence(item.Sequence)
		if !valid || n == 0 || n > seq || item.OffsetBytes < 0 || item.OffsetBytes > 9007199254740991 || item.OffsetBytes != offset && n == seq || n < seq && (offset > 0 || item.OffsetBytes != 0) || item.Role != "user" && item.Role != "assistant" || item.Content == "" || !boundedAuthorText(item.Content, 8192, false) {
			return page, errHistory
		}
		bytesUsed += len(item.Content)
		if bytesUsed > 8192 || item.OffsetBytes+int64(len(item.Content)) > 9007199254740991 {
			return page, errHistory
		}
		if item.HasMoreContent {
			seq, offset = n, item.OffsetBytes+int64(len(item.Content))
		} else {
			seq, offset = n-1, 0
		}
	}
	if page.NextCursor != nil {
		n, o, valid := parseHistoryCursor(page.NextCursor, page.MaxSequence)
		if !valid || len(page.Items) == 0 || n > seq || o != offset && n == seq || n < seq && (offset > 0 || o != 0) {
			return page, errHistory
		}
	} else if len(page.Items) > 0 && page.Items[len(page.Items)-1].HasMoreContent {
		return page, errHistory
	}
	return page, nil
}
func sameHistoryID(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func readHistory(ctx context.Context, cfg Config, r record, q historyRequest, client *http.Client) (historyPage, error) {
	var page historyPage
	if !strings.HasPrefix(cfg.ServerURL, "https://") || !uuidPattern.MatchString(q.RequestID) || q.AttemptID != r.AttemptID || !historyAuthor(r.Author) {
		return page, errHistory
	}
	if _, _, ok := parseHistoryCursor(q.Cursor, r.Author.History.MaxSequence); !ok {
		return page, errHistory
	}
	body, _ := json.Marshal(struct {
		Cursor *string `json:"cursor"`
	}{q.Cursor})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.ServerURL+"/api/manager/runs/"+r.RunID+"/attempts/"+r.AttemptID+"/history", bytes.NewReader(body))
	if err != nil {
		return page, errHistory
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	isolated := *client
	isolated.CheckRedirect = func(*http.Request, []*http.Request) error { return errHistory }
	resp, err := isolated.Do(req)
	if err != nil {
		return page, errHistory
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !hasNoStore(resp.Header.Get("Cache-Control")) {
		return page, errHistory
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, credentialFrameLimit+1))
	if err != nil || len(raw) > credentialFrameLimit {
		return page, errHistory
	}
	return validHistoryPage(raw, r, q)
}

// Data, pending state, dedup and quota are independent of credentialChannel.
type historyChannel struct {
	ctx     context.Context
	cfg     Config
	r       record
	input   io.Writer
	client  *http.Client
	mu      sync.Mutex
	count   int
	pending bool
	seen    map[string]bool
}

func (c *historyChannel) reply(q historyRequest, page *historyPage) {
	reply := historyReply{Kind: "history_response", RequestID: q.RequestID, AttemptID: c.r.AttemptID, History: page}
	if page == nil {
		reply.Error = "history_unavailable"
	}
	data, err := json.Marshal(reply)
	if err == nil && len(data) <= credentialFrameLimit && c.ctx.Err() == nil {
		_, _ = c.input.Write(append(data, '\n'))
	}
}
func (c *historyChannel) handle(line string) bool {
	var kind struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal([]byte(line), &kind) != nil || kind.Kind != "history_request" {
		return false
	}
	// The legacy endpoint is only for wholly legacy snapshots, never fallback.
	if c.r.Author != nil && (len(c.r.Author.Skills) > 0 || len(c.r.Author.Budget) > 0 || len(c.r.Author.Model) > 0 || c.r.Author.ToolRegistryVersion != nil || c.r.Author.ToolRegistrySHA256 != nil) {
		return true
	}
	var q historyRequest
	d := json.NewDecoder(strings.NewReader(line))
	d.DisallowUnknownFields()
	if len(line) > credentialFrameLimit || d.Decode(&q) != nil || !exactWorkspaceObject([]byte(line), "kind", "requestId", "attemptId", "cursor") || !uuidPattern.MatchString(q.RequestID) || q.AttemptID != c.r.AttemptID {
		return true
	}
	c.mu.Lock()
	if c.seen == nil {
		c.seen = map[string]bool{}
	}
	if c.ctx.Err() != nil || c.seen[q.RequestID] {
		c.mu.Unlock()
		return true
	}
	c.count++
	if c.count > 4 || c.pending {
		c.mu.Unlock()
		c.reply(q, nil)
		return true
	}
	c.seen[q.RequestID] = true
	c.pending = true
	c.mu.Unlock()
	go func() {
		defer func() { c.mu.Lock(); c.pending = false; c.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(c.ctx, 15*time.Second)
		defer cancel()
		page, err := readHistory(ctx, c.cfg, c.r, q, c.client)
		if c.ctx.Err() != nil {
			return
		}
		if err != nil {
			c.reply(q, nil)
		} else {
			c.reply(q, &page)
		}
	}()
	return true
}

// Both dedicated handlers share one whole-frame write lock on Docker stdin.
type attemptInputWriter struct {
	mu     sync.Mutex
	ctx    context.Context
	input  io.Writer
	closed bool
}

func (w *attemptInputWriter) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed || w.ctx.Err() != nil {
		return 0, io.ErrClosedPipe
	}
	return w.input.Write(data)
}
func (w *attemptInputWriter) close() { w.mu.Lock(); defer w.mu.Unlock(); w.closed = true }
