//go:build integration

// In-process HTTP handler with a disposable schema on the designated test PG.
// TLS state is simulated here; this is not a TLS handshake or Docker evidence.
package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func w7DB(t *testing.T) (*Postgres, context.Context) {
	t.Helper()
	const dsn = "postgres://postgres:postgres@127.0.0.1:32777/postgres?sslmode=disable"
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal("isolated PG open failed")
	}
	t.Cleanup(func() { _ = admin.Close() })
	schema := "w7qa_" + strings.ReplaceAll(NewID(), "-", "")
	if _, err = admin.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		t.Fatal("isolated schema creation failed")
	}
	t.Cleanup(func() {
		c, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if _, err := admin.ExecContext(c, `DROP SCHEMA `+schema+` CASCADE`); err != nil {
			t.Error("isolated schema cleanup failed")
		}
	})
	db, err := sql.Open("postgres", dsn+"&search_path="+schema)
	if err != nil {
		t.Fatal("isolated schema open failed")
	}
	t.Cleanup(func() { _ = db.Close() })
	p := &Postgres{DB: db, CredentialTLS: true}
	if p.Migrate(ctx) != nil {
		t.Fatal("isolated migration failed")
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal("synthetic vault setup failed")
	}
	p.Secrets, err = NewSecretVault(base64.StdEncoding.EncodeToString(key))
	clear(key)
	if err != nil || p.Secrets == nil {
		t.Fatal("synthetic vault setup failed")
	}
	return p, ctx
}

type w7Peer struct{ messages chan Envelope }

func (p *w7Peer) Send(m Envelope) error { p.messages <- m; return nil }
func (*w7Peer) Close() error            { return nil }

type w7Fixture struct {
	p                                              *Postgres
	ctx                                            context.Context
	handler                                        http.Handler
	engine                                         *Engine
	control                                        *Session
	workspace, role, ref, managerToken, agentToken string
	username, password                             string
	token                                          AgentToken
	lease                                          BrowserLease
}

func w7NewFixture(t *testing.T) *w7Fixture {
	t.Helper()
	p, ctx := w7DB(t)
	w, err := p.CreateWorkspace(ctx, "w7 synthetic")
	if err != nil {
		t.Fatal("workspace fixture failed")
	}
	role, ref := NewID(), NewID()
	config := WorkspaceConfig{Name: "synthetic", Targets: []WorkspaceOrigin{{Name: "target", Origin: "https://w7.invalid"}}, Dependencies: []WorkspaceOrigin{}, ExcludedOrigins: []string{}, LoginRoles: []WorkspaceRole{{RoleID: &role, Name: "synthetic", LoginMethod: "form", LoginOrigin: "https://w7.invalid"}}, TimeoutMS: 15000}
	if _, err = p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,canonical_config=$2 WHERE id=$1`, w.ID, jsonText(config)); err != nil {
		t.Fatal("workspace scope fixture failed")
	}
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO workspace_roles(id,workspace_id,secret_ref,secret_version,configured) VALUES($1,$2,$3,1,true)`, role, w.ID, ref); err != nil {
		t.Fatal("role fixture failed")
	}
	username, password := NewID(), NewID()
	nonce, sealed, err := p.Secrets.seal(w.ID, role, ref, 1, credentialValues{username, password})
	if err != nil {
		t.Fatal("synthetic secret fixture failed")
	}
	if _, err = p.DB.ExecContext(ctx, `INSERT INTO workspace_secrets(workspace_id,role_id,secret_ref,secret_version,nonce,ciphertext) VALUES($1,$2,$3,1,$4,$5)`, w.ID, role, ref, nonce, sealed); err != nil {
		t.Fatal("sealed fixture failed")
	}
	token, agentToken, err := p.CreateAgentToken(ctx, w.ID, "w7 synthetic")
	if err != nil {
		t.Fatal("token fixture failed")
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine := NewEngine(p, logger)
	peer := &w7Peer{messages: make(chan Envelope, 32)}
	control, err := engine.Attach(ctx, "w7-qa-manager", 4, peer)
	if err != nil {
		t.Fatal("manager fixture failed")
	}
	t.Cleanup(func() { engine.Detach(control) })
	if err = engine.Handle(ctx, control, NewEnvelope("heartbeat", "w7-qa-manager", "", "", map[string]any{"active": []any{}, "sessions": []any{}})); err != nil {
		t.Fatal("manager heartbeat fixture failed")
	}
	select {
	case <-peer.messages:
	case <-time.After(time.Second):
		t.Fatal("manager heartbeat acknowledgement missing")
	}
	w, err = p.Workspace(ctx, w.ID)
	if err != nil {
		t.Fatal("workspace snapshot fixture failed")
	}
	registry, err := loadToolRegistry()
	if err != nil {
		t.Fatal("registry fixture failed")
	}
	lease, _, err := p.OpenBrowserLease(ctx, token, NewID(), "w7-qa-manager", control.liveEpoch, registry, w)
	if err != nil {
		t.Fatal("lease fixture failed")
	}
	if err = p.BrowserReady(ctx, "w7-qa-manager", control.liveEpoch, lease.SessionID, lease.LeaseID); err != nil {
		t.Fatal("lease ready fixture failed")
	}
	managerToken := NewID()
	handler := NewAPI(p, nil, engine, managerToken, logger).WithAdminAccess(NewID(), "https://whippet.example").Handler(nil)
	return &w7Fixture{p, ctx, handler, engine, control, w.ID, role, ref, managerToken, agentToken, username, password, token, lease}
}

