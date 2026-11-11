package manager

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"golang.org/x/net/websocket"
)

const maxLiveSDP = 128 << 10
const maxLiveJSON = 192 << 10
const maxLiveJPEG = 1 << 20

type liveStart struct {
	ViewerID string          `json:"viewerId"`
	ICE      json.RawMessage `json:"iceServers,omitempty"`
}
type liveSession struct {
	viewerID string
	cancel   context.CancelFunc
	done     chan struct{}
}
type liveControl struct {
	ViewerID string          `json:"viewerId"`
	Mode     string          `json:"mode"`
	Expires  int64           `json:"expiresAt"`
	ICE      json.RawMessage `json:"iceServers"`
	Answer   string          `json:"answer,omitempty"`
}
type liveWire struct {
	Type      string `json:"type"`
	State     string `json:"state,omitempty"`
	Transport string `json:"transport,omitempty"`
	Reason    string `json:"reason,omitempty"`
	SDP       string `json:"sdp,omitempty"`
	Mode      string `json:"mode,omitempty"`
}
type liveState struct {
	ViewerID  string `json:"viewerId"`
	State     string `json:"state"`
	Transport string `json:"transport"`
	Reason    string `json:"reason"`
	Offer     string `json:"offer"`
}

func validLiveICE(data json.RawMessage) bool {
	if len(data) > 32<<10 {
		return false
	}
	var servers []struct {
		URLs       json.RawMessage `json:"urls"`
		Username   string          `json:"username"`
		Credential string          `json:"credential"`
	}
	if json.Unmarshal(data, &servers) != nil || len(servers) > 8 {
		return false
	}
	for _, s := range servers {
		var urls []string
		var one string
		if json.Unmarshal(s.URLs, &one) == nil {
			urls = []string{one}
		} else if json.Unmarshal(s.URLs, &urls) != nil {
			return false
		}
		if len(urls) == 0 || len(urls) > 8 || len(s.Username) > 4096 || len(s.Credential) > 4096 {
			return false
		}
		for _, u := range urls {
			if len(u) > 4096 || !(strings.HasPrefix(u, "stun:") || strings.HasPrefix(u, "stuns:") || strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:")) {
				return false
			}
		}
	}
	return true
}

func (m *Manager) startLive(ctx context.Context, env Envelope) error {
	if err := m.validateCommand(env); err != nil {
		return err
	}
	var start liveStart
	if len(env.Payload) > maxLiveJSON || json.Unmarshal(env.Payload, &start) != nil || !uuidPattern.MatchString(start.ViewerID) {
		return errors.New("invalid live.start")
	}
	if len(start.ICE) == 0 {
		start.ICE = json.RawMessage(`[]`)
	}
	if !validLiveICE(start.ICE) {
		return errors.New("invalid live ICE configuration")
	}
	m.mu.Lock()
	r, exists := m.records[env.AttemptID]
	active := exists && r.RunID == env.RunID && r.holdsSlot() && (r.Phase == "accepted" || r.Phase == "running") && !r.CancelRequested
	m.mu.Unlock()
	if !active || r.Author != nil && !authorWantsBrowser(r.Author) {
		return errors.New("live attempt is not active")
	}
	m.liveMu.Lock()
	if m.live == nil {
		m.live = make(map[string]*liveSession)
	}
	previous := m.live[r.AttemptID]
	if previous != nil && previous.viewerID == start.ViewerID {
		m.liveMu.Unlock()
		return nil
	}
	if previous != nil {
		previous.cancel()
	}
	liveCtx, cancel := context.WithCancel(ctx)
	session := &liveSession{start.ViewerID, cancel, make(chan struct{})}
	m.live[r.AttemptID] = session
	m.wg.Add(1)
	m.liveMu.Unlock()
	go func() {
		defer m.wg.Done()
		defer cancel()
		defer close(session.done)
		defer func() {
			m.liveMu.Lock()
			if m.live[r.AttemptID] == session {
				delete(m.live, r.AttemptID)
			}
			m.liveMu.Unlock()
		}()
		// Prevent the old session's final lease revocation overwriting its successor.
		if previous != nil {
			select {
			case <-previous.done:
			case <-liveCtx.Done():
				return
			}
		}
		_ = m.mediaSession(liveCtx, r, start) // Media failure never changes Run result; no secrets/errors logged.
	}()
	return nil
}

func (m *Manager) stopLive(env Envelope) error {
	if err := m.validateCommand(env); err != nil {
		return err
	}
	var stop liveStart
	if json.Unmarshal(env.Payload, &stop) != nil || !uuidPattern.MatchString(stop.ViewerID) {
		return errors.New("invalid live.stop")
	}
	m.mu.Lock()
	r, found := m.records[env.AttemptID]
	m.mu.Unlock()
	if found && r.RunID != env.RunID {
		return errors.New("live Run mismatch")
	}
	m.liveMu.Lock()
	defer m.liveMu.Unlock()
	if session := m.live[env.AttemptID]; session != nil && session.viewerID == stop.ViewerID {
		session.cancel()
	}
	return nil
}

func (m *Manager) stopAttemptLive(attemptID string) {
	m.liveMu.Lock()
	defer m.liveMu.Unlock()
	if s := m.live[attemptID]; s != nil {
		s.cancel()
	}
}

func liveRead(root *os.Root, name string, limit int64) ([]byte, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("invalid live file")
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("live file limit exceeded")
	}
	return data, err
}

