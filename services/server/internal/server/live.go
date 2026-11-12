package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"time"
)

const LiveLease = 30 * time.Second
const MaxLiveFrameBytes = 1 << 20
const MaxLiveSDPBytes = 64 << 10

type ICEServer struct {
	URLs           json.RawMessage `json:"urls"`
	Username       string          `json:"username,omitempty"`
	Credential     string          `json:"credential,omitempty"`
	CredentialType string          `json:"credentialType,omitempty"`
}

// Errors deliberately omit configuration values, including TURN credentials.
func ParseICEServers(raw string) ([]ICEServer, error) {
	servers := []ICEServer{}
	if strings.TrimSpace(raw) == "" {
		return servers, nil
	}
	invalid := errors.New("invalid WHIPPET_LIVE_ICE_SERVERS configuration")
	if len(raw) > 64<<10 || json.Unmarshal([]byte(raw), &servers) != nil || servers == nil {
		return nil, invalid
	}
	for _, server := range servers {
		var single string
		var urls []string
		if json.Unmarshal(server.URLs, &single) == nil && single != "" {
			urls = []string{single}
		} else if json.Unmarshal(server.URLs, &urls) != nil || len(urls) == 0 {
			return nil, invalid
		}
		if server.CredentialType != "" && server.CredentialType != "password" {
			return nil, invalid
		}
		for _, url := range urls {
			if !(strings.HasPrefix(url, "stun:") || strings.HasPrefix(url, "stuns:") || strings.HasPrefix(url, "turn:") || strings.HasPrefix(url, "turns:")) {
				return nil, invalid
			}
		}
	}
	return servers, nil
}

type LiveTarget struct {
	RunID, TestID, WorkspaceID, ManagerID, AttemptID, Status string
}

func (t LiveTarget) active() bool {
	return !Terminal(t.Status) && t.ManagerID != "" && ValidID(t.AttemptID)
}

type LiveStore interface {
	LiveTarget(context.Context, string) (LiveTarget, error)
}

type LiveCommand struct {
	Type, ManagerEpoch, ViewerID string
	Target                       LiveTarget
	ICEServers                   []ICEServer
	OnError                      func(error)
}

type LiveController interface {
	LiveManagerEpoch(string) (string, bool)
	QueueLiveCommand(LiveCommand) error
}

type LiveMessage struct {
	mediaEpoch uint64       // Internal output barrier; never serialized on the wire.
	Type       string       `json:"type"`
	ViewerID   string       `json:"viewerId,omitempty"`
	ICEServers *[]ICEServer `json:"iceServers,omitempty"`
	State      string       `json:"state,omitempty"`
	Transport  string       `json:"transport,omitempty"`
	Reason     string       `json:"reason,omitempty"`
	SDP        string       `json:"sdp,omitempty"`
	OfferID    string       `json:"offerId,omitempty"`
	Mode       string       `json:"mode,omitempty"`
	Code       string       `json:"code,omitempty"`
	Message    string       `json:"message,omitempty"`
}

type LiveError struct{ Code, Message string }

func (e *LiveError) Error() string { return e.Message }

// LiveEndpoint has its own writer, bounded signaling, and a latest-frame slot.
// Channels are never closed: producers cannot panic when termination races a frame.
type LiveEndpoint struct {
	Messages      chan LiveMessage
	Frames        chan LiveFrame
	Done          chan struct{}
	mediaMu       sync.Mutex
	mediaEpoch    uint64
	mediaPaused   bool
	resumePending bool
	once          sync.Once
	final         LiveMessage
}

type LiveFrame struct {
	JPEG  []byte
	epoch uint64
}

func newLiveEndpoint() *LiveEndpoint {
	return &LiveEndpoint{Messages: make(chan LiveMessage, 16), Frames: make(chan LiveFrame, 1), Done: make(chan struct{})}
}

