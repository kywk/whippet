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
	items map[[32]byte]adminSession
}

type adminSession struct {
	userID    string
	expiresAt time.Time
	reportKey [sha256.Size]byte
}

func newAdminSessions() *adminSessions { return &adminSessions{items: make(map[[32]byte]adminSession)} }

func (s *adminSessions) issue(now time.Time, userID, replace string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for hash, session := range s.items {
		if !now.Before(session.expiresAt) {
			delete(s.items, hash)
		}
	}
	replaceHash := sha256.Sum256([]byte(replace))
	if _, replacing := s.items[replaceHash]; len(s.items) >= maxAdminSessions && !replacing {
		return "", false
	}
	var secret [64]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", false
	}
	value := base64.RawURLEncoding.EncodeToString(secret[:32])
	session := adminSession{userID: userID, expiresAt: now.Add(adminSessionLifetime)}
	copy(session.reportKey[:], secret[32:])
	delete(s.items, replaceHash)
	s.items[sha256.Sum256([]byte(value))] = session
	return value, true
}

func (s *adminSessions) lookup(value string, now time.Time) (adminSession, bool) {
	return s.lookupHash(sha256.Sum256([]byte(value)), now)
}

func (s *adminSessions) lookupHash(hash [sha256.Size]byte, now time.Time) (adminSession, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.items[hash]
	if ok && !now.Before(session.expiresAt) {
		delete(s.items, hash)
		return adminSession{}, false
	}
	return session, ok
}

func (s *adminSessions) revoke(value string) {
	if value == "" {
		return
	}
	s.mu.Lock()
	delete(s.items, sha256.Sum256([]byte(value)))
	s.mu.Unlock()
}

func adminCookie(r *http.Request) (string, bool) {
	cookies := r.CookiesNamed(adminCookieName)
	if len(cookies) == 0 {
		return "", false
	}
	if len(cookies) != 1 || len(cookies[0].Value) > 128 {
		return "", true
	}
	return cookies[0].Value, true
}
