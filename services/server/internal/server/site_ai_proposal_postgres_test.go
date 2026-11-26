//go:build integration

package server

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestADM3AgentProposalPostgres(t *testing.T) {
	f := newArchiveFixture(t)
	const proposalPath = admAIPath + "/agents/proposal"
	const serviceKey = "fixture-ai-manager-service-key"
	const pastedKey = "fixture-pasted-key-value"
	const instruction = "用 Pi 建立自管 Agent，模型 fixture-model，名稱是付款回歸。"
	var calls atomic.Int64
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer "+serviceKey {
			t.Error("expected the existing Responses endpoint and service authorization")
		}
		raw, err := io.ReadAll(r.Body)
		var req struct {
			Input           string            `json:"input"`
			Tools           []json.RawMessage `json:"tools"`
			Store           *bool             `json:"store"`
			MaxOutputTokens int               `json:"max_output_tokens"`
		}
		if err != nil || json.Unmarshal(raw, &req) != nil || req.Tools == nil || len(req.Tools) != 0 ||
			req.Store == nil || *req.Store || req.MaxOutputTokens != 1024 || bytes.Contains(raw, []byte(serviceKey)) ||
			bytes.Contains(raw, []byte(pastedKey)) || bytes.Contains(raw, []byte(admWorkspaceID)) {
			t.Error("proposal model body escaped its data or tool limits")
			http.Error(w, "fixture error", http.StatusBadRequest)
			return
		}
		var data struct {
			Instruction string                `json:"instruction"`
			Options     siteAIProposalOptions `json:"options"`
		}
		if json.Unmarshal([]byte(req.Input), &data) != nil || data.Instruction == "" || len(data.Options.SelfManaged) == 0 {
			t.Error("expected a bounded instruction and selectable options")
			http.Error(w, "fixture error", http.StatusBadRequest)
			return
		}
		choice := map[string]any{"name": "付款回歸", "mode": "self_managed", "engine": "pi", "provider": "openai-responses", "model": "fixture-model", "profileId": nil}
		switch data.Instruction {
		case "測試上游失敗":
			http.Error(w, serviceKey, http.StatusBadGateway)
			return
		case "測試模型逾時":
			<-r.Context().Done()
			return
		case "測試不支援的配置":
			choice["engine"] = "builtin"
		case "測試模型帶出憑證":
			choice["name"] = serviceKey
		case "測試模型跨工作區":
			choice["workspaceId"] = NewID()
		case "測試提出期間封存":
			if _, err := f.store.DB.ExecContext(r.Context(), `UPDATE workspaces SET archive_status='archived',archive_mode='drain',
 archive_started_at=now(),archived_at=now() WHERE id=$1`, admWorkspaceID); err != nil {
				t.Error(err)
				http.Error(w, "fixture error", http.StatusBadRequest)
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "completed", "output_text": jsonText(choice)})
	}))
	t.Cleanup(provider.Close)
	var logs bytes.Buffer
	log := slog.New(slog.NewTextHandler(&logs, nil))
	api := NewAPI(f.store, f.files, f.engine, "fixture-manager", log).WithAdminAccess(fixtureAdminKey, fixtureOrigin)
	client := newAuthorIntentClient(provider.URL+"/v1", "fixture-control-model", serviceKey)
	if client.client.Timeout != 15*time.Second {
		t.Fatal("proposal must use the existing model timeout")
	}
	client.client.Transport = provider.Client().Transport
	api.siteAIProposer = client.proposeSiteAIAgent
	f.handler = api.Handler(nil)
	// Sessions are local to each API. Recreate the Site Manager session first.
	f.cookie = nil
	f.cookie = f.platform("POST", "/api/dev-login", `{"userId":"dev-site-admin"}`, 200).Result().Cookies()[0]
	request := func(text string) string {
		return jsonText(map[string]string{"workspaceId": admWorkspaceID, "instruction": text})
	}
	f.platform("POST", proposalPath, request(instruction), 403)
	f.platform("POST", "/api/dev-logout", "", 204)
	f.cookie = nil
	f.cookie = f.platform("POST", "/api/dev-login", `{"userId":"dev-admin"}`, 200).Result().Cookies()[0]
	f.platform("POST", proposalPath, jsonText(map[string]string{"workspaceId": NewID(), "instruction": instruction}), 404)
	f.platform("POST", proposalPath, jsonText(map[string]string{"workspaceId": admWorkspaceID, "instruction": instruction, "apiKey": pastedKey}), 400)
	checkCode := func(text, code string, status int) {
		t.Helper()
		out := f.platform("POST", proposalPath, request(text), status)
		var body struct{ Error struct{ Code string } }
		f.decode(out.Body.Bytes(), &body)
		if body.Error.Code != code || strings.Contains(out.Body.String(), serviceKey) || strings.Contains(out.Body.String(), pastedKey) {
			t.Errorf("expected sanitized error %s", code)
		}
	}
	checkCode("建立自管 Agent，API Key 是 "+pastedKey, "sensitive_input", 422)
	checkCode("配置指示 "+serviceKey, "sensitive_input", 422)
	checkCode("以 sk-fixturenotarealsecret 建立", "sensitive_input", 422)
	if calls.Load() != 0 {
		t.Fatal("denied request reached the model")
	}

	response := f.platform("POST", proposalPath, request(instruction), 200)
	var out struct {
		Proposal struct {
			WorkspaceID string `json:"workspaceId"`
			siteAIProposalChoice
		}
	}
	f.decode(response.Body.Bytes(), &out)
	if out.Proposal.WorkspaceID != admWorkspaceID || out.Proposal.Mode != siteAISelfManaged || out.Proposal.ProfileID != nil || out.Proposal.Name != "付款回歸" ||
		response.Header().Get("Cache-Control") != "no-store" || calls.Load() != 1 {
		t.Fatalf("invalid proposal: %+v", out)
	}
	var agents, tokens, receipts int
	if err := f.store.DB.QueryRowContext(f.ctx, `SELECT (SELECT count(*) FROM site_ai_agents),
 (SELECT count(*) FROM agent_tokens),(SELECT count(*) FROM site_ai_requests)`).Scan(&agents, &tokens, &receipts); err != nil || agents != 0 || tokens != 1 || receipts != 0 {
		t.Fatalf("proposal created side effects: agents=%d tokens=%d receipts=%d err=%v", agents, tokens, receipts, err)
	}
	create := siteAINewAgent{RequestID: NewID(), WorkspaceID: out.Proposal.WorkspaceID, Name: "付款回歸（人工修正）", Mode: out.Proposal.Mode,
		Engine: out.Proposal.Engine, Provider: out.Proposal.Provider, Model: out.Proposal.Model}
	var created siteAIAgentCreation
	f.decode(f.platform("POST", admAIPath+"/agents", jsonText(create), 201).Body.Bytes(), &created)
	if created.Agent.Name != create.Name || created.Token == "" || calls.Load() != 1 {
		t.Fatal("confirmation must create the edited configuration through the normal endpoint")
	}
	checkCode("測試上游失敗", "proposal_unavailable", 503)
	client.client.Timeout = 150 * time.Millisecond
	checkCode("測試模型逾時", "proposal_unavailable", 503)
	client.client.Timeout = 15 * time.Second
	checkCode("測試不支援的配置", "proposal_rejected", 422)
	checkCode("測試模型帶出憑證", "proposal_rejected", 422)
	checkCode("測試模型跨工作區", "proposal_rejected", 422)
	checkCode("測試提出期間封存", "workspace_archived", 409)
	checkCode(instruction, "workspace_archived", 409)
	if calls.Load() != 7 {
		t.Fatalf("archived Workspace reached the model, calls=%d", calls.Load())
	}
	var audit string
	if err := f.store.DB.QueryRowContext(f.ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(a))::text,'') FROM site_management_audit a`).Scan(&audit); err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{pastedKey, serviceKey, instruction} {
		if strings.Contains(audit, private) || strings.Contains(logs.String(), private) {
			t.Error("proposal content or credentials reached audit/logging")
		}
	}
}