func (p *LiveEndpoint) send(message LiveMessage) bool {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	select {
	case <-p.Done:
		return false
	default:
	}
	if message.Type == "state" && message.State == "waiting" {
		switch message.Reason {
		case "sensitive_input":
			p.mediaEpoch++
			p.mediaPaused, p.resumePending = true, false
			select {
			case <-p.Frames:
			default:
			}
		case "sensitive_input_complete":
			p.mediaPaused, p.resumePending = false, true
		}
	}
	message.mediaEpoch = p.mediaEpoch
	select {
	case p.Messages <- message:
		return true
	default:
		return false
	}
}

// MessageWritten releases only the matching resume barrier after the actual
// viewer writer has sent it. An older complete cannot unlock a later pause.
func (p *LiveEndpoint) MessageWritten(message LiveMessage) {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	if message.Type == "state" && message.State == "waiting" && message.Reason == "sensitive_input_complete" && message.mediaEpoch == p.mediaEpoch && !p.mediaPaused {
		p.resumePending = false
	}
}

func (p *LiveEndpoint) frame(jpeg []byte) {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	if p.mediaPaused {
		return
	}
	frame := LiveFrame{JPEG: jpeg, epoch: p.mediaEpoch}
	select {
	case p.Frames <- frame:
		return
	default:
	}
	select {
	case <-p.Frames:
	default:
	}
	select {
	case p.Frames <- frame:
	default:
	}
}

// Serialize the last epoch check and bounded binary write with privacy state
// updates. Already in-flight bytes cannot be recalled; queued old frames drop.
func (p *LiveEndpoint) WriteFrame(frame LiveFrame, write func([]byte) error) error {
	p.mediaMu.Lock()
	defer p.mediaMu.Unlock()
	select {
	case <-p.Done:
		return nil
	default:
	}
	if p.mediaPaused || p.resumePending || frame.epoch != p.mediaEpoch {
		return nil
	}
	return write(frame.JPEG)
}

func (p *LiveEndpoint) close(final LiveMessage) {
	p.once.Do(func() { p.final = final; close(p.Done) })
}

// Final is read only after Done closes, which synchronizes publication.
func (p *LiveEndpoint) Final() LiveMessage { return p.final }

type LiveSession struct {
	Target           LiveTarget
	ViewerID         string
	Viewer           *LiveEndpoint
	managerEpoch     string
	media            *LiveEndpoint
	mode             string
	offerID          string // Last accepted ID; retained to reject its replay after invalidation.
	offerPending     bool
	offerPaused      bool
	offerIDsRequired bool
	legacyOfferSeen  bool
	expiresAt        time.Time
	jpegStarted      bool
}

type LiveHub struct {
	store      LiveStore
	controller LiveController
	ice        []ICEServer
	mu         sync.Mutex
	sessions   map[string]*LiveSession
	now        func() time.Time
}

func NewLiveHub(store LiveStore, controller LiveController, ice []ICEServer) *LiveHub {
	if ice == nil {
		ice = []ICEServer{}
	}
	return &LiveHub{store: store, controller: controller, ice: ice, sessions: map[string]*LiveSession{}, now: time.Now}
}

func (h *LiveHub) OpenViewer(ctx context.Context, runID string) (*LiveSession, error) {
	target, err := h.store.LiveTarget(ctx, runID)
	if err != nil {
		return nil, &LiveError{"not_found", "Run is unavailable."}
	}
	if !target.active() {
		return nil, &LiveError{"no_active_attempt", "Run has no active attempt."}
	}
	epoch, online := h.controller.LiveManagerEpoch(target.ManagerID)
	if !online {
		return nil, &LiveError{"unavailable", "Manager is offline or reconciling."}
	}
	h.mu.Lock()
	if h.sessions[runID] != nil {
		h.mu.Unlock()
		return nil, &LiveError{"busy", "This Run already has a viewer."}
	}
	s := &LiveSession{Target: target, ViewerID: NewID(), Viewer: newLiveEndpoint(), managerEpoch: epoch, mode: "webrtc", expiresAt: h.now().Add(LiveLease)}
	h.sessions[runID] = s
	s.Viewer.send(LiveMessage{Type: "ready", ViewerID: s.ViewerID, ICEServers: &h.ice})
	s.Viewer.send(LiveMessage{Type: "state", ViewerID: s.ViewerID, State: "waiting", Reason: "Waiting for live media."})
	h.mu.Unlock()
	command := LiveCommand{Type: "live.start", Target: target, ViewerID: s.ViewerID, ManagerEpoch: epoch, ICEServers: h.ice,
		OnError: func(error) {
			h.terminate(s, LiveMessage{Type: "state", State: "unavailable", Reason: "Live start is unavailable."})
		}}
	if err := h.controller.QueueLiveCommand(command); err != nil {
		h.terminate(s, LiveMessage{Type: "error", Code: "unavailable", Message: "Live control queue is busy."})
	}
	return s, nil
}

