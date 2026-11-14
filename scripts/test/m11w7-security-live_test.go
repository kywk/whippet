//go:build integration

// Isolated PostgreSQL and in-process signaling. No Docker, real media device,
// UI, or TLS-handshake evidence is implied by these tests.
package server

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestM11W7SecurityLiveAuthority(t *testing.T) {
	cases := []string{"valid", "wrong_session", "wrong_lease", "revoked_token", "scope", "revision", "epoch", "closing", "deadline"}
	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			f := w7NewFixture(t)
			session, lease, epoch := f.lease.SessionID, f.lease.LeaseID, f.control.liveEpoch
			switch tc {
			case "wrong_session":
				session = NewID()
			case "wrong_lease":
				lease = NewID()
			case "revoked_token":
				if f.p.RevokeAgentToken(f.ctx, f.workspace, f.token.ID) != nil {
					t.Fatal("token revoke fixture failed")
				}
			case "scope":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET scope_status='unconfirmed' WHERE id=$1`, f.workspace); err != nil {
					t.Fatal("scope fixture failed")
				}
			case "revision":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET authorization_revision=authorization_revision+1 WHERE id=$1`, f.workspace); err != nil {
					t.Fatal("revision fixture failed")
				}
			case "epoch":
				epoch = NewID()
			case "closing":
				if _, err := f.p.CloseBrowserLease(f.ctx, f.token, f.lease.SessionID, f.lease.LeaseID); err != nil {
					t.Fatal("closing fixture failed")
				}
			case "deadline":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE agent_browser_leases SET deadline_at=now()-interval '1 second' WHERE session_id=$1`, f.lease.SessionID); err != nil {
					t.Fatal("deadline fixture failed")
				}
			}
			target, err := f.p.BrowserSessionLiveTarget(f.ctx, session, lease)
			// Epoch is checked against the active control connection by the hub;
			// this DB lookup returns its stored epoch for that comparison.
			if tc == "epoch" {
				if err != nil || target.ManagerEpoch == epoch {
					t.Fatal("stored epoch did not expose stale binding")
				}
			} else if tc == "valid" {
				if err != nil || target.SessionID != session || target.LeaseID != lease || target.WorkspaceID != f.workspace || target.ManagerID != "w7-qa-manager" || target.ManagerEpoch != epoch {
					t.Fatal("valid live binding mismatch")
				}
			} else if !errors.Is(err, ErrNotFound) {
				t.Fatal("invalid live binding was not explicitly unavailable")
			}
			items, err := f.p.BrowserSessions(f.ctx, f.workspace, "w7-qa-manager", epoch)
			if err != nil {
				t.Fatal("session list failed")
			}
			want := 0
			if tc == "valid" || tc == "wrong_session" || tc == "wrong_lease" {
				want = 1
			}
			if len(items) != want {
				t.Fatalf("session list length %d, want %d", len(items), want)
			}
			if want == 1 && (items[0].SessionID != f.lease.SessionID || items[0].LeaseID != f.lease.LeaseID || items[0].State != "ready") {
				t.Fatal("session list binding mismatch")
			}
		})
	}
}

// Exercise the real HTTP auth/routing around stand-in live handlers; media
// identity and signaling are covered separately by the session hub checks.
func TestM11W7SecurityLiveHTTPGate(t *testing.T) {
	admin, manager, agent := NewID(), NewID(), NewID()
	reached := 0
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { reached++; w.WriteHeader(http.StatusNoContent) })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := NewAPI(nil, nil, nil, manager, log).WithAdminAccess(admin, "https://whippet.example").WithSessionLiveHandlers(handler, handler).Handler(nil)
	login := httptest.NewRequest(http.MethodPost, "https://whippet.example/api/dev-login", nil)
	login.Header.Set("X-Whippet-Admin-Token", admin)
	loginRec := httptest.NewRecorder()
	api.ServeHTTP(loginRec, login)
	cookies := loginRec.Result().Cookies()
	if loginRec.Code != 200 || len(cookies) != 1 {
		t.Fatal("management session fixture failed")
	}
	path := "/api/browser-sessions/" + NewID() + "/leases/" + NewID() + "/live"
	mediaPath := "/api/manager/browser-sessions/" + NewID() + "/leases/" + NewID() + "/live?viewerId=" + NewID()
	cases := []struct {
		name, path, bearer string
		cookie             bool
		origins            []string
		allow              bool
	}{
		{"viewer_valid", path, "", true, []string{"https://whippet.example"}, true},
		{"viewer_missing_cookie", path, "", false, []string{"https://whippet.example"}, false},
		{"viewer_missing_origin", path, "", true, nil, false},
		{"viewer_wrong_origin", path, "", true, []string{"https://evil.invalid"}, false},
		{"viewer_duplicate_origin", path, "", true, []string{"https://whippet.example", "https://whippet.example"}, false},
		{"viewer_agent_bearer", path, agent, true, []string{"https://whippet.example"}, false},
		{"media_manager", mediaPath, manager, false, nil, true},
		{"media_agent_bearer", mediaPath, agent, false, nil, false},
		{"media_cookie", mediaPath, "", true, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "https://whippet.example"+tc.path, nil)
			if tc.cookie {
				r.AddCookie(cookies[0])
			}
			if tc.bearer != "" {
				r.Header.Set("Authorization", "Bearer "+tc.bearer)
			}
			for _, origin := range tc.origins {
				r.Header.Add("Origin", origin)
			}
			before := reached
			rec := httptest.NewRecorder()
			api.ServeHTTP(rec, r)
			if tc.allow {
				if rec.Code != 204 || reached != before+1 {
					t.Fatalf("allowed gate failed: HTTP %d", rec.Code)
				}
			} else if (rec.Code != 401 && rec.Code != 403) || reached != before {
				t.Fatalf("gate rejection inconclusive: HTTP %d", rec.Code)
			}
		})
	}
}

func TestM11W7SecurityLiveViewerMedia(t *testing.T) {
	for _, tc := range []string{"revoke", "scope", "close", "deadline", "manager_epoch"} {
		t.Run(tc, func(t *testing.T) {
			f := w7NewFixture(t)
			hub := NewLiveHub(f.p, f.engine, nil)
			f.engine.SetLiveHub(hub)
			t.Cleanup(hub.Close)
			s, err := hub.OpenSessionViewer(f.ctx, f.lease.SessionID, f.lease.LeaseID)
			if err != nil || s.SessionTarget == nil || s.Target.RunID != "" || s.Target.AttemptID != "" || s.SessionTarget.WorkspaceID != f.workspace {
				t.Fatal("session viewer binding failed")
			}
			command := <-f.engine.liveCommands
			if command.Type != "session.live.start" || command.SessionTarget.SessionID != f.lease.SessionID || command.SessionTarget.LeaseID != f.lease.LeaseID || command.ViewerID != s.ViewerID || command.ManagerEpoch != f.control.liveEpoch {
				t.Fatal("session live start binding mismatch")
			}
			if err := f.engine.sendLiveCommand(f.ctx, command); err != nil {
				t.Fatal("session live start dispatch failed")
			}
			if _, err := hub.OpenSessionViewer(f.ctx, f.lease.SessionID, f.lease.LeaseID); err == nil {
				t.Fatal("second viewer accepted")
			}
			if _, _, err := hub.AttachSessionMedia(f.ctx, f.lease.SessionID, NewID(), s.ViewerID); err == nil {
				t.Fatal("wrong lease attached media")
			}
			if _, _, err := hub.AttachSessionMedia(f.ctx, f.lease.SessionID, f.lease.LeaseID, NewID()); err == nil {
				t.Fatal("wrong viewer attached media")
			}
			bound, media, err := hub.AttachSessionMedia(f.ctx, f.lease.SessionID, f.lease.LeaseID, s.ViewerID)
			if err != nil || bound != s || media == nil {
				t.Fatal("valid media attach failed")
			}
			if _, _, err := hub.AttachSessionMedia(f.ctx, f.lease.SessionID, f.lease.LeaseID, s.ViewerID); err == nil {
				t.Fatal("second media accepted")
			}
			if err := hub.ViewerMessage(s, LiveMessage{Type: "mode", Mode: "jpeg"}); err != nil {
				t.Fatal("JPEG mode failed")
			}
			jpeg := []byte{0xff, 0xd8, 0xff, 0xd9}
			if err := hub.Frame(s, media, jpeg); err != nil {
				t.Fatal("initial media frame failed")
			}
			var stale LiveFrame
			select {
			case stale = <-s.Viewer.Frames:
			default:
				t.Fatal("initial media frame missing")
			}
			if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", State: "waiting", Reason: "sensitive_input"}); err != nil {
				t.Fatal("sensitive pause failed")
			}
			written := false
			if err := s.Viewer.WriteFrame(stale, func([]byte) error { written = true; return nil }); err != nil || written {
				t.Fatal("stale frame escaped sensitive pause")
			}
			if err := hub.Frame(s, media, jpeg); err != nil {
				t.Fatal("paused frame handling failed")
			}
			select {
			case <-s.Viewer.Frames:
				t.Fatal("frame escaped sensitive pause")
			default:
			}
			switch tc {
			case "revoke":
				if f.p.RevokeAgentToken(f.ctx, f.workspace, f.token.ID) != nil {
					t.Fatal("revoke fixture failed")
				}
			case "scope":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET scope_status='unconfirmed' WHERE id=$1`, f.workspace); err != nil {
					t.Fatal("scope fixture failed")
				}
			case "close":
				if _, err := f.p.CloseBrowserLease(f.ctx, f.token, f.lease.SessionID, f.lease.LeaseID); err != nil {
					t.Fatal("close fixture failed")
				}
			case "deadline":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE agent_browser_leases SET deadline_at=now()-interval '1 second' WHERE session_id=$1`, f.lease.SessionID); err != nil {
					t.Fatal("deadline fixture failed")
				}
			case "manager_epoch":
				f.engine.mu.Lock()
				f.control.liveEpoch = NewID()
				f.engine.mu.Unlock()
			}
			hub.Sweep(f.ctx, time.Now())
			select {
			case <-s.Viewer.Done:
			default:
				t.Fatal("invalidated viewer remained open")
			}
			select {
			case <-media.Done:
			default:
				t.Fatal("invalidated media remained open")
			}
			if err := hub.Frame(s, media, jpeg); err == nil {
				t.Fatal("late media accepted after invalidation")
			}
			if _, _, err := hub.AttachSessionMedia(f.ctx, f.lease.SessionID, f.lease.LeaseID, s.ViewerID); err == nil {
				t.Fatal("late media reattached after invalidation")
			}
		})
	}
}
