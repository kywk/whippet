//go:build integration

// Real loopback HTTP/WebSocket gateway with synthetic authority; no TLS,
// browser UI, or Docker execution is implied.
package gateway

import (
	"context"
	"github.com/gorilla/websocket"
	"github.com/whippet/whippet/services/server/internal/server"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type w7GatewayStore struct {
	mu     sync.Mutex
	target server.BrowserSessionTarget
	active bool
}

func (*w7GatewayStore) LiveTarget(context.Context, string) (server.LiveTarget, error) {
	return server.LiveTarget{}, server.ErrNotFound
}
func (s *w7GatewayStore) BrowserSessionLiveTarget(_ context.Context, session, lease string) (server.BrowserSessionTarget, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.active || session != s.target.SessionID || lease != s.target.LeaseID {
		return server.BrowserSessionTarget{}, server.ErrNotFound
	}
	return s.target, nil
}

type w7GatewayControl struct{ epoch string }

func (c w7GatewayControl) LiveManagerEpoch(string) (string, bool)  { return c.epoch, true }
func (w7GatewayControl) QueueLiveCommand(server.LiveCommand) error { return nil }

func TestM11W7SecurityGatewayWebSockets(t *testing.T) {
	target := server.BrowserSessionTarget{SessionID: server.NewID(), LeaseID: server.NewID(), WorkspaceID: server.NewID(), ManagerID: "w7-manager", ManagerEpoch: server.NewID()}
	store := &w7GatewayStore{target: target, active: true}
	hub := server.NewLiveHub(store, w7GatewayControl{target.ManagerEpoch}, nil)
	defer hub.Close()
	manager, admin, agent := server.NewID(), server.NewID(), server.NewID()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	listener := httptest.NewUnstartedServer(nil)
	origin := "http://" + listener.Listener.Addr().String()
	gateway := &LiveGateway{Hub: hub}
	listener.Config.Handler = server.NewAPI(nil, nil, nil, manager, log).WithAdminAccess(admin, origin).WithSessionLiveHandlers(http.HandlerFunc(gateway.SessionViewer), http.HandlerFunc(gateway.SessionMedia)).Handler(nil)
	listener.Start()
	defer listener.Close()
	login, _ := http.NewRequest(http.MethodPost, origin+"/api/dev-login", nil)
	login.Header.Set("X-Whippet-Admin-Token", admin)
	response, err := listener.Client().Do(login)
	if err != nil {
		t.Fatal("management login request failed")
	}
	cookies := response.Cookies()
	response.Body.Close()
	if response.StatusCode != 200 || len(cookies) != 1 {
		t.Fatal("management session fixture failed")
	}
	viewerPath := "/api/browser-sessions/" + target.SessionID + "/leases/" + target.LeaseID + "/live"
	mediaPath := "/api/manager/browser-sessions/" + target.SessionID + "/leases/" + target.LeaseID + "/live?viewerId="
	wsbase := "ws" + strings.TrimPrefix(origin, "http")
	header := http.Header{"Origin": []string{origin}, "Cookie": []string{cookies[0].Name + "=" + cookies[0].Value}}
	dial := func(path string, h http.Header) (*websocket.Conn, *http.Response, error) {
		return websocket.DefaultDialer.Dial(wsbase+path, h)
	}
	viewer, resp, err := dial(viewerPath, header)
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		t.Fatal("valid viewer connection failed")
	}
	defer viewer.Close()
	_ = viewer.SetReadDeadline(time.Now().Add(3 * time.Second))
	var ready server.LiveMessage
	if viewer.ReadJSON(&ready) != nil || ready.Type != "ready" || !server.ValidID(ready.ViewerID) {
		t.Fatal("viewer ready binding failed")
	}
	denied := func(path string, h http.Header, code string) {
		t.Helper()
		conn, resp, err := dial(path, h)
		if err != nil {
			if resp != nil {
				resp.Body.Close()
			}
			t.Fatal("expected upgraded structured live denial")
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		var msg server.LiveMessage
		if conn.ReadJSON(&msg) != nil || msg.Type != "error" || msg.Code != code {
			t.Fatal("live denial was not explicit")
		}
	}
	denied(viewerPath, header, "busy")
	denied(mediaPath+server.NewID(), http.Header{"Authorization": []string{"Bearer " + manager}}, "invalid_binding")
	wrongPath := "/api/browser-sessions/" + target.SessionID + "/leases/" + server.NewID() + "/live"
	denied(wrongPath, header, "not_found")
	for _, tc := range []struct {
		path string
		h    http.Header
	}{{viewerPath, http.Header{"Origin": []string{origin}, "Cookie": []string{cookies[0].Name + "=" + cookies[0].Value}, "Authorization": []string{"Bearer " + agent}}}, {mediaPath + ready.ViewerID, http.Header{"Authorization": []string{"Bearer " + agent}}}} {
		conn, resp, err := dial(tc.path, tc.h)
		if conn != nil {
			conn.Close()
		}
		if err == nil || resp == nil || (resp.StatusCode != 401 && resp.StatusCode != 403) {
			if resp != nil {
				resp.Body.Close()
			}
			t.Fatal("Agent bearer reached live gateway")
		}
		resp.Body.Close()
	}
	media, resp, err := dial(mediaPath+ready.ViewerID, http.Header{"Authorization": []string{"Bearer " + manager}})
	if err != nil {
		if resp != nil {
			resp.Body.Close()
		}
		t.Fatal("bound media connection failed")
	}
	defer media.Close()
	_ = media.SetReadDeadline(time.Now().Add(3 * time.Second))
	var mode server.LiveMessage
	if media.ReadJSON(&mode) != nil || mode.Type != "mode" {
		t.Fatal("media mode missing")
	}
	store.mu.Lock()
	store.active = false
	store.mu.Unlock()
	hub.Sweep(context.Background(), time.Now())
	for _, conn := range []*websocket.Conn{viewer, media} {
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		closed := false
		for i := 0; i < 8; i++ {
			if _, _, err := conn.ReadMessage(); err != nil {
				closed = true
				break
			}
		}
		if !closed {
			t.Fatal("invalidated socket remained open")
		}
	}
}