func (h *LiveHub) AttachMedia(ctx context.Context, runID, attemptID, viewerID string) (*LiveSession, *LiveEndpoint, error) {
	target, err := h.store.LiveTarget(ctx, runID)
	if err != nil || !target.active() || target.AttemptID != attemptID {
		return nil, nil, &LiveError{"invalid_binding", "Live attempt binding does not match."}
	}
	epoch, online := h.controller.LiveManagerEpoch(target.ManagerID)
	h.mu.Lock()
	s := h.sessions[runID]
	if !online || s == nil || s.ViewerID != viewerID || s.Target.AttemptID != attemptID || s.Target.ManagerID != target.ManagerID || s.managerEpoch != epoch || !h.now().Before(s.expiresAt) {
		h.mu.Unlock()
		return nil, nil, &LiveError{"invalid_binding", "Live viewer or Manager binding does not match."}
	}
	if s.media != nil {
		h.mu.Unlock()
		return nil, nil, &LiveError{"busy", "Media is already connected."}
	}
	media := newLiveEndpoint()
	s.media = media
	media.send(LiveMessage{Type: "mode", Mode: s.mode})
	ok := s.Viewer.send(LiveMessage{Type: "state", ViewerID: s.ViewerID, State: "connecting", Transport: s.mode})
	h.mu.Unlock()
	if !ok {
		h.terminate(s, LiveMessage{Type: "state", State: "unavailable", Reason: "Viewer signaling queue is full."})
	}
	return s, media, nil
}

func (h *LiveHub) ViewerMessage(s *LiveSession, message LiveMessage) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions[s.Target.RunID] != s || !h.now().Before(s.expiresAt) {
		return &LiveError{"expired", "Viewer lease expired."}
	}
	if message.ViewerID != "" && message.ViewerID != s.ViewerID {
		return &LiveError{"invalid_binding", "Viewer binding does not match."}
	}
	switch message.Type {
	case "ping":
		s.expiresAt = h.now().Add(LiveLease)
		if s.Viewer.send(LiveMessage{Type: "pong"}) {
			return nil
		}
	case "mode":
		if message.Mode != "webrtc" && message.Mode != "jpeg" {
			return &LiveError{"unsupported", "Unsupported live mode."}
		}
		if message.Mode != s.mode || s.offerPending || s.offerID != "" || s.legacyOfferSeen {
			s.offerPending, s.offerIDsRequired = false, true
		}
		s.mode, s.jpegStarted = message.Mode, false
		// Drop a JPEG left over from a previous mode before negotiating WebRTC.
		select {
		case <-s.Viewer.Frames:
		default:
		}
		if s.media == nil || s.media.send(LiveMessage{Type: "mode", Mode: message.Mode}) {
			return nil
		}
	case "answer":
		if len(message.SDP) == 0 || len(message.SDP) > MaxLiveSDPBytes {
			return &LiveError{"invalid_message", "Invalid live SDP."}
		}
		if message.OfferID != "" && !ValidID(message.OfferID) {
			return &LiveError{"invalid_message", "Invalid live offer ID."}
		}
		// Stale answers are expected across privacy pauses and mode changes.
		// Drop them without disconnecting a viewer that is awaiting a fresh offer.
		if s.mode != "webrtc" || s.offerPaused || !s.offerPending || message.OfferID != s.offerID || (s.offerIDsRequired && message.OfferID == "") {
			return nil
		}
		if s.media != nil && s.media.send(LiveMessage{Type: "answer", SDP: message.SDP, OfferID: message.OfferID}) {
			s.offerPending = false
			return nil
		}
	default:
		return &LiveError{"unsupported", "Live viewer supports ping, answer and mode only."}
	}
	return &LiveError{"unavailable", "Live signaling queue is unavailable."}
}

