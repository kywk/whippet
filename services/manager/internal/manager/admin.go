package manager

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

type workerCapabilities struct {
	Version int      `json:"version"`
	Engines []string `json:"engines"`
	Skills  []string `json:"skills"`
}

type adminCapabilities struct {
	workerCapabilities
	WorkerRevision string `json:"workerRevision"`
}

var workerContentID = regexp.MustCompile(`^[a-f0-9]{64}$`)
var managerNonce = regexp.MustCompile(`^[a-f0-9]{32}$`)

func validWorkerCapabilities(c workerCapabilities) bool {
	return c.Version == 1 && validCapabilityList(c.Engines, []string{"builtin", "vercel", "pi"}) &&
		validCapabilityList(c.Skills, []string{"test-author", "workspace-author", "acceptance-summary", "module-authoring", "usecase-planner"})
}

func validCapabilityList(values, allowed []string) bool {
	if len(values) == 0 || len(values) > len(allowed) {
		return false
	}
	for i, value := range values {
		if !slices.Contains(allowed, value) || slices.Contains(values[:i], value) {
			return false
		}
	}
	return true
}

func exactAdminFields(raw json.RawMessage, keys ...string) bool {
	fields, ok := uniqueBudgetFields(raw)
	if !ok || len(fields) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func inspectWorkerCapabilities(ctx context.Context, image string) *adminCapabilities {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := dockerCommand(ctx, "image", "inspect", "--format", `{{.Id}} {{index .Config.Labels "org.whippet.worker.admin"}}`, "--", image).Output()
	if err != nil {
		return nil
	}
	id, label, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	revision, ok := strings.CutPrefix(id, "sha256:")
	var caps workerCapabilities
	if !ok || !workerContentID.MatchString(revision) || len(label) > 2048 || !exactAdminFields(json.RawMessage(label), "version", "engines", "skills") ||
		json.Unmarshal([]byte(label), &caps) != nil || !validWorkerCapabilities(caps) {
		return nil
	}
	return &adminCapabilities{workerCapabilities: caps, WorkerRevision: revision}
}

func (m *Manager) configureAdmin(ctx context.Context) {
	if !strings.HasPrefix(m.cfg.ServerURL, "https://") {
		return
	}
	docker, ok := m.docker.(dockerCLI)
	if !ok {
		return
	}
	m.admin = inspectWorkerCapabilities(ctx, docker.cfg.WorkerImage)
	if m.admin == nil {
		return
	}
	// A moved tag cannot change the image behind the advertised revision.
	docker.cfg.WorkerImage = "sha256:" + m.admin.WorkerRevision
	m.docker, m.provisionRuntime = docker, docker
	if runtime, ok := m.sessionsRuntime.(*dockerSessionRuntime); ok {
		runtime.cfg.WorkerImage = docker.cfg.WorkerImage
	}
}

type modelKeySession struct {
	ctx   context.Context
	nonce string
}

func (m *Manager) acceptAdminAck(ctx context.Context, conn *websocket.Conn, raw json.RawMessage) error {
	if m.admin == nil {
		return nil
	}
	var ack struct {
		Admin json.RawMessage `json:"admin"`
	}
	if exactAdminFields(raw) && m.currentKeySession() == nil {
		return nil // An older Server can continue serving legacy work.
	}
	var payload struct {
		ConnectionNonce string `json:"connectionNonce"`
	}
	if !exactAdminFields(raw, "admin") || json.Unmarshal(raw, &ack) != nil || !exactAdminFields(ack.Admin, "connectionNonce") ||
		json.Unmarshal(ack.Admin, &payload) != nil || !managerNonce.MatchString(payload.ConnectionNonce) {
		return errors.New("invalid manager heartbeat acknowledgement")
	}
	m.connMu.Lock()
	defer m.connMu.Unlock()
	if m.conn != conn || m.keySession != nil && m.keySession.nonce != payload.ConnectionNonce {
		return errors.New("invalid manager connection nonce")
	}
	if m.keySession == nil {
		m.keySession = &modelKeySession{ctx: ctx, nonce: payload.ConnectionNonce}
	}
	return nil
}

func (m *Manager) currentKeySession() *modelKeySession {
	m.connMu.Lock()
	defer m.connMu.Unlock()
	if m.keySession == nil || m.keySession.ctx.Err() != nil {
		return nil
	}
	return m.keySession
}

func (m *Manager) supportsManagedDispatch(d Dispatch) bool {
	if m.admin == nil || d.Author == nil || d.Author.SkillID == nil || m.currentKeySession() == nil {
		return false
	}
	var runtime runtimeSnapshot
	return json.Unmarshal(d.Author.Runtime, &runtime) == nil && slices.Contains(m.admin.Engines, runtime.Engine) && slices.Contains(m.admin.Skills, *d.Author.SkillID)
}
