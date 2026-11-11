package manager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

func (m *Manager) cancelAttempt(ctx context.Context, env Envelope) error {
	if err := m.validateCommand(env); err != nil {
		return err
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(env.Payload, &payload) != nil || payload == nil || len(payload) != 0 {
		return errors.New("cancel requires an empty object payload")
	}
	m.mu.Lock()
	r, found := m.records[env.AttemptID]
	if found && r.RunID != env.RunID {
		m.mu.Unlock()
		return errors.New("cancel runId does not match attemptId")
	}
	if found && r.Phase == "complete" {
		m.mu.Unlock()
		return m.sendResult(r)
	}
	if !found {
		// Server may cancel a dispatch whose delivery/ACK was lost. Keep a
		// tombstone so a late dispatch can never execute this cancelled attempt.
		r = record{RunID: env.RunID, AttemptID: env.AttemptID, Phase: "accepted", ResultMessageID: newID()}
	}
	if !r.CancelRequested {
		r.CancelRequested = true
		if err := atomicJSON(m.journalPath(r), r); err != nil {
			m.mu.Unlock()
			return fmt.Errorf("persist cancellation before stopping Worker: %w", err)
		}
		m.records[r.AttemptID] = r
	}
	if cancel := m.controls[r.AttemptID]; cancel != nil {
		cancel()
	}
	m.mu.Unlock()
	if !found {
		m.startAttempt(ctx, r, nil)
	}
	return nil
}
