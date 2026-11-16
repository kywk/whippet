package manager

import (
	"crypto/tls"
	"crypto/x509"
	"golang.org/x/net/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTP2RequestDoesNotBreakWebsocketReconnect(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	mux.Handle("/ws", websocket.Handler(func(c *websocket.Conn) { defer c.Close(); var v string; _ = websocket.Message.Receive(c, &v) }))
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	shared := &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	client := newHTTPClientWithTLS(shared)
	response, err := client.Get(srv.URL + "/ready")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	cfg, err := websocket.NewConfig("wss"+strings.TrimPrefix(srv.URL, "https")+"/ws", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.TlsConfig = shared
	conn, err := websocket.DialConfig(cfg)
	if err != nil {
		t.Fatalf("websocket reconnect after HTTP request: %v", err)
	}
	conn.Close()
}
