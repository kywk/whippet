//go:build wsinterop

package gateway

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/whippet/whippet/services/server/internal/server"
	xwebsocket "golang.org/x/net/websocket"
)

// Uses the pinned Manager codec with a real HTTP upgrade and WebSocket frames.
// net.Pipe provides a full-duplex net.Conn without requiring a listening socket.
func TestPeerSendXNetLargePayload(t *testing.T) {
	pattern := "繁體🌏<>&\"\\\n"
	maximum := strings.Repeat(pattern, server.MaxScriptBytes/len(pattern)) + strings.Repeat("x", server.MaxScriptBytes%len(pattern))
	for _, tc := range []struct{ name, script string }{
		{"ascii_over_4kb", strings.Repeat("a", 4500)},
		{"unicode_over_4kb", strings.Repeat("中文🌏", 700)},
		{"escaped_unicode_2mib", maximum},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, client := interopConnection(t)
			runID, attemptID := server.NewID(), server.NewID()
			dispatch := server.NewEnvelope("dispatch", "interop-manager", runID, attemptID, struct {
				Kind      string `json:"kind"`
				Script    string `json:"script"`
				TimeoutMS int    `json:"timeoutMs"`
			}{"run", tc.script, 60000})
			retry := dispatch
			retry.MessageID = server.NewID()
			messages := []server.Envelope{dispatch, retry, server.NewEnvelope("heartbeat_ack", "interop-manager", "", "", struct{}{})}
			sent := make(chan error, 1)
			go func() {
				for _, message := range messages {
					if err := p.Send(message); err != nil {
						sent <- err
						return
					}
				}
				sent <- nil
			}()
			for i, expected := range messages {
				var got server.Envelope
				if err := xwebsocket.JSON.Receive(client, &got); err != nil {
					t.Fatalf("x/net JSON.Receive message %d (%s, script %d bytes): %v", i, expected.Type, len(tc.script), err)
				}
				if !reflect.DeepEqual(got, expected) {
					t.Fatalf("message %d changed payload or run/attempt identity", i)
				}
			}
			if err := <-sent; err != nil {
				t.Fatal(err)
			}
		})
	}
}

type pipeUpgradeResponse struct {
	*httptest.ResponseRecorder
	conn   net.Conn
	reader *bufio.Reader
}

func (w *pipeUpgradeResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.conn, bufio.NewReadWriter(w.reader, bufio.NewWriter(w.conn)), nil
}

func interopConnection(t *testing.T) (*peer, *xwebsocket.Conn) {
	t.Helper()
	serverConn, clientConn := net.Pipe()
	t.Cleanup(func() { _ = serverConn.Close(); _ = clientConn.Close() })
	_ = serverConn.SetDeadline(time.Now().Add(5 * time.Second))
	_ = clientConn.SetDeadline(time.Now().Add(5 * time.Second))
	type upgraded struct {
		conn *websocket.Conn
		err  error
	}
	ready := make(chan upgraded, 1)
	go func() {
		reader := bufio.NewReader(serverConn)
		request, err := http.ReadRequest(reader)
		if err != nil {
			ready <- upgraded{err: err}
			return
		}
		upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096}
		conn, err := upgrader.Upgrade(&pipeUpgradeResponse{httptest.NewRecorder(), serverConn, reader}, request, nil)
		ready <- upgraded{conn, err}
	}()
	config, err := xwebsocket.NewConfig("ws://whippet.test/api/manager/connect", "http://whippet.test")
	if err != nil {
		t.Fatal(err)
	}
	client, err := xwebsocket.NewClient(config, clientConn)
	if err != nil {
		t.Fatal(fmt.Errorf("x/net handshake: %w", err))
	}
	serverSide := <-ready
	if serverSide.err != nil {
		t.Fatal(serverSide.err)
	}
	client.MaxPayloadBytes = 6*server.MaxScriptBytes + 512*1024
	return &peer{conn: serverSide.conn}, client
}
