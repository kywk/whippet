//go:build integration

package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

const admAIPath = "/api/admin/ai"

func newSiteAIFixture(t *testing.T) *archiveFixture {
	t.Helper()
	f := newArchiveFixture(t)
	f.platform("GET", admAIPath+"/resources", "", http.StatusForbidden)
	f.platform("POST", "/api/dev-logout", `{}`, http.StatusNoContent)
	f.cookie = nil
	f.cookie = f.platform("POST", "/api/dev-login", `{"userId":"dev-admin"}`, http.StatusOK).Result().Cookies()[0]
	return f
}

func TestADM2ResourceAssignmentPostgres(t *testing.T) {
	f := newSiteAIFixture(t)
	path := admAIPath + "/resources/" + url.PathEscape("manager:manager-test")
	var first siteAIResource
	f.decode(f.platform("GET", path, "", 200).Body.Bytes(), &first)
	if first.Connection != "online" || first.Capacity.Available == nil || *first.Capacity.Available != 2 || first.WorkspaceIDs != nil {
		t.Fatalf("legacy Manager projection: %+v", first)
	}
	firstRun := f.enqueueRun()
	f.tick()
	var paused siteAIResource
	f.decode(f.platform("POST", path+"/actions/pause_dispatch", `{"revision":1}`, 200).Body.Bytes(), &paused)
	if paused.Control != "paused" || paused.Revision != 2 || len(paused.Attempts) != 1 || paused.Attempts[0].RunID != firstRun.ID {
		t.Fatalf("pause changed prior assignment: %+v", paused)
	}
	second := f.enqueueRun()
	f.tick()
	if run, err := f.store.Run(f.ctx, second.ID); err != nil || run.Status != "queued" {
		t.Fatalf("paused Manager claimed work: %s %v", run.Status, err)
	}
	f.platform("POST", path+"/actions/resume_dispatch", `{"revision":1}`, 409)
	other, err := f.store.CreateWorkspace(f.ctx, "Other")
	if err != nil {
		t.Fatal(err)
	}
	f.platform("POST", path+"/actions/assign", jsonText(map[string]any{"revision": 2, "workspaceIds": []string{other.ID}}), 200)
	f.platform("POST", path+"/actions/resume_dispatch", `{"revision":3}`, 200)
	f.tick()
	if run, err := f.store.Run(f.ctx, second.ID); err != nil || run.Status != "queued" {
		t.Fatalf("Manager dispatched outside assignment: %s %v", run.Status, err)
	}
	f.platform("POST", path+"/actions/drain_remove", `{"revision":4}`, 202)
	var draining siteAIResource
	f.decode(f.platform("GET", path, "", 200).Body.Bytes(), &draining)
	if draining.Control != "draining" || len(draining.Attempts) != 1 {
		t.Fatalf("drain released active slot: %+v", draining)
	}
	f.platform("POST", "/api/runs/"+firstRun.ID+"/cancel", "", 200)
	f.manager("result", firstRun.ID, draining.Attempts[0].AttemptID, Result{Status: "cancelled"})
	testHeartbeat(t, f.engine, f.session, nil)
	f.tick()
	var removed siteAIResource
	f.decode(f.platform("GET", path, "", 200).Body.Bytes(), &removed)
	if removed.Control != "removed" || removed.WorkspaceIDs == nil || len(removed.WorkspaceIDs) != 0 || removed.Capacity.Occupied != 0 {
		t.Fatalf("drain did not wait for slot release: %+v", removed)
	}
}