func writeLiveControl(root *os.Root, control liveControl) error {
	data, err := json.Marshal(control)
	if err != nil {
		return err
	}
	name := ".control-" + newID()
	f, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(name)
	_, err = f.Write(data)
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return root.Rename(name, "control.json")
}

func (m *Manager) mediaSession(ctx context.Context, r record, start liveStart) error {
	wsURL := "ws" + strings.TrimPrefix(m.cfg.ServerURL, "http") + "/api/manager/runs/" + r.RunID + "/live?attemptId=" + url.QueryEscape(r.AttemptID) + "&viewerId=" + url.QueryEscape(start.ViewerID)
	cfg, err := websocket.NewConfig(wsURL, m.cfg.ServerURL)
	if err != nil {
		return err
	}
	cfg.Header.Set("Authorization", "Bearer "+m.cfg.Token)
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, err := cfg.DialContext(dialCtx)
	cancel()
	if err != nil {
		return err
	}
	defer conn.Close()
	conn.MaxPayloadBytes = maxLiveJSON
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	incoming := make(chan liveWire, 8)
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			_ = conn.SetReadDeadline(time.Now().Add(35 * time.Second))
			var v liveWire
			if websocket.JSON.Receive(conn, &v) != nil {
				return
			}
			select {
			case incoming <- v:
			case <-done:
				return
			default:
				return
			}
		}
	}()
	send := func(v any) error {
		_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
		return websocket.JSON.Send(conn, v)
	}
	var root *os.Root
	control := liveControl{ViewerID: start.ViewerID, Mode: "webrtc", ICE: start.ICE}
	defer func() {
		if root != nil {
			control.Expires = 0
			_ = writeLiveControl(root, control)
			root.Close()
		}
	}()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	nextLease, nextPing := time.Time{}, time.Time{}
	lastState, lastOffer := "", ""
	var lastFrameMod time.Time
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-readDone:
			return errors.New("live media disconnected")
		case v := <-incoming:
			switch v.Type {
			case "pong":
			case "answer":
				if control.Mode != "webrtc" || v.SDP == "" || len(v.SDP) > maxLiveSDP {
					return errors.New("invalid live answer")
				}
				control.Answer = v.SDP
				nextLease = time.Time{}
			case "mode":
				if v.Mode != "webrtc" && v.Mode != "jpeg" {
					return errors.New("invalid live mode")
				}
				if v.Mode != control.Mode {
					control.Mode = v.Mode
					control.Answer = ""
					nextLease = time.Time{}
					lastState, lastOffer = "", ""
					lastFrameMod = time.Time{}
				}
			default:
				return errors.New("unsupported live media message")
			}
		case now := <-ticker.C:
			m.mu.Lock()
			current := m.records[r.AttemptID]
			m.mu.Unlock()
			if !current.holdsSlot() || current.Phase == "collecting" || current.CancelRequested {
				_ = send(liveWire{Type: "state", State: "ended"})
				return nil
			}
			if !now.Before(nextPing) {
				if err := send(liveWire{Type: "ping"}); err != nil {
					return err
				}
				nextPing = now.Add(10 * time.Second)
			}
			if root == nil {
				taskRoot, err := os.OpenRoot(m.taskDir(r))
				if err != nil {
					continue
				} // start may arrive just before prepare.
				info, statErr := taskRoot.Lstat("live")
				if statErr == nil && info.IsDir() {
					root, _ = taskRoot.OpenRoot("live")
				}
				taskRoot.Close()
				if root == nil {
					continue
				}
			}
			if !now.Before(nextLease) {
				control.Expires = now.Add(30 * time.Second).UnixMilli()
				if err := writeLiveControl(root, control); err != nil {
					return err
				}
				nextLease = now.Add(5 * time.Second)
			}
			data, err := liveRead(root, "state.json", maxLiveJSON)
			var state liveState
			if err == nil && json.Unmarshal(data, &state) == nil && state.ViewerID == control.ViewerID && state.Transport == control.Mode {
				if state.Offer != "" && control.Mode == "webrtc" && state.Offer != lastOffer {
					if len(state.Offer) > maxLiveSDP {
						return errors.New("invalid live offer")
					}
					if err := send(liveWire{Type: "offer", SDP: state.Offer}); err != nil {
						return err
					}
					lastOffer = state.Offer
				}
				if string(data) != lastState {
					switch state.State {
					case "waiting", "connecting", "streaming", "unavailable", "ended":
					default:
						return errors.New("invalid live state")
					}
					// Never forward arbitrary script-authored error text.
					reason := ""
					if state.Reason == "no_page" || state.Reason == "media_failed" {
						reason = state.Reason
					}
					if control.Mode == "webrtc" && state.State == "streaming" {
						state.State = "connecting"
					}
					if err := send(liveWire{Type: "state", State: state.State, Transport: control.Mode, Reason: reason}); err != nil {
						return err
					}
					lastState = string(data)
				}
			}
			if control.Mode == "jpeg" {
				name := control.ViewerID + ".jpg"
				info, err := root.Lstat(name)
				if err != nil || info.ModTime().Equal(lastFrameMod) {
					continue
				}
				frame, err := liveRead(root, name, maxLiveJPEG)
				if err != nil || len(frame) < 4 || frame[0] != 0xff || frame[1] != 0xd8 || frame[len(frame)-2] != 0xff || frame[len(frame)-1] != 0xd9 {
					continue
				}
				_ = conn.SetWriteDeadline(time.Now().Add(3 * time.Second))
				if err := websocket.Message.Send(conn, frame); err != nil {
					return err
				}
				lastFrameMod = info.ModTime()
			}
		}
	}
}