func (h *LiveHub) MediaMessage(s *LiveSession, media *LiveEndpoint, message LiveMessage) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions[s.Target.RunID] != s || s.media != media || !h.now().Before(s.expiresAt) {
		return &LiveError{"invalid_binding", "Media session is no longer active."}
	}
	switch message.Type {
	case "ping":
		// Media keepalive never renews the viewer's lease.
		if media.send(LiveMessage{Type: "pong"}) {
			return nil
		}
	case "offer":
		if len(message.SDP) == 0 || len(message.SDP) > MaxLiveSDPBytes {
			return &LiveError{"invalid_message", "Invalid live SDP."}
		}
		if message.OfferID != "" {
			if !ValidID(message.OfferID) {
				return &LiveError{"invalid_message", "Invalid live offer ID."}
			}
			s.offerIDsRequired = true
			if message.OfferID == s.offerID {
				return nil
			}
		} else if s.offerIDsRequired || s.legacyOfferSeen {
			return nil
		}
		if s.mode != "webrtc" || s.offerPaused {
			return nil
		}
		if s.Viewer.send(LiveMessage{Type: "offer", SDP: message.SDP, OfferID: message.OfferID}) {
			s.offerID, s.offerPending = message.OfferID, true
			s.legacyOfferSeen = s.legacyOfferSeen || message.OfferID == ""
			return nil
		}
	case "state":
		if message.State != "waiting" && message.State != "connecting" && message.State != "streaming" && message.State != "unavailable" && message.State != "ended" {
			return &LiveError{"invalid_message", "Invalid live state."}
		}
		if message.Transport != "" && message.Transport != "webrtc" && message.Transport != "jpeg" {
			return &LiveError{"invalid_message", "Invalid live transport."}
		}
		if len(message.Reason) > 512 {
			return &LiveError{"invalid_message", "Live reason exceeds limit."}
		}
		if message.OfferID != "" && !ValidID(message.OfferID) {
			return &LiveError{"invalid_message", "Invalid live offer ID."}
		}
		if message.State == "waiting" && message.Reason == "sensitive_input" {
			s.offerPending, s.offerIDsRequired = false, true
			s.offerPaused = true
		} else if message.State == "waiting" && message.Reason == "sensitive_input_complete" {
			s.offerPaused = false
		}
		// Resume is only a state event. It does not create/invalidate an offer.
		// Bind every relayed state to the trusted session, never Manager input.
		if s.Viewer.send(LiveMessage{Type: "state", ViewerID: s.ViewerID, State: message.State, Transport: message.Transport, Reason: message.Reason, OfferID: message.OfferID}) {
			return nil
		}
	default:
		return &LiveError{"unsupported", "Unsupported media message."}
	}
	return &LiveError{"unavailable", "Live signaling queue is full."}
}