func TestADM3ManagedKeyPostgres(t *testing.T) {
	f := newSiteAIFixture(t)
	const profile = `[{"id":"adm-fixture","engine":"builtin","provider":"openai-responses","baseURL":"https://provider.example/v1","model":"fixture-model","reasoningEffort":"low","contextWindowTokens":32768,"contextInputTokens":16384}]`
	t.Setenv("WHIPPET_AI_RUNTIME_PROFILES_JSON", profile)
	var err error
	f.store.Secrets, err = NewSecretVault(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	f.session, err = f.engine.AttachSiteAI(f.ctx, "manager-test", 2, f.peer, &SiteAIManagerCapabilities{Version: 1, Engines: []string{"builtin"}, Skills: []string{"test-author"}, WorkerRevision: strings.Repeat("a", 64)}, true)
	if err != nil {
		t.Fatal(err)
	}
	heartbeat := func(free int) {
		f.manager("heartbeat", "", "", map[string]any{"active": []ActiveAttempt{}, "admin": map[string]any{"freeSlots": free, "activeProvisionIds": []string{}}})
	}
	heartbeat(1)
	create := func(request, key string, status int) siteAIAgentCreation {
		t.Helper()
		body := siteAINewAgent{RequestID: request, WorkspaceID: admWorkspaceID, Name: "Fixture Agent", Mode: siteAIManaged, Engine: "builtin",
			ProfileID: stringPointer("adm-fixture"), Provider: "openai-responses", Model: "fixture-model", APIKey: &key}
		response := f.platform("POST", admAIPath+"/agents", jsonText(body), status)
		if strings.Contains(response.Body.String(), key) {
			t.Fatal("Agent response contains its Key")
		}
		var result siteAIAgentCreation
		f.decode(response.Body.Bytes(), &result)
		return result
	}
	makeRequest := NewID()
	first := create(makeRequest, "fixture-key-a", 201).Agent
	if first.Status != siteAIVerifying || first.ProbeID == nil || first.ModelKey == nil || *first.ModelKey.Version != 1 {
		t.Fatalf("unexpected initial agent: %+v", first)
	}
	if again := create(makeRequest, "fixture-key-a", 200); again.Agent.ID != first.ID || again.Token != "" {
		t.Fatalf("idempotent Agent creation: %+v", again)
	}
	create(makeRequest, "fixture-different-key", 409)
	second := create(NewID(), "fixture-key-b", 201).Agent
	if second.Status != siteAIFailed || stringValue(second.Reason) != "no_capacity" {
		t.Fatalf("a second reservation consumed the same reported slot: %+v", second)
	}
	heartbeat(2)
	f.decode(f.platform("POST", admAIPath+"/agents/"+second.ID+"/retry", `{"revision":1}`, 202).Body.Bytes(), &second)
	f.tick()
	resolve := func(req siteAIKeyRequest, status int) string {
		t.Helper()
		r := httptest.NewRequest("POST", fixtureOrigin+"/api/manager/agent-keys/resolve", strings.NewReader(jsonText(req))).WithContext(f.ctx)
		r.Header.Set("Authorization", "Bearer fixture-manager")
		r.Header.Set("X-Whippet-Manager-Session", f.session.siteAI.Nonce)
		recorder := httptest.NewRecorder()
		f.handler.ServeHTTP(recorder, r)
		if recorder.Code != status || recorder.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("unexpected resolver HTTP %d, expected %d", recorder.Code, status)
		}
		var result siteAIKeyResolution
		f.decode(recorder.Body.Bytes(), &result)
		return result.APIKey
	}
	probe := func(agent siteAIAgent, status string, code *string, reclaimed bool) {
		t.Helper()
		f.manager("agent.provision_result", "", "", siteAIProvisionResult{ID: *agent.ProbeID, Status: status, Code: code, Reclaimed: &reclaimed})
	}
	probeKey := func(agent string, operation string, version int) siteAIKeyRequest {
		return siteAIKeyRequest{siteAIModelCredential: siteAIModelCredential{AgentID: agent, SecretVersion: version}, Purpose: "probe", OperationID: operation}
	}
	if resolve(probeKey(first.ID, *first.ProbeID, 1), 200) != "fixture-key-a" || resolve(probeKey(second.ID, *second.ProbeID, 1), 200) != "fixture-key-b" {
		t.Fatal("probe model keys were not separated")
	}
	resolve(probeKey(second.ID, *first.ProbeID, 1), 404)
	probe(first, "failed", stringPointer("provider_auth_failed"), true)
	probe(second, "succeeded", nil, false)
	var item siteAIAgent
	f.decode(f.platform("GET", admAIPath+"/agents/"+second.ID, "", 200).Body.Bytes(), &item)
	if item.Status != siteAIVerifying || stringValue(item.Reason) != "cleanup_pending" {
		t.Fatalf("unreclaimed slot verified prematurely: %+v", item)
	}
	probe(second, "succeeded", nil, true)
	var rotated siteAIAgent
	f.decode(f.platform("PUT", admAIPath+"/agents/"+first.ID+"/model-key", `{"expectedSecretVersion":1,"apiKey":"fixture-key-a2"}`, 200).Body.Bytes(), &rotated)
	if rotated.ModelKey == nil || *rotated.ModelKey.Version != 2 || stringValue(rotated.Reason) != "verification_required" {
		t.Fatalf("rotation: %+v", rotated)
	}
	resolve(probeKey(first.ID, *first.ProbeID, 1), 409)
	var retried siteAIAgent
	f.decode(f.platform("POST", admAIPath+"/agents/"+first.ID+"/retry", `{"revision":2}`, 202).Body.Bytes(), &retried)
	if retried.ID != first.ID || retried.ProbeID == nil || *retried.ProbeID == *first.ProbeID {
		t.Fatal("retry must reserve a new probe for the same Agent")
	}
	f.tick()
	if resolve(probeKey(first.ID, *retried.ProbeID, 2), 200) != "fixture-key-a2" {
		t.Fatal("retry did not resolve the rotated Key")
	}
	probe(retried, "succeeded", nil, true)
	path := admAIPath + "/workspaces/" + admWorkspaceID + "/agent-routing"
	f.platform("PATCH", path, jsonText(map[string]any{"revision": 1, "skillId": "test-author", "agentId": second.ID}), 200)
	_, run := f.enqueueAuthor()
	if stringValue(run.AgentID) != second.ID || run.AuthorEngine != "builtin" {
		t.Fatalf("author route: %+v", run)
	}
	f.tick()
	var found bool
	for _, frame := range f.peer.messages {
		if frame.Type == "dispatch" && frame.RunID == run.ID {
			var payload struct {
				Credential *siteAIModelCredential `json:"modelCredential"`
			}
			f.decode(frame.Payload, &payload)
			if payload.Credential == nil || payload.Credential.AgentID != second.ID || payload.Credential.SecretVersion != 1 || strings.Contains(string(frame.Payload), "fixture-key-") {
				t.Fatal("dispatch did not pin the nonsecret binding")
			}
			if resolve(siteAIKeyRequest{siteAIModelCredential: *payload.Credential, Purpose: "run", RunID: run.ID, AttemptID: frame.AttemptID}, 200) != "fixture-key-b" {
				t.Fatal("Agent rotation changed another Agent's key")
			}
			found = true
		}
	}
	if !found {
		t.Fatal("managed author did not dispatch")
	}
}

