package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"net/http"
	"time"
)

const (
	reportGrantLifetime = 10 * time.Minute
	reportGrantPayload  = sha256.Size + 8
	reportGrantBytes    = reportGrantPayload + sha256.Size
)

func signReportGrant(runID string, session adminSession, payload []byte) []byte {
	mac := hmac.New(sha256.New, session.reportKey[:])
	mac.Write([]byte(runID))
	mac.Write(payload)
	return mac.Sum(nil)
}

func (s *adminSessions) reportGrant(cookie, runID string, now time.Time) (string, bool) {
	sessionHash := sha256.Sum256([]byte(cookie))
	session, ok := s.lookupHash(sessionHash, now)
	if !ok {
		return "", false
	}
	var grant [reportGrantBytes]byte
	copy(grant[:sha256.Size], sessionHash[:])
	binary.BigEndian.PutUint64(grant[sha256.Size:reportGrantPayload], uint64(now.Add(reportGrantLifetime).Unix()))
	copy(grant[reportGrantPayload:], signReportGrant(runID, session, grant[:reportGrantPayload]))
	return base64.RawURLEncoding.EncodeToString(grant[:]), true
}

func (s *adminSessions) readReportGrant(value, runID string, now time.Time) (adminSession, [sha256.Size]byte, bool) {
	var hash [sha256.Size]byte
	if len(value) != base64.RawURLEncoding.EncodedLen(reportGrantBytes) {
		return adminSession{}, hash, false
	}
	grant, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(grant) != reportGrantBytes {
		return adminSession{}, hash, false
	}
	expiry := int64(binary.BigEndian.Uint64(grant[sha256.Size:reportGrantPayload]))
	if now.Unix() >= expiry {
		return adminSession{}, hash, false
	}
	copy(hash[:], grant[:sha256.Size])
	session, ok := s.lookupHash(hash, now)
	if !ok || !hmac.Equal(grant[reportGrantPayload:], signReportGrant(runID, session, grant[:reportGrantPayload])) {
		return adminSession{}, hash, false
	}
	return session, hash, true
}

// Opaque report documents cannot send SameSite cookies on their relative PNG
// requests. Moving the report beneath a short-lived, Run-bound path keeps the
// HTML and its relative references intact without relaxing the report sandbox.
func (a *API) redirectReport(w http.ResponseWriter, r *http.Request, runID string) bool {
	cookie, presented := adminCookie(r)
	if !presented || r.Method != http.MethodGet || r.PathValue("reportGrant") != "" {
		return false
	}
	proof, ok := a.adminSessions.reportGrant(cookie, runID, time.Now())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized", "請先登入 Whippet。")
		return true
	}
	w.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(w, r, "/api/runs/"+runID+"/report-view/"+proof+"/report.html", http.StatusTemporaryRedirect)
	return true
}

func (a *API) reportView(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if r.PathValue("name") == "report.html" {
		a.workspaceAPI(workspaceByRun, useTests, a.reportViewPage)(w, r)
		return
	}
	a.reportViewAttachment(w, r)
}

func (a *API) reportViewPage(w http.ResponseWriter, r *http.Request) {
	sessionCookie, presented := adminCookie(r)
	runID := r.PathValue("id")
	_, originHash, valid := a.adminSessions.readReportGrant(r.PathValue("reportGrant"), runID, time.Now())
	if presented && r.Method == http.MethodGet && (!valid || sha256.Sum256([]byte(sessionCookie)) != originHash) {
		http.Redirect(w, r, "/api/runs/"+runID+"/artifacts/report.html", http.StatusTemporaryRedirect)
		return
	}
	a.artifact(w, r)
}

func (a *API) reportViewAttachment(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !isScreenshotArtifact(name) && !isEvidenceArtifact(name) {
		a.fail(w, ErrNotFound)
		return
	}
	id, ok := a.id(w, r)
	if !ok {
		return
	}
	if len(r.Header.Values("Authorization")) != 0 || len(r.Header.Values("X-Whippet-Admin-Token")) != 0 {
		a.fail(w, errForbidden)
		return
	}
	session, originHash, valid := a.adminSessions.readReportGrant(r.PathValue("reportGrant"), id, time.Now())
	cookie, presented := adminCookie(r)
	if !valid || (presented && sha256.Sum256([]byte(cookie)) != originHash) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "報告附件連結已失效。")
		return
	}
	users, ok := a.store.(platformUserLookup)
	if !ok {
		a.fail(w, errForbidden)
		return
	}
	user, err := users.platformUser(r.Context(), session.userID)
	if err != nil {
		a.fail(w, err)
		return
	}
	if _, err = a.scopeWorkspace(r, platformActor{user: user}, workspaceByRun, useTests); err != nil {
		a.fail(w, err)
		return
	}
	a.artifact(w, r)
}
