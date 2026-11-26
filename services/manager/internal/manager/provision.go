package manager

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"
)

type provisionRequest struct {
	OperationID   string          `json:"operationId"`
	AgentID       string          `json:"agentId"`
	WorkspaceID   string          `json:"workspaceId"`
	SecretVersion int64           `json:"secretVersion"`
	Runtime       runtimeSnapshot `json:"runtime"`
	DeadlineAt    time.Time       `json:"deadlineAt"`
}

func (p *provisionRequest) UnmarshalJSON(raw []byte) error {
	fields, ok := uniqueBudgetFields(raw)
	type wire provisionRequest
	if !ok || len(fields) != 6 || fields["operationId"] == nil || fields["agentId"] == nil || fields["workspaceId"] == nil || fields["secretVersion"] == nil || fields["deadlineAt"] == nil ||
		!validRuntimeSnapshot(fields["runtime"]) || json.Unmarshal(raw, (*wire)(p)) != nil ||
		!uuidPattern.MatchString(p.OperationID) || !uuidPattern.MatchString(p.WorkspaceID) || !p.credential().valid() || p.DeadlineAt.IsZero() {
		return errProvision
	}
	p.DeadlineAt = p.DeadlineAt.UTC()
	return nil
}

func (p provisionRequest) credential() modelCredential {
	return modelCredential{AgentID: p.AgentID, SecretVersion: p.SecretVersion}
}

type probeOutcome struct {
	Status string  `json:"status"`
	Code   *string `json:"code"`
}

func (p probeOutcome) valid() bool {
	switch p.Status {
	case "succeeded", "cancelled":
		return p.Code == nil
	case "timed_out":
		return p.Code != nil && *p.Code == "probe_timed_out"
	case "failed":
		return p.Code != nil && slices.Contains([]string{"provider_auth_failed", "provider_unavailable", "probe_failed", "key_missing"}, *p.Code)
	}
	return false
}

func failedProbe(code string) probeOutcome { return probeOutcome{Status: "failed", Code: &code} }

func timedOutProbe() probeOutcome {
	code := "probe_timed_out"
	return probeOutcome{Status: "timed_out", Code: &code}
}

type provisionResult struct {
	OperationID string `json:"operationId"`
	probeOutcome
	Reclaimed bool `json:"reclaimed"`
}

type provisionRecord struct {
	OperationID     string            `json:"operationId"`
	Request         *provisionRequest `json:"request,omitempty"`
	CancelRequested bool              `json:"cancelRequested,omitempty"`
	Result          *provisionResult  `json:"result,omitempty"`
}

func (r provisionRecord) holdsSlot() bool {
	// A cancel delivered before provision has no local admission reservation.
	return r.Request != nil && (r.Result == nil || !r.Result.Reclaimed)
}

type provisionRuntime interface {
	Probe(context.Context, provisionRequest, string) probeOutcome
	RemoveProbe(context.Context, string) error
}

var errProvision = errors.New("invalid agent provision")

func provisionJournal(workDir string) string { return filepath.Join(workDir, "journal", "provisions") }

func loadProvisions(workDir string) (map[string]provisionRecord, error) {
	dir := provisionJournal(workDir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	records := make(map[string]provisionRecord)
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 16<<10 {
			return nil, errProvision
		}
		raw, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		var r provisionRecord
		if err != nil || json.Unmarshal(raw, &r) != nil || !uuidPattern.MatchString(r.OperationID) || entry.Name() != r.OperationID+".json" ||
			r.Request == nil && !r.CancelRequested || r.Request != nil && r.Request.OperationID != r.OperationID ||
			r.Result != nil && (r.Result.OperationID != r.OperationID || !r.Result.valid()) {
			return nil, errProvision
		}
		records[r.OperationID] = r
	}
	return records, nil
}

func (m *Manager) saveProvisionLocked(r provisionRecord) error {
	if err := atomicJSON(filepath.Join(provisionJournal(m.cfg.WorkDir), r.OperationID+".json"), r); err != nil {
		return err
	}
	m.provisions[r.OperationID] = r
	m.provisionSlots.update(r.OperationID, r.holdsSlot())
	return nil
}