func TestADM3SelfManagedClaimPostgres(t *testing.T) {
	f := newSiteAIFixture(t)
	legacy := f.secret
	body := siteAINewAgent{RequestID: NewID(), WorkspaceID: admWorkspaceID, Name: "External Fixture", Mode: siteAISelfManaged,
		Engine: "pi", Provider: "openai-responses", Model: "fixture-model"}
	var created, replay siteAIAgentCreation
	f.decode(f.platform("POST", admAIPath+"/agents", jsonText(body), 201).Body.Bytes(), &created)
	f.decode(f.platform("POST", admAIPath+"/agents", jsonText(body), 200).Body.Bytes(), &replay)
	if created.Agent.Status != siteAIWaiting || created.Token == "" || replay.Token != "" || replay.Agent.ID != created.Agent.ID {
		t.Fatal("self managed Token delivery is not one-time")
	}
	f.secret = created.Token
	claim := func(id, denied string) *ExternalTask {
		t.Helper()
		var claim struct{ Task *ExternalTask }
		data := f.mcp("task_claim", map[string]string{"requestId": id}, denied)
		if denied == "" {
			f.decode(data, &claim)
		}
		return claim.Task
	}
	claim(NewID(), "agent_not_ready")
	control := func(method string, params any) json.RawMessage {
		t.Helper()
		payload := jsonText(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "whippet/agent/" + method, "params": params})
		r := httptest.NewRequest("POST", fixtureOrigin+"/mcp", strings.NewReader(payload)).WithContext(f.ctx)
		r.Header.Set("Authorization", "Bearer "+f.secret)
		r.Header.Set("MCP-Protocol-Version", "2025-06-18")
		w := httptest.NewRecorder()
		f.handler.ServeHTTP(w, r)
		var result struct{ Result json.RawMessage }
		f.decode(w.Body.Bytes(), &result)
		if w.Code != 200 || result.Result == nil {
			t.Fatalf("control %s failed: %d %s", method, w.Code, w.Body)
		}
		return result.Result
	}
	var registered siteAIMCPRegistration
	f.decode(control("register", siteAIMCPRegisterRequest{Engine: "pi", Provider: "openai-responses", Model: "fixture-model", Skills: []string{"test-author"}}), &registered)
	if registered.Challenge == nil {
		t.Fatal("registration skipped challenge")
	}
	var result siteAIMCPProbeResult
	f.decode(control("probe", siteAIMCPProbeRequest{RegistrationID: registered.ID, ChallengeID: registered.Challenge.ID, Status: "passed"}), &result)
	if result.Status != siteAIReady {
		t.Fatalf("probe readiness: %+v", result)
	}
	f.platform("PATCH", admAIPath+"/workspaces/"+admWorkspaceID+"/agent-routing", jsonText(map[string]any{"revision": 1, "skillId": "test-author", "agentId": created.Agent.ID}), 200)
	_, run := f.enqueueAuthor()
	f.secret = legacy
	if task := claim(NewID(), ""); task != nil {
		t.Fatal("legacy Token claimed an Agent-pinned Run")
	}
	f.secret = created.Token
	request := NewID()
	task := claim(request, "")
	if task == nil || task.RunID != run.ID {
		t.Fatal("the verified Agent did not claim its Run")
	}
	resource := admAIPath + "/resources/" + url.PathEscape("mcp:"+stringValue(created.Agent.TokenID))
	f.platform("POST", resource+"/actions/pause_claim", `{"revision":1}`, 200)
	reissue := siteAIReissueRequest{Revision: 2, WorkspaceID: admWorkspaceID, RequestID: NewID()}
	f.platform("POST", resource+"/actions/reissue_access", jsonText(reissue), 409)
	if next := claim(request, ""); next == nil || next.AttemptID != task.AttemptID {
		t.Fatal("pause invalidated the in-flight claim")
	}
	claim(NewID(), "claim_paused")
	identity := map[string]any{"runId": task.RunID, "attemptId": task.AttemptID, "leaseId": task.LeaseID}
	f.mcp("task_heartbeat", identity, "")
	identity["submitId"] = NewID()
	identity["output"] = map[string]any{"message": "已確認驗證目標。", "requestValidation": false}
	first := f.mcp("task_submit", identity, "")
	if replay := f.mcp("task_submit", identity, ""); string(first) != string(replay) {
		t.Fatal("submit retry changed the receipt")
	}
	f.platform("DELETE", "/api/workspaces/"+admWorkspaceID+"/agent-tokens/"+*created.Agent.TokenID, "", 204)
	requestBody := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	r := httptest.NewRequest("POST", fixtureOrigin+"/mcp", strings.NewReader(requestBody)).WithContext(f.ctx)
	r.Header.Set("Authorization", "Bearer "+f.secret)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked MCP credential returned %d", w.Code)
	}
	var rotated, repeated siteAIReissueResult
	reissue.Revision = 3
	f.decode(f.platform("POST", resource+"/actions/reissue_access", jsonText(reissue), 201).Body.Bytes(), &rotated)
	f.decode(f.platform("POST", resource+"/actions/reissue_access", jsonText(reissue), 200).Body.Bytes(), &repeated)
	if rotated.Agent == nil || rotated.Agent.ID != created.Agent.ID || rotated.Agent.Status != siteAIWaiting || rotated.Token == "" || rotated.Token == created.Token ||
		repeated.Token != "" || repeated.Resource.ID != rotated.Resource.ID {
		t.Fatal("rotated access did not preserve identity and one-time delivery")
	}
}
