package gateway

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/whippet/whippet/services/server/internal/server"
)

type Gateway struct {
	Engine *server.Engine
	Log    *slog.Logger
}

type peer struct{ conn *websocket.Conn }

func (p *peer) Send(m server.Envelope) error {
	_ = p.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return p.conn.WriteJSON(m)
}

func (p *peer) Close() error { return p.conn.Close() }

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: 4096,
		Error: func(w http.ResponseWriter, _ *http.Request, status int, _ error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "websocket_upgrade_failed", "message": "valid WebSocket upgrade required"}})
		},
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(256 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	var hello server.Envelope
	if err := conn.ReadJSON(&hello); err != nil {
		return
	}
	var payload struct {
		Capacity int `json:"capacity"`
	}
	if server.ValidateEnvelope(hello) != nil || hello.Type != "hello" || json.Unmarshal(hello.Payload, &payload) != nil {
		g.reject(conn, "invalid hello")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	session, err := g.Engine.Attach(ctx, hello.ManagerID, payload.Capacity, &peer{conn})
	cancel()
	if err != nil {
		g.Log.Warn("manager hello rejected", "managerId", hello.ManagerID, "error", err)
		g.reject(conn, "manager hello rejected")
		return
	}
	defer g.Engine.Detach(session)
	g.Log.Info("manager connected", "managerId", hello.ManagerID, "capacity", payload.Capacity)
	for {
		// Application heartbeats must arrive within 60 seconds, including idle periods.
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		var m server.Envelope
		if err := conn.ReadJSON(&m); err != nil {
			g.Log.Info("manager disconnected", "managerId", hello.ManagerID)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		err := g.Engine.Handle(ctx, session, m)
		cancel()
		if err != nil {
			g.Log.Warn("manager message rejected", "managerId", hello.ManagerID, "type", m.Type, "error", err)
			g.reject(conn, "manager message rejected")
			return
		}
	}
}

func (g *Gateway) reject(conn *websocket.Conn, message string) {
	// WriteControl can run concurrently with the Engine's single data writer.
	_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.ClosePolicyViolation, message), time.Now().Add(time.Second))
}