func (f *w7Fixture) resolve(session, lease, body, bearer string, tlsEnabled bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "http://whippet.example/api/manager/browser-sessions/"+session+"/leases/"+lease+"/credentials/resolve", bytes.NewBufferString(body))
	r.Header.Set("Authorization", "Bearer "+bearer)
	r.Header.Set("Content-Type", "application/json")
	if tlsEnabled {
		r.TLS = &tls.ConnectionState{}
	}
	rec := httptest.NewRecorder()
	f.handler.ServeHTTP(rec, r)
	return rec
}
func w7Denied(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	// A 404 counts only when the application supplies its structured rejection.
	if rec.Code == 404 {
		var body struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if json.Unmarshal(rec.Body.Bytes(), &body) == nil && body.Error.Code == "not_found" {
			return
		}
	}
	switch rec.Code {
	case 400, 401, 403, 409, 410, 422:
		return
	}
	t.Fatalf("expected explicit rejection, got HTTP %d (inconclusive otherwise)", rec.Code)
}

func TestM11W7SecurityResolver(t *testing.T) {
	cases := []string{"valid", "no_tls", "wrong_session", "wrong_lease", "wrong_role", "agent_bearer", "extra_secret_field", "revoked_token", "token_workspace_mismatch", "workspace_scope", "authorization_revision", "wrong_epoch", "stale_secret_version", "revoked_secret", "closing", "deadline"}
	for _, tc := range cases {
		t.Run(tc, func(t *testing.T) {
			f := w7NewFixture(t)
			session, lease, role, bearer := f.lease.SessionID, f.lease.LeaseID, f.role, f.managerToken
			tlsEnabled := true
			bodyExtra := ""
			switch tc {
			case "no_tls":
				tlsEnabled = false
			case "wrong_session":
				session = NewID()
			case "wrong_lease":
				lease = NewID()
			case "wrong_role":
				role = NewID()
			case "agent_bearer":
				bearer = f.agentToken
			case "extra_secret_field":
				bodyExtra = `,"secretVersion":1`
			case "revoked_token":
				if f.p.RevokeAgentToken(f.ctx, f.workspace, f.token.ID) != nil {
					t.Fatal("token revoke fixture failed")
				}
			case "token_workspace_mismatch":
				other, err := f.p.CreateWorkspace(f.ctx, "w7 foreign")
				if err != nil {
					t.Fatal("foreign workspace fixture failed")
				}
				if _, err = f.p.DB.ExecContext(f.ctx, `UPDATE agent_tokens SET workspace_id=$2 WHERE id=$1`, f.token.ID, other.ID); err != nil {
					t.Fatal("token workspace fixture failed")
				}
			case "workspace_scope":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET scope_status='unconfirmed' WHERE id=$1`, f.workspace); err != nil {
					t.Fatal("scope fixture failed")
				}
			case "authorization_revision":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspaces SET authorization_revision=authorization_revision+1 WHERE id=$1`, f.workspace); err != nil {
					t.Fatal("revision fixture failed")
				}
			case "wrong_epoch":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE agent_browser_leases SET manager_epoch=$2 WHERE session_id=$1`, f.lease.SessionID, NewID()); err != nil {
					t.Fatal("epoch fixture failed")
				}
			case "stale_secret_version":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspace_roles SET secret_version=2 WHERE id=$1`, f.role); err != nil {
					t.Fatal("version fixture failed")
				}
			case "revoked_secret":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE workspace_secrets SET revoked_at=now() WHERE secret_ref=$1`, f.ref); err != nil {
					t.Fatal("secret revocation fixture failed")
				}
			case "closing":
				if _, err := f.p.CloseBrowserLease(f.ctx, f.token, f.lease.SessionID, f.lease.LeaseID); err != nil {
					t.Fatal("close fixture failed")
				}
			case "deadline":
				if _, err := f.p.DB.ExecContext(f.ctx, `UPDATE agent_browser_leases SET deadline_at=now()-interval '1 second' WHERE session_id=$1`, f.lease.SessionID); err != nil {
					t.Fatal("deadline fixture failed")
				}
			}
			rec := f.resolve(session, lease, `{"roleId":"`+role+`"`+bodyExtra+`}`, bearer, tlsEnabled)
			if tc != "valid" {
				w7Denied(t, rec)
				return
			}
			if rec.Code != 200 || rec.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("valid resolver failed: HTTP %d", rec.Code)
			}
			var got map[string]any
			if json.Unmarshal(rec.Body.Bytes(), &got) != nil || len(got) != 7 || got["sessionId"] != session || got["leaseId"] != lease || got["workspaceId"] != f.workspace || got["roleId"] != role || got["loginOrigin"] != "https://w7.invalid" || got["username"] != f.username || got["password"] != f.password {
				t.Fatal("resolver response shape or binding mismatch")
			}
		})
	}
}
