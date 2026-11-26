//go:build integration

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

const admWorkspaceID = "00000000-0000-4000-8000-000000000001"
const admTestID = "10000000-0000-4000-8000-000000000001"
const admWorkspacePath = "/api/admin/workspaces/" + admWorkspaceID

type archiveFixture struct {
	t       *testing.T
	ctx     context.Context
	store   *Postgres
	files   *LocalArtifacts
	engine  *Engine
	session *Session
	peer    *recordPeer
	handler http.Handler
	cookie  *http.Cookie
	token   AgentToken
	secret  string
}

func newArchiveFixture(t *testing.T) *archiveFixture {
	t.Helper()
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	manualSeedVersions(t, p, ctx)
	if _, err := p.DB.ExecContext(ctx, `UPDATE workspaces SET lifecycle='active',scope_status='confirmed',canonical_config=$2,author_engine='external' WHERE id=$1`, admWorkspaceID, jsonText(m8Config())); err != nil {
		t.Fatal(err)
	}
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	token, secret, err := p.CreateAgentToken(ctx, admWorkspaceID, "archive fixture")
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	engine, peer := NewEngine(p, log), &recordPeer{}
	t.Cleanup(engine.Close)
	session, err := engine.Attach(ctx, "manager-test", 2, peer)
	if err != nil {
		t.Fatal(err)
	}
	testHeartbeat(t, engine, session, nil)
	f := &archiveFixture{t: t, ctx: ctx, store: p, files: files, engine: engine, session: session, peer: peer, token: token, secret: secret}
	f.handler = NewAPI(p, files, engine, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin).Handler(nil)
	f.cookie = f.platform("POST", "/api/dev-login", `{"userId":"dev-site-admin"}`, 200).Result().Cookies()[0]
	return f
}

func (f *archiveFixture) platform(method, path, body string, status int) *httptest.ResponseRecorder {
	f.t.Helper()
	req := httptest.NewRequest(method, fixtureOrigin+path, strings.NewReader(body)).WithContext(f.ctx)
	req.Header.Set("Origin", fixtureOrigin)
	if f.cookie == nil {
		req.Header.Set("X-Whippet-Admin-Token", fixtureAdminKey)
	} else {
		req.AddCookie(f.cookie)
	}
	out := httptest.NewRecorder()
	f.handler.ServeHTTP(out, req)
	if out.Code != status {
		f.t.Fatalf("%s %s: got %d want %d: %s", method, path, out.Code, status, out.Body)
	}
	return out
}

func (f *archiveFixture) managed(method, path, body string, status int) managedWorkspace {
	f.t.Helper()
	var workspace managedWorkspace
	f.decode(f.platform(method, path, body, status).Body.Bytes(), &workspace)
	return workspace
}

func (f *archiveFixture) decode(data []byte, dst any) {
	f.t.Helper()
	if err := json.Unmarshal(data, dst); err != nil {
		f.t.Fatal(err)
	}
}

