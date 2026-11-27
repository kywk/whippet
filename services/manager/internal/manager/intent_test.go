package manager

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"golang.org/x/net/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestManagerIntentWSS(t *testing.T) {
	const key = "fixture-intent-credential"
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Input, Instructions string
			Tools               []any
			Store               *bool
		}
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer "+key || json.NewDecoder(r.Body).Decode(&body) != nil || strings.Contains(body.Input, key) || body.Tools == nil || len(body.Tools) > 0 || body.Store == nil || *body.Store {
			t.Error("unexpected provider request")
			w.WriteHeader(400)
			return
		}
		respond := "allow"
		if strings.Contains(body.Input, "unclear") {
			respond = "clarify"
		}
		if strings.Contains(body.Input, "unrelated") {
			respond = "refuse"
		}
		fmt.Fprintf(w, `{"status":"completed","output_text":%q}`, respond)
	}))
	defer provider.Close()
	expected := []struct{ latest, reply string }{{"create workspace", "allow"}, {"unclear", "clarify"}, {"unrelated", "refuse"}, {key, "refuse"}}
	result := make(chan error, 1)
	server := httptest.NewTLSServer(websocket.Handler(func(c *websocket.Conn) {
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		var hello, hb Envelope
		if websocket.JSON.Receive(c, &hello) != nil || !strings.Contains(string(hello.Payload), `"authorIntent":true`) || websocket.JSON.Receive(c, &hb) != nil {
			result <- fmt.Errorf("missing handshake")
			return
		}
		for _, test := range expected {
			requestID := newID()
			payload := managerIntentRequest{RequestID: requestID, Instructions: "classify", Input: managerIntentInput{Mode: "workspace-author", Latest: test.latest, Earlier: []intentMessage{{"user", key}}}}
			if err := websocket.JSON.Send(c, message("local", "agent.intent", "", "", payload)); err != nil {
				result <- err
				return
			}
			var frame Envelope
			if err := websocket.JSON.Receive(c, &frame); err != nil {
				result <- err
				return
			}
			var reply struct{ RequestID, Reply string }
			if frame.Type != "agent.intent_result" || json.Unmarshal(frame.Payload, &reply) != nil || reply.RequestID != requestID || reply.Reply != test.reply {
				result <- fmt.Errorf("unexpected reply for %s", test.reply)
				return
			}
		}
		result <- nil
	}))
	defer server.Close()
	ca := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: provider.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WHIPPET_AUTHOR_INTENT_CA_FILE", ca)
	t.Setenv("WHIPPET_AUTHOR_INTENT_BASE_URL", provider.URL+"/v1")
	t.Setenv("WHIPPET_AUTHOR_INTENT_MODEL", "fixture")
	t.Setenv("WHIPPET_AUTHOR_INTENT_API_KEY", key)
	m, err := New(Config{ServerURL: server.URL, ServerCAFile: ca, Token: "fixture", ManagerID: "local", MaxWorkers: 1, WorkDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- m.session(ctx) }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("missing manager reply")
	}
	<-done
	m.wg.Wait()
}
