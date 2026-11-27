package server

import (
	"context"
	"database/sql"

	"sync"
	"time"
)

type intentScope struct {
	tx          *sql.Tx
	workspaceID string
}
type intentScopeKey struct{}

func intentContext(ctx context.Context, tx *sql.Tx, workspaceID string) context.Context {
	return context.WithValue(ctx, intentScopeKey{}, intentScope{tx, workspaceID})
}

// Intent checks can run inside a queue claim while the dispatch mutex and
// database rows are locked. Replies use a separate, session-bound mailbox.
type managerIntentBroker struct {
	mu      sync.Mutex
	session *Session
	pending map[string]chan string
}

func (e *Engine) ManagerAuthorIntentGates() (AuthorIntentGate, NewTestReviewGate) {
	gate := authorIntentClient{manager: &e.intents}
	return gate.check, gate.reviewNewTest
}

func (b *managerIntentBroker) activate(s *Session) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.session == nil {
		b.session = s
		b.pending = make(map[string]chan string)
	}
}

func (b *managerIntentBroker) clear(s *Session) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if s != nil && s == b.session {
		for _, ch := range b.pending {
			close(ch)
		}
		b.session = nil
		b.pending = nil
	}
}

func (b *managerIntentBroker) request(ctx context.Context, instructions string, input any) (string, error) {
	scope, ok := ctx.Value(intentScopeKey{}).(intentScope)
	if !ok || scope.tx == nil || !ValidID(scope.workspaceID) {
		return "", ErrAuthorPolicy
	}
	b.mu.Lock()
	s := b.session
	b.mu.Unlock()
	if s == nil {
		return "", ErrAuthorPolicy
	}
	manager, err := readSiteAIManager(ctx, scope.tx, s.managerID, false)
	if err != nil || !manager.allows(scope.workspaceID) {
		return "", ErrAuthorPolicy
	}
	id := NewID()
	payload := struct {
		ID           string `json:"requestId"`
		Instructions string `json:"instructions"`
		Input        any    `json:"input"`
	}{id, instructions, input}
	frame := NewEnvelope("agent.intent", s.managerID, "", "", payload)
	if len(frame.Payload) > 256<<10 {
		return "", ErrAuthorPolicy
	}
	ch := make(chan string, 1)
	b.mu.Lock()
	if b.session != s || len(b.pending) >= 16 {
		b.mu.Unlock()
		return "", ErrAuthorPolicy
	}
	b.pending[id] = ch
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()
	if err := s.peer.Send(frame); err != nil {
		return "", ErrAuthorPolicy
	}
	timer := time.NewTimer(25 * time.Second)
	defer timer.Stop()
	select {
	case reply := <-ch:
		if reply == "" || reply == "unavailable" {
			return "", ErrAuthorPolicy
		}
		return reply, nil
	case <-ctx.Done():
		return "", ErrAuthorPolicy
	case <-timer.C:
		return "", ErrAuthorPolicy
	}
}

func (e *Engine) HandleIntentResult(s *Session, m Envelope) error {
	if ValidateEnvelope(m) != nil || m.Type != "agent.intent_result" || m.ManagerID != s.managerID || m.RunID != "" || m.AttemptID != "" || !s.authorIntent {
		return ErrInvalid
	}
	var result struct {
		ID    string `json:"requestId"`
		Reply string `json:"reply"`
	}
	if len(m.Payload) > 512 || decodeSiteAIJSON(m.Payload, &result) != nil || !ValidID(result.ID) || result.Reply == "" || len(result.Reply) > 64 {
		return ErrInvalid
	}
	b := &e.intents
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.session != s {
		return ErrConflict
	}
	if ch := b.pending[result.ID]; ch != nil {
		delete(b.pending, result.ID)
		ch <- result.Reply
	}
	return nil
}