func (f *archiveFixture) mcp(name string, args any, wantCode string) json.RawMessage {
	f.t.Helper()
	body := jsonText(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	req := httptest.NewRequest(http.MethodPost, fixtureOrigin+"/mcp", strings.NewReader(body)).WithContext(f.ctx)
	req.Header.Set("Authorization", "Bearer "+f.secret)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	out := httptest.NewRecorder()
	f.handler.ServeHTTP(out, req)
	var response struct {
		Result *struct {
			IsError bool            `json:"isError"`
			Data    json.RawMessage `json:"structuredContent"`
		} `json:"result"`
	}
	f.decode(out.Body.Bytes(), &response)
	if out.Code != 200 || response.Result == nil || response.Result.IsError != (wantCode != "") {
		f.t.Fatalf("%s: HTTP %d %s", name, out.Code, out.Body)
	}
	if wantCode != "" && wantCode != "tool unavailable" {
		var detail struct{ Error string }
		f.decode(response.Result.Data, &detail)
		if detail.Error != wantCode {
			f.t.Fatalf("%s: got %s, want %s", name, response.Result.Data, wantCode)
		}
	}
	return response.Result.Data
}

func (f *archiveFixture) manager(kind, run, attempt string, data any) {
	f.t.Helper()
	if err := f.engine.Handle(f.ctx, f.session, NewEnvelope(kind, f.session.managerID, run, attempt, data)); err != nil {
		f.t.Fatal(err)
	}
}

func (f *archiveFixture) tick() {
	f.t.Helper()
	if err := f.engine.Tick(f.ctx); err != nil {
		f.t.Fatal(err)
	}
}

func (f *archiveFixture) enqueueRun() Run {
	f.t.Helper()
	run, err := f.store.CreateRun(f.ctx, admTestID)
	if err != nil {
		f.t.Fatal(err)
	}
	return run
}

func (f *archiveFixture) enqueueAuthor() (EditingSession, Run) {
	f.t.Helper()
	session, _, err := f.store.StartEditingSession(f.ctx, admTestID)
	if err != nil {
		f.t.Fatal(err)
	}
	turn, err := f.store.CreateAuthor(f.ctx, admTestID, session.ID, "補上頁面標題的驗證", session.Draft.Revision)
	if err != nil {
		f.t.Fatal(err)
	}
	return session, turn.Run
}

func (f *archiveFixture) lease() BrowserLease {
	f.t.Helper()
	workspace, err := f.store.Workspace(f.ctx, admWorkspaceID)
	if err != nil {
		f.t.Fatal(err)
	}
	registry, err := loadToolRegistry()
	if err != nil {
		f.t.Fatal(err)
	}
	lease, _, err := f.store.OpenBrowserLease(f.ctx, f.token, NewID(), f.session.managerID, f.session.liveEpoch, registry, workspace)
	if err != nil {
		f.t.Fatal(err)
	}
	f.manager("session.ready", "", "", map[string]string{"sessionId": lease.SessionID, "leaseId": lease.LeaseID})
	return lease
}

func TestADM1WorkspaceArchivePostgres(t *testing.T) {
	for _, mode := range []string{"drain", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			f := newArchiveFixture(t)
			renamed := f.managed("PATCH", admWorkspacePath, `{"revision":1,"name":"  發行驗收  "}`, 200)
			if renamed.Workspace.Name != "發行驗收" || renamed.Workspace.Management.Revision != 2 {
				t.Fatalf("rename: %+v", renamed)
			}
			var workspace Workspace
			f.decode(f.platform("GET", "/api/workspaces/"+admWorkspaceID, "", 200).Body.Bytes(), &workspace)
			if workspace.Name != "發行驗收" || workspace.Settings.Name != m8Config().Name || workspace.Revision != 1 {
				t.Fatalf("management rename changed settings: %+v", workspace)
			}
			f.platform("PATCH", admWorkspacePath, `{"revision":1,"name":"過期"}`, 409)
			f.platform("PATCH", "/api/workspaces/"+admWorkspaceID, `{"name":"legacy"}`, 405)

			managed := f.enqueueRun()
			assignment, err := f.store.Claim(f.ctx, f.session.managerID, 2)
			if err != nil || assignment == nil || assignment.ID != managed.ID {
				t.Fatalf("reserve Manager Run: %+v %v", assignment, err)
			}
			if mode == "drain" {
				f.tick()
				f.manager("event", assignment.ID, assignment.AttemptID, Event{EventID: NewID(), Kind: "started"})
				for name, content := range map[string]string{"report.html": "<!doctype html><h1>Archived evidence</h1>", "results.json": "{}"} {
					artifact, err := f.files.Save(managed.ID, assignment.AttemptID, name, strings.NewReader(content))
					if err != nil {
						t.Fatal(err)
					}
					if err := f.store.SaveArtifact(f.ctx, artifact); err != nil {
						t.Fatal(err)
					}
				}
			}
			lease := f.lease()
			session, author := f.enqueueAuthor()
			claimArgs := map[string]string{"requestId": NewID()}
			var claim struct{ Task ExternalTask }
			f.decode(f.mcp("task_claim", claimArgs, ""), &claim)
			if claim.Task.RunID != author.ID {
				t.Fatal("external author was not claimed")
			}
			queued := []Run{f.enqueueRun(), f.enqueueRun()}
			before := f.managed("GET", admWorkspacePath, "", 200)
			want := workspaceArchiveImpact{QueuedRuns: 2, ActiveRuns: 2, ExternalClaims: 1, BrowserLeases: 1, UnreleasedRunSlots: 1}
			if before.Impact != want {
				t.Fatalf("archive preview got %+v want %+v", before.Impact, want)
			}

			archiving := f.managed("POST", admWorkspacePath+"/archive", `{"revision":2,"mode":"drain"}`, 202)
			if archiving.Workspace.Management.State != workspaceArchiving || archiving.Impact.QueuedRuns != 0 || archiving.Workspace.Management.ArchiveStartedAt == nil {
				t.Fatalf("draining: %+v", archiving)
			}
			f.platform("POST", admWorkspacePath+"/restore", `{"revision":3}`, 409)
			f.platform("POST", "/api/tests/"+admTestID+"/runs", "", 409)
			f.platform("POST", "/api/workspaces/"+admWorkspaceID+"/tests", `{"name":"blocked"}`, 409)
			f.mcp("task_claim", map[string]string{"requestId": NewID()}, "workspace_archiving")
			f.mcp("browser_session_open", map[string]string{"requestId": NewID()}, "workspace_archiving")
			leaseArgs := map[string]string{"sessionId": lease.SessionID, "leaseId": lease.LeaseID}
			taskArgs := map[string]string{"runId": claim.Task.RunID, "attemptId": claim.Task.AttemptID, "leaseId": claim.Task.LeaseID}
			submitArgs := map[string]any{
				"runId": claim.Task.RunID, "attemptId": claim.Task.AttemptID, "leaseId": claim.Task.LeaseID, "submitId": NewID(),
				"output": map[string]any{"message": "已更新驗證", "script": "// saved while draining", "requestValidation": true},
			}
			terminalStatus := "succeeded"
			revision := 3
			if mode == "drain" {
				f.mcp("task_claim", claimArgs, "")
				f.mcp("task_heartbeat", taskArgs, "")
				f.mcp("browser_session_status", leaseArgs, "")
				var receipt ExternalSubmitResult
				f.decode(f.mcp("task_submit", submitArgs, ""), &receipt)
				authorRun, err := f.store.Run(f.ctx, author.ID)
				if err != nil || receipt.AppliedRevision == nil || *receipt.AppliedRevision != session.Draft.Revision+1 ||
					receipt.ValidationRunID != nil || !slices.Contains(authorRun.ProgressEvents, "workspace_archiving") {
					t.Fatalf("drained author result: %+v %+v %v", receipt, authorRun, err)
				}
				f.mcp("browser_session_close", leaseArgs, "")
			} else {
				cancelled := f.managed("POST", admWorkspacePath+"/archive", `{"revision":3,"mode":"cancel"}`, 202)
				revision++
				if cancelled.Impact.ExternalClaims != 0 || cancelled.Impact.ActiveRuns != 1 || cancelled.Impact.UnreleasedRunSlots != 1 || cancelled.Impact.BrowserLeases != 1 {
					t.Fatalf("cancel before reclaim: %+v", cancelled)
				}
				replay := f.managed("POST", admWorkspacePath+"/archive", `{"revision":4,"mode":"cancel"}`, 202)
				if replay.Workspace.Management.Revision != revision {
					t.Fatal("same mode changed revision")
				}
				f.platform("POST", admWorkspacePath+"/archive", `{"revision":4,"mode":"drain"}`, 409)
				f.mcp("task_claim", claimArgs, "workspace_archiving")
				f.mcp("task_submit", submitArgs, "tool unavailable")
				draft, err := f.store.Draft(f.ctx, admTestID)
				if err != nil || draft.Revision != session.Draft.Revision {
					t.Fatalf("cancelled result changed draft: %+v %v", draft, err)
				}
				terminalStatus = "cancelled"
			}
			f.peer.messages = nil
			if mode == "cancel" {
				if err := f.engine.SendBrowserOpen(f.ctx, lease); err != nil {
					t.Fatal(err)
				}
			}
			f.tick()
			if mode == "cancel" {
				var sent []string
				for _, msg := range f.peer.messages {
					sent = append(sent, msg.Type)
				}
				if !slices.Equal(sent, []string{"session.close", "cancel"}) {
					t.Fatalf("cancel replayed unacknowledged work: %v", sent)
				}
			}
			f.manager("result", assignment.ID, assignment.AttemptID, Result{Status: terminalStatus})
			testHeartbeat(t, f.engine, f.session, nil)
			f.manager("session.closed", "", "", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "reason": "closed", "reclaimed": false})
			f.tick()
			if blocked := f.managed("GET", admWorkspacePath, "", 200); blocked.Workspace.Management.State != workspaceArchiving || blocked.Impact.BrowserLeases != 1 {
				t.Fatalf("archive ignored unverified reclaim: %+v", blocked)
			}
			f.manager("session.closed", "", "", map[string]any{"sessionId": lease.SessionID, "leaseId": lease.LeaseID, "reason": "closed", "reclaimed": true})
			f.tick()
			archived := f.managed("GET", admWorkspacePath, "", 200)
			if archived.Workspace.Management.State != workspaceArchived || archived.Workspace.Management.Revision != revision+1 || archived.Impact != (workspaceArchiveImpact{}) {
				t.Fatalf("archive after reclaim: %+v", archived)
			}
			f.platform("POST", "/api/tests/"+admTestID+"/runs", "", 409)
			f.mcp("task_claim", claimArgs, "workspace_archived")
			list := f.platform("GET", "/api/workspaces", "", 200)
			if strings.Contains(list.Body.String(), admWorkspaceID) {
				t.Fatal("ordinary list included the archived Workspace")
			}
			if list := f.platform("GET", "/api/admin/workspaces?state=archived", "", 200); !strings.Contains(list.Body.String(), admWorkspaceID) {
				t.Fatal("management list omitted the archived Workspace")
			}
			if mode == "drain" {
				f.mcp("task_submit", submitArgs, "")
				report := f.platform("GET", "/api/runs/"+managed.ID+"/artifacts/report.html", "", 307)
				f.platform("GET", report.Header().Get("Location"), "", 200)
			}
			restored := f.managed("POST", admWorkspacePath+"/restore", fmt.Sprintf(`{"revision":%d}`, revision+1), 200)
			if restored.Workspace.Management.State != workspaceActive || restored.Workspace.Management.ArchiveMode != nil || restored.Workspace.Management.ArchivedAt != nil {
				t.Fatalf("restore: %+v", restored)
			}
			if run := f.enqueueRun(); run.Status != "queued" {
				t.Fatalf("restored Workspace rejected work: %+v", run)
			}
			for _, prior := range queued {
				run, err := f.store.Run(f.ctx, prior.ID)
				if err != nil || run.Status != "cancelled" {
					t.Fatalf("restored queue revived cancelled Run: %+v %v", run, err)
				}
			}
		})
	}
}

