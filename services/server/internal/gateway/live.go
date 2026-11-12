package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/whippet/whippet/services/server/internal/server"
)

type LiveGateway struct{ Hub *server.LiveHub }

func sameLiveOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	return err == nil && (origin.Scheme == "http" || origin.Scheme == "https") && strings.EqualFold(origin.Host, r.Host)
}

func upgradeLive(w http.ResponseWriter, r *http.Request, viewer bool) (*websocket.Conn, error) {
	upgrader := websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: 4096, HandshakeTimeout: 5 * time.Second,
		CheckOrigin: func(r *http.Request) bool { return !viewer || sameLiveOrigin(r) },
		Error: func(w http.ResponseWriter, _ *http.Request, status int, _ error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": "live_upgrade_failed", "message": "Valid same-origin live WebSocket required."}})
		},
	}
	return upgrader.Upgrade(w, r, nil)
}

type liveWriter interface {
	SetWriteDeadline(time.Time) error
	EnableWriteCompression(bool)
	WriteMessage(int, []byte) error
	Close() error
}

func writeLiveJSON(conn liveWriter, message server.LiveMessage) error {
	data, err := json.Marshal(message)
	if err != nil {
		return err
	}
	if err := conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return err
	}
	conn.EnableWriteCompression(false)
	return conn.WriteMessage(websocket.TextMessage, data)
}

func rejectLive(conn *websocket.Conn, err error) {
	message := server.LiveMessage{Type: "error", Code: "unavailable", Message: "Live connection unavailable."}
	var liveErr *server.LiveError
	if errors.As(err, &liveErr) {
		message.Code, message.Message = liveErr.Code, liveErr.Message
	}
	_ = writeLiveJSON(conn, message)
}

func (g *LiveGateway) Viewer(w http.ResponseWriter, r *http.Request) {
	if !server.ValidID(r.PathValue("id")) {
		http.Error(w, "invalid Run ID", http.StatusBadRequest)
		return
	}
	conn, err := upgradeLive(w, r, true)
	if err != nil {
		return
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	session, err := g.Hub.OpenViewer(ctx, r.PathValue("id"))
	cancel()
	if err != nil {
		rejectLive(conn, err)
		return
	}
	g.serve(conn, session, session.Viewer, false)
}

func (g *LiveGateway) Media(w http.ResponseWriter, r *http.Request) {
	id, attemptID, viewerID := r.PathValue("id"), r.URL.Query().Get("attemptId"), r.URL.Query().Get("viewerId")
	if !server.ValidID(id) || !server.ValidID(attemptID) || !server.ValidID(viewerID) {
		http.Error(w, "invalid live binding", http.StatusBadRequest)
		return
	}
	// API.ManagerAuth validates the bearer token before this handler is called.
	conn, err := upgradeLive(w, r, false)
	if err != nil {
		return
	}
	defer conn.Close()
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	session, endpoint, err := g.Hub.AttachMedia(ctx, id, attemptID, viewerID)
	cancel()
	if err != nil {
		rejectLive(conn, err)
		return
	}
	g.serve(conn, session, endpoint, true)
}

func (g *LiveGateway) serve(conn *websocket.Conn, session *server.LiveSession, endpoint *server.LiveEndpoint, media bool) {
	conn.SetReadLimit(server.MaxLiveFrameBytes)
	writerDone := make(chan struct{})
	go func() { defer close(writerDone); writeLive(conn, endpoint) }()
	for {
		_ = conn.SetReadDeadline(time.Now().Add(server.LiveLease))
		kind, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if kind == websocket.BinaryMessage {
			if media {
				err = g.Hub.Frame(session, endpoint, data)
			} else {
				err = &server.LiveError{Code: "unsupported", Message: "Viewer is read-only; binary input is not supported."}
			}
		} else if kind == websocket.TextMessage {
			var message server.LiveMessage
			if json.Unmarshal(data, &message) != nil {
				err = &server.LiveError{Code: "invalid_message", Message: "Invalid live JSON."}
			} else if media {
				err = g.Hub.MediaMessage(session, endpoint, message)
			} else {
				err = g.Hub.ViewerMessage(session, message)
			}
		}
		if err != nil {
			g.Hub.FailViewer(session, err)
			break
		}
	}
	if media {
		g.Hub.CloseMedia(session, endpoint)
	} else {
		g.Hub.CloseViewer(session)
	}
	<-writerDone
}

// Each media/viewer connection owns one independent writer. Even a permanently
// slow viewer retains at most one latest JPEG and cannot block Engine or Manager WS.
func writeLive(conn liveWriter, endpoint *server.LiveEndpoint) {
	defer conn.Close()
	writeMessage := func(message server.LiveMessage) error {
		if err := writeLiveJSON(conn, message); err != nil {
			return err
		}
		endpoint.MessageWritten(message)
		return nil
	}
	for {
		select {
		case <-endpoint.Done:
			_ = writeLiveJSON(conn, endpoint.Final())
			return
		default:
		}
		// Signaling/pong take priority over the latest frame.
		select {
		case message := <-endpoint.Messages:
			if writeMessage(message) != nil {
				return
			}
			continue
		default:
		}
		select {
		case <-endpoint.Done:
			_ = writeLiveJSON(conn, endpoint.Final())
			return
		case message := <-endpoint.Messages:
			if writeMessage(message) != nil {
				return
			}
		case frame := <-endpoint.Frames:
			// A frame may win the blocking select just as complete is queued.
			// Drain signaling first; WriteFrame also fences its media epoch.
		drain:
			for {
				select {
				case message := <-endpoint.Messages:
					if writeMessage(message) != nil {
						return
					}
				default:
					break drain
				}
			}
			if endpoint.WriteFrame(frame, func(jpeg []byte) error {
				if err := conn.SetWriteDeadline(time.Now().Add(2 * time.Second)); err != nil {
					return err
				}
				conn.EnableWriteCompression(false)
				return conn.WriteMessage(websocket.BinaryMessage, jpeg)
			}) != nil {
				return
			}
		}
	}
}