func (h *LiveHub) Frame(s *LiveSession, media *LiveEndpoint, jpeg []byte) error {
	if len(jpeg) < 4 || len(jpeg) > MaxLiveFrameBytes || jpeg[0] != 0xff || jpeg[1] != 0xd8 || jpeg[len(jpeg)-2] != 0xff || jpeg[len(jpeg)-1] != 0xd9 {
		return &LiveError{"invalid_frame", "Invalid or oversized JPEG frame."}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.sessions[s.Target.RunID] != s || s.media != media || !h.now().Before(s.expiresAt) {
		return &LiveError{"invalid_binding", "Media session is no longer active."}
	}
	if s.mode != "jpeg" {
		return nil
	}
	if !s.jpegStarted {
		if !s.Viewer.send(LiveMessage{Type: "state", ViewerID: s.ViewerID, State: "streaming", Transport: "jpeg"}) {
			return &LiveError{"unavailable", "Viewer signaling queue is full."}
		}
		s.jpegStarted = true
	}
	s.Viewer.frame(jpeg)
	return nil
}

func (h *LiveHub) terminate(s *LiveSession, final LiveMessage) {
	h.mu.Lock()
	if h.sessions[s.Target.RunID] != s {
		h.mu.Unlock()
		return
	}
	delete(h.sessions, s.Target.RunID)
	if final.Type == "state" {
		final.ViewerID = s.ViewerID
	}
	s.Viewer.close(final)
	if s.media != nil {
		s.media.close(final)
	}
	h.mu.Unlock()
	// Best effort stop plus media close; Runtime also has its own expiry lease.
	_ = h.controller.QueueLiveCommand(LiveCommand{Type: "live.stop", Target: s.Target, ViewerID: s.ViewerID, ManagerEpoch: s.managerEpoch})
}

func (h *LiveHub) CloseViewer(s *LiveSession) {
	h.terminate(s, LiveMessage{Type: "state", State: "ended", Reason: "Viewer disconnected."})
}

func (h *LiveHub) FailViewer(s *LiveSession, err error) {
	var liveErr *LiveError
	if errors.As(err, &liveErr) {
		h.terminate(s, LiveMessage{Type: "error", Code: liveErr.Code, Message: liveErr.Message})
		return
	}
	h.terminate(s, LiveMessage{Type: "state", State: "unavailable", Reason: "Live session unavailable."})
}

func (h *LiveHub) CloseMedia(s *LiveSession, media *LiveEndpoint) {
	h.mu.Lock()
	current := h.sessions[s.Target.RunID] == s && s.media == media
	h.mu.Unlock()
	if current {
		h.terminate(s, LiveMessage{Type: "state", State: "unavailable", Reason: "Media disconnected."})
	}
}

func (h *LiveHub) EndRun(runID string) {
	h.mu.Lock()
	s := h.sessions[runID]
	h.mu.Unlock()
	if s != nil {
		h.terminate(s, LiveMessage{Type: "state", State: "ended", Reason: "Run ended."})
	}
}

func (h *LiveHub) ManagerLost(managerID, epoch string) {
	for _, s := range h.snapshot() {
		if s.Target.ManagerID == managerID && s.managerEpoch == epoch {
			h.terminate(s, LiveMessage{Type: "state", State: "unavailable", Reason: "Manager disconnected."})
		}
	}
}

func (h *LiveHub) snapshot() []*LiveSession {
	h.mu.Lock()
	defer h.mu.Unlock()
	items := make([]*LiveSession, 0, len(h.sessions))
	for _, s := range h.sessions {
		items = append(items, s)
	}
	return items
}

func (h *LiveHub) Sweep(ctx context.Context, now time.Time) {
	for _, s := range h.snapshot() {
		h.mu.Lock()
		expired := !now.Before(s.expiresAt)
		h.mu.Unlock()
		if expired {
			h.terminate(s, LiveMessage{Type: "state", State: "ended", Reason: "Viewer lease expired."})
			continue
		}
		queryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		target, err := h.store.LiveTarget(queryCtx, s.Target.RunID)
		cancel()
		if err != nil || target.AttemptID != s.Target.AttemptID || target.ManagerID != s.Target.ManagerID {
			h.terminate(s, LiveMessage{Type: "state", State: "unavailable", Reason: "Live binding is no longer available."})
		} else if Terminal(target.Status) {
			h.terminate(s, LiveMessage{Type: "state", State: "ended", Reason: "Run ended."})
		}
	}
}

func (h *LiveHub) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	defer h.Close()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			h.Sweep(ctx, now)
		}
	}
}

func (h *LiveHub) Close() {
	for _, s := range h.snapshot() {
		h.terminate(s, LiveMessage{Type: "state", State: "ended", Reason: "Live service stopped."})
	}
}