func TestADM1ArchiveClaimRacePostgres(t *testing.T) {
	f := newArchiveFixture(t)
	managed := f.enqueueRun()
	_, author := f.enqueueAuthor()
	actor := platformActor{user: presentUser("dev-site-admin", "Site Manager", siteAdmin)}
	start := make(chan struct{})
	claimResult := make(chan error, 1)
	type managerClaim struct {
		assignment *Assignment
		err        error
	}
	managerResult := make(chan managerClaim, 1)
	go func() {
		<-start
		_, err := f.store.ClaimExternalAuthor(f.ctx, f.token, NewID())
		claimResult <- err
	}()
	go func() {
		<-start
		assignment, err := f.store.Claim(f.ctx, f.session.managerID, 2)
		managerResult <- managerClaim{assignment, err}
	}()
	close(start)
	_, err := f.store.archiveWorkspace(f.ctx, actor, admWorkspaceID, 1, "drain")
	if err != nil {
		t.Fatal(err)
	}
	claimErr := <-claimResult
	reservation := <-managerResult
	if reservation.err != nil {
		t.Fatal(reservation.err)
	}
	after := f.managed("GET", admWorkspacePath, "", 200)
	run, err := f.store.Run(f.ctx, author.ID)
	if err != nil || after.Impact.QueuedRuns != 0 {
		t.Fatalf("race left queued work: %+v %v", after, err)
	}
	switch {
	case claimErr == nil && run.Status == "running" && after.Impact.ExternalClaims == 1:
	case (errors.Is(claimErr, errWorkspaceArchiving) || errors.Is(claimErr, errWorkspaceArchived)) && run.Status == "cancelled" && after.Impact.ExternalClaims == 0:
	default:
		t.Fatalf("race split claim and Workspace decision: %+v %+v %v", after, run, claimErr)
	}
	run, err = f.store.Run(f.ctx, managed.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reservation.assignment == nil {
		if run.Status != "cancelled" || after.Impact.UnreleasedRunSlots != 0 {
			t.Fatalf("unreserved Run survived archive: %+v %+v", run, after.Impact)
		}
	} else if reservation.assignment.ID != run.ID || run.Status != "dispatched" || after.Impact.UnreleasedRunSlots != 1 {
		t.Fatalf("committed reservation lost its attempt: %+v %+v", run, after.Impact)
	}
	if after.Workspace.Management.State == workspaceArchived && after.Impact != (workspaceArchiveImpact{}) {
		t.Fatalf("archive completed before all reservations cleared: %+v", after)
	}
}
