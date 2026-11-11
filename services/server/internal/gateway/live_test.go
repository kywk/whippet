package gateway

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/whippet/whippet/services/server/internal/server"
)

func TestLiveOriginIncludesPort(t *testing.T) {
	for _, tc := range []struct {
		origin, host string
		allowed      bool
	}{
		{"http://localhost:18080", "localhost:18080", true},
		{"https://whippet.test", "whippet.test", true},
		{"http://other.test", "whippet.test", false},
		{"http://localhost:18080", "localhost", false},
		{"null", "localhost", false},
		{"", "localhost", false},
	} {
		r := httptest.NewRequest("GET", "http://"+tc.host+"/api/runs/id/live", nil)
		r.Header.Set("Origin", tc.origin)
		if sameLiveOrigin(r) != tc.allowed {
			t.Fatalf("Origin %q host %q", tc.origin, tc.host)
		}
	}
}

func TestLiveRoutesAuthAndLongLivedContext(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	api := server.NewAPI(nil, nil, server.NewEngine(nil, log), "manager-token", log)
	called := false
	viewer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if deadline, ok := r.Context().Deadline(); ok && time.Until(deadline) <= 30*time.Second {
			t.Error("live inherited HTTP 30s deadline")
		}
		w.WriteHeader(204)
	})
	media := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(204) })
	handler := api.WithLiveHandlers(viewer, media).Handler(nil)
	id := server.NewID()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/runs/"+id+"/live", nil))
	if w.Code != 204 {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/manager/runs/"+id+"/live", nil))
	if w.Code != 401 || called || !strings.Contains(w.Body.String(), "unauthorized") {
		t.Fatal("media bypassed bearer auth")
	}
	r := httptest.NewRequest("GET", "/api/manager/runs/"+id+"/live", nil)
	r.Header.Set("Authorization", "Bearer manager-token")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 204 || !called {
		t.Fatal("authorized media route unavailable")
	}
}
