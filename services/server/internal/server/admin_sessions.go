package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"sync"
	"time"
)

const (
	adminCookieName      = "whippet_admin_session"
	adminSessionLifetime = 8 * time.Hour
	maxAdminSessions     = 256
)

type adminSessions struct {
	mu    sync.Mutex
	items map[[32]byte]time.Time
}

func newAdminSessions() *adminSessions { return &adminSessions{items: make(map[[32]byte]time.Time)} }

func (s *adminSessions) issue(now time.Time) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for hash, expires := range s.items {
		if !now.Before(expires) {
			delete(s.items, hash)
		}
	}
	if len(s.items) >= maxAdminSessions {
		return "", false
	}
	var secret [32]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", false
	}
	value := base64.RawURLEncoding.EncodeToString(secret[:])
	s.items[sha256.Sum256([]byte(value))] = now.Add(adminSessionLifetime)
	return value, true
}

func (s *adminSessions) valid(value string, now time.Time) bool {
	if value == "" {
		return false
	}
	hash := sha256.Sum256([]byte(value))
	s.mu.Lock()
	defer s.mu.Unlock()
	expires, ok := s.items[hash]
	if ok && !now.Before(expires) {
		delete(s.items, hash)
		return false
	}
	return ok
}

func (s *adminSessions) revoke(value string) {
	if value == "" {
		return
	}
	s.mu.Lock()
	delete(s.items, sha256.Sum256([]byte(value)))
	s.mu.Unlock()
}

func adminCookie(r *http.Request) string {
	c, err := r.Cookie(adminCookieName)
	if err != nil || len(c.Value) > 128 {
		return ""
	}
	return c.Value
}