func (m *Manager) acceptProvision(ctx, connectionCtx context.Context, env Envelope) error {
	var request provisionRequest
	if m.admin == nil || m.validateSessionEnvelope(env) != nil || len(env.Payload) > 16<<10 || json.Unmarshal(env.Payload, &request) != nil || m.currentKeySession() == nil {
		return errProvision
	}
	m.mu.Lock()
	if existing, exists := m.provisions[request.OperationID]; exists {
		m.mu.Unlock()
		if existing.Request != nil && *existing.Request != request {
			return errProvision
		}
		return m.reportProvision(existing.Result)
	}
	r := provisionRecord{OperationID: request.OperationID, Request: &request}
	if !request.DeadlineAt.After(time.Now()) {
		r.Result = &provisionResult{OperationID: r.OperationID, probeOutcome: timedOutProbe(), Reclaimed: true}
	} else if m.occupiedSlotsLocked() >= m.cfg.MaxWorkers || !slices.Contains(m.admin.Engines, request.Runtime.Engine) {
		r.Result = &provisionResult{OperationID: r.OperationID, probeOutcome: failedProbe("probe_failed"), Reclaimed: true}
	}
	if err := m.saveProvisionLocked(r); err != nil {
		m.mu.Unlock()
		return errProvision
	}
	if r.Result != nil {
		m.mu.Unlock()
		return m.reportProvision(r.Result)
	}
	deadline := time.Now().Add(30 * time.Second)
	if request.DeadlineAt.Before(deadline) {
		deadline = request.DeadlineAt
	}
	probeCtx, cancel := context.WithDeadline(connectionCtx, deadline)
	m.provisionControls[r.OperationID] = cancel
	m.wg.Add(1)
	m.mu.Unlock()
	m.requestHeartbeat()
	go func() {
		defer m.wg.Done()
		defer cancel()
		outcome := failedProbe("probe_failed")
		if probeCtx.Err() == nil {
			outcome = m.provisionRuntime.Probe(probeCtx, request, m.provisionDir(r.OperationID))
		}
		switch probeCtx.Err() {
		case context.DeadlineExceeded:
			outcome = timedOutProbe()
		case context.Canceled:
			outcome = probeOutcome{Status: "cancelled"}
		}
		m.finishProvision(ctx, r.OperationID, outcome)
	}()
	return nil
}

func (m *Manager) cancelProvision(ctx context.Context, env Envelope) error {
	var request struct {
		OperationID string `json:"operationId"`
	}
	if m.validateSessionEnvelope(env) != nil || !exactAdminFields(env.Payload, "operationId") || json.Unmarshal(env.Payload, &request) != nil || !uuidPattern.MatchString(request.OperationID) || m.currentKeySession() == nil {
		return errProvision
	}
	m.mu.Lock()
	r, exists := m.provisions[request.OperationID]
	if r.Result != nil || r.CancelRequested {
		m.mu.Unlock()
		return m.reportProvision(r.Result)
	}
	r.OperationID, r.CancelRequested = request.OperationID, true
	if err := m.saveProvisionLocked(r); err != nil {
		m.mu.Unlock()
		return errProvision
	}
	if cancel := m.provisionControls[r.OperationID]; cancel != nil {
		cancel()
	}
	m.mu.Unlock()
	if !exists {
		// Reconcile an unknown delivery before acknowledging reclaimed=true.
		m.recoverProvision(ctx, r.OperationID)
	}
	return nil
}

func (m *Manager) provisionDir(id string) string {
	return filepath.Join(m.cfg.WorkDir, "runs", "provision-"+id)
}

func (m *Manager) finishProvision(ctx context.Context, id string, outcome probeOutcome) {
	m.mu.Lock()
	delete(m.provisionControls, id)
	r := m.provisions[id]
	if r.Result != nil {
		outcome = r.Result.probeOutcome
	} else if r.CancelRequested && outcome.Status != "timed_out" {
		outcome = probeOutcome{Status: "cancelled"}
	}
	if !outcome.valid() {
		outcome = failedProbe("probe_failed")
	}
	pending := provisionResult{OperationID: id, probeOutcome: outcome}
	r.Result = &pending
	err := m.saveProvisionLocked(r)
	m.mu.Unlock()
	if err == nil {
		_ = m.reportProvision(&pending)
	}
	// Removal uses the service lifetime, even if the probe or WSS session ended.
	for {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		err = m.provisionRuntime.RemoveProbe(cleanupCtx, id)
		cancel()
		if err == nil {
			err = os.RemoveAll(m.provisionDir(id))
		}
		if err == nil {
			break
		}
		if !pause(ctx, 3*time.Second) {
			return
		}
	}
	final := pending
	final.Reclaimed = true
	for {
		m.mu.Lock()
		r = m.provisions[id]
		r.Result = &final
		err = m.saveProvisionLocked(r)
		m.mu.Unlock()
		if err == nil {
			_ = m.reportProvision(&final)
			return
		}
		if !pause(ctx, 3*time.Second) {
			return
		}
	}
}

func (m *Manager) reportProvision(result *provisionResult) error {
	if result == nil {
		m.requestHeartbeat()
		return nil
	}
	err := m.send(message(m.cfg.ManagerID, "agent.provision_result", "", "", result))
	if err == nil && result.Reclaimed {
		m.requestHeartbeat()
	}
	return err
}

func (m *Manager) recoverProvisions(ctx context.Context) {
	m.mu.Lock()
	ids := make([]string, 0, len(m.provisions))
	for id, r := range m.provisions {
		if r.Result == nil || !r.Result.Reclaimed {
			ids = append(ids, id)
		}
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.recoverProvision(ctx, id)
	}
}

func (m *Manager) recoverProvision(ctx context.Context, id string) {
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		m.finishProvision(ctx, id, probeOutcome{Status: "cancelled"})
	}()
}

func (m *Manager) replayProvisionResults() error {
	m.mu.Lock()
	results := make([]*provisionResult, 0, len(m.provisions))
	for _, r := range m.provisions {
		if r.Result != nil && r.Result.Reclaimed {
			results = append(results, r.Result)
		}
	}
	m.mu.Unlock()
	for _, result := range results {
		if err := m.reportProvision(result); err != nil {
			return err
		}
	}
	return nil
}
