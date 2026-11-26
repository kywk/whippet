package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const siteAIBodyLimit = 16 << 10

func decodeSiteAIJSON(raw []byte, dst any) error {
	if len(raw) > siteAIBodyLimit || !utf8.Valid(raw) {
		return ErrInvalid
	}
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' || strictJSONNoDuplicates(raw) != nil {
		return ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(dst) != nil || d.Decode(new(any)) != io.EOF {
		return ErrInvalid
	}
	return nil
}

func readSiteAIBody(w http.ResponseWriter, r *http.Request, dst any) (map[string]json.RawMessage, error) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, siteAIBodyLimit))
	if err != nil || decodeSiteAIJSON(raw, dst) != nil {
		return nil, ErrInvalid
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, ErrInvalid
	}
	return fields, nil
}

func siteAIPageQuery(r *http.Request, optional ...string) (after string, limit int, err error) {
	query := r.URL.Query()
	for key, values := range query {
		if len(values) != 1 || key != "after" && key != "limit" && !slices.Contains(optional, key) {
			return "", 0, ErrInvalid
		}
	}
	limit = 50
	if query.Has("limit") {
		limit, err = strconv.Atoi(query.Get("limit"))
		if err != nil || limit < 1 || limit > 100 {
			return "", 0, ErrInvalid
		}
	}
	return query.Get("after"), limit, nil
}

func writeSiteAIError(w http.ResponseWriter, err error) bool {
	var code siteAIError
	if !errors.As(err, &code) {
		return false
	}
	status := http.StatusConflict
	message := "資源狀態已改變，請重新載入。"
	switch code {
	case errSiteAIUnsupported:
		status, message = http.StatusUnprocessableEntity, "執行端不支援這組設定。"
	case errSiteAIProposalRejected:
		status, message = http.StatusUnprocessableEntity, "請補充 Agent 用途或指定支援的引擎與模型，也可以直接填寫表單。"
	case errSiteAISensitiveInput:
		status, message = http.StatusUnprocessableEntity, "請移除提案文字中的憑證，並使用表單的專用金鑰欄位。"
	case errSiteAIProposalUnavailable:
		status, message = http.StatusServiceUnavailable, "AI Manager 暫時無法產生提案，可以重試或直接填寫表單。"
	case errSiteAITransport:
		status, message = http.StatusBadRequest, "憑證操作需要 HTTPS 或直接 loopback 連線。"
	case errSiteAIDisabled:
		status, message = http.StatusServiceUnavailable, "MCP 尚未啟用。"
	case errSiteAIArchiving:
		message = "工作區封存中，暫停接受新工作。"
	case errSiteAIArchived:
		message = "工作區已封存。"
	case errSiteAINotReady:
		message = "所選 Agent 尚未就緒。"
	case errSiteAIBusy:
		message = "請等候既有工作完成並確認資源回收。"
	case errSiteAIIdempotency:
		message = "相同請求識別已用於另一組輸入。"
	case errSiteAIAction:
		message = "此資源不支援該操作。"
	}
	writeError(w, status, string(code), message)
	return true
}

type siteAIAPIHandler func(http.ResponseWriter, *http.Request, *Postgres, platformActor)

func (a *API) registerSiteAIRoutes(mux *http.ServeMux) {
	handle := func(pattern string, next siteAIAPIHandler) {
		mux.Handle(pattern, boundedRequest(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor, _, ok := a.authenticatePlatform(w, r, false)
			if !ok {
				return
			}
			if actor.user.Role != superAdmin {
				a.failSiteAI(w, r, actor, errForbidden)
				return
			}
			p, ok := a.store.(*Postgres)
			if !ok {
				a.fail(w, ErrConflict)
				return
			}
			next(w, r, p, actor)
		})))
	}
	handle("GET /api/admin/ai/resources", a.siteAIResources)
	handle("GET /api/admin/ai/resources/{resourceId}", a.siteAIResource)
	handle("POST /api/admin/ai/resources/{resourceId}/actions/{action}", a.siteAIResourceAction)
	handle("GET /api/admin/ai/options", a.siteAIOptions)
	handle("GET /api/admin/ai/agents", a.siteAIAgents)
	handle("POST /api/admin/ai/agents", a.siteAICreateAgent)
	handle(siteAIProposalRoute, a.siteAIProposeAgent)
	handle("GET /api/admin/ai/agents/{agentId}", a.siteAIAgent)
	handle("POST /api/admin/ai/agents/{agentId}/retry", a.siteAIRetryAgent)
	handle("PUT /api/admin/ai/agents/{agentId}/model-key", a.siteAIChangeKey)
	handle("DELETE /api/admin/ai/agents/{agentId}/model-key", a.siteAIChangeKey)
	handle("GET /api/admin/ai/workspaces/{id}/agent-routing", a.siteAIRouting)
	handle("PATCH /api/admin/ai/workspaces/{id}/agent-routing", a.siteAIRouting)
	mux.Handle("POST /api/manager/agent-keys/resolve", boundedRequest(a.ManagerAuth(http.HandlerFunc(a.siteAIResolveKey))))
}

func (a *API) failSiteAI(w http.ResponseWriter, r *http.Request, actor platformActor, err error) {
	if p, ok := a.store.(*Postgres); ok && browserWrite(r.Method) {
		var item managementAudit
		switch {
		case r.Pattern == siteAIProposalRoute:
			item = platformAudit(actor, "propose_agent", "agent", "", nil)
		case r.PathValue("resourceId") != "":
			item = platformAudit(actor, "resource_action", "resource", r.PathValue("resourceId"), nil)
		case ValidID(r.PathValue("agentId")):
			item = platformAudit(actor, "agent_action", "agent", r.PathValue("agentId"), nil)
		case ValidID(r.PathValue("id")):
			workspace := r.PathValue("id")
			item = platformAudit(actor, "set_agent_routing", "workspace", workspace, &workspace)
		default:
			item = platformAudit(actor, "create_agent", "agent", "", nil)
		}
		outcome, code := "denied", "internal_error"
		var siteError siteAIError
		switch {
		case errors.As(err, &siteError):
			code = string(siteError)
			if siteError == errSiteAIProposalUnavailable {
				outcome = "failed"
			}
		case errors.Is(err, errForbidden):
			code = "forbidden"
		case errors.Is(err, ErrInvalid):
			code = "invalid_request"
		case errors.Is(err, ErrNotFound):
			code = "not_found"
		case errors.Is(err, ErrConflict):
			code = "conflict"
		case errors.Is(err, ErrCredentialUnavailable):
			code = "credential_unavailable"
		case errors.Is(err, ErrSecretsUnavailable):
			outcome, code = "failed", "secrets_unavailable"
		default:
			outcome = "failed"
		}
		if err := item.record(r.Context(), p.DB, outcome, &code); err != nil {
			a.log.Error("site AI audit failed", "action", item.action, "code", code)
		}
	}
	a.fail(w, err)
}

func (a *API) siteAIResources(w http.ResponseWriter, r *http.Request, p *Postgres, _ platformActor) {
	after, limit, err := siteAIPageQuery(r)
	if after != "" {
		_, _, ok := siteAIResourceID(after)
		if !ok {
			err = ErrInvalid
		}
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	items, err := p.siteAIResources(r.Context(), after, limit, p.siteAIConnection())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (a *API) siteAIResource(w http.ResponseWriter, r *http.Request, p *Postgres, _ platformActor) {
	if len(r.URL.Query()) != 0 {
		a.fail(w, ErrInvalid)
		return
	}
	item, err := readSiteAIResource(r.Context(), p.DB, r.PathValue("resourceId"), p.siteAIConnection())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (a *API) siteAIResourceAction(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor) {
	resource, action := r.PathValue("resourceId"), r.PathValue("action")
	source, id, valid := siteAIResourceID(resource)
	if !valid {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	if action == "reissue_access" && source == siteAIMCP {
		a.siteAIReissueAccess(w, r, p, actor, id)
		return
	}
	var err error
	accepted := false
	if source == siteAIManager {
		err = a.changeSiteAIManager(w, r, p, actor, id, action)
	} else {
		accepted, err = a.changeSiteAIMCP(w, r, p, actor, id, action)
	}
	if err != nil {
		a.failSiteAI(w, r, actor, err)
		return
	}
	a.wakeSiteAI(r)
	item, err := readSiteAIResource(r.Context(), p.DB, resource, p.siteAIConnection())
	if err != nil {
		a.fail(w, err)
		return
	}
	status := http.StatusOK
	if accepted || action == "drain_remove" && item.Control == "draining" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, item)
}

func (a *API) changeSiteAIManager(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor, id, action string) error {
	var request struct {
		Revision   int      `json:"revision"`
		Workspaces []string `json:"workspaceIds"`
	}
	keys, err := readSiteAIBody(w, r, &request)
	if err != nil || request.Revision < 1 {
		return ErrInvalid
	}
	switch action {
	case "assign":
		if keys["workspaceIds"] == nil || len(request.Workspaces) > 100 || request.Workspaces != nil && len(request.Workspaces) == 0 {
			return ErrInvalid
		}
		for i, id := range request.Workspaces {
			if !ValidID(id) {
				return ErrInvalid
			}
			request.Workspaces[i] = strings.ToLower(id)
		}
		slices.Sort(request.Workspaces)
		for i := 1; i < len(request.Workspaces); i++ {
			if request.Workspaces[i] == request.Workspaces[i-1] {
				return ErrInvalid
			}
		}
	case "pause_dispatch", "resume_dispatch", "drain_remove":
		if len(keys) != 1 {
			return ErrInvalid
		}
	default:
		return errSiteAIAction
	}
	return p.setSiteAIManager(r.Context(), actor, id, action, request.Revision, request.Workspaces)
}

func (a *API) changeSiteAIMCP(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor, id, action string) (bool, error) {
	var request siteAITokenAction
	keys, err := readSiteAIBody(w, r, &request)
	if err != nil {
		return false, err
	}
	switch action {
	case "pause_claim", "resume_claim", "revoke_access":
		if len(keys) != 1 || request.Revision < 1 {
			return false, ErrInvalid
		}
	case "cancel_run":
		if len(keys) != 3 || !validExternalIDs(request.RunID, request.AttemptID, request.LeaseID) {
			return false, ErrInvalid
		}
	case "close_browser":
		if len(keys) != 2 || !ValidID(request.SessionID) || !ValidID(request.LeaseID) {
			return false, ErrInvalid
		}
	default:
		return false, errSiteAIAction
	}
	return p.changeSiteAIToken(r.Context(), actor, id, action, request)
}

func (a *API) siteAIReissueAccess(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor, tokenID string) {
	if !protectedCredentialTransport(r) {
		a.failSiteAI(w, r, actor, errSiteAITransport)
		return
	}
	var body siteAIReissueRequest
	if _, err := readSiteAIBody(w, r, &body); err != nil || body.Revision < 1 || !ValidID(body.WorkspaceID) || !ValidID(body.RequestID) {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	result, created, err := p.reissueSiteAIToken(r.Context(), actor, tokenID, body, a.adminToken != "")
	if err != nil {
		a.failSiteAI(w, r, actor, err)
		return
	}
	a.wakeSiteAI(r)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, result)
}

func (a *API) siteAIOptions(w http.ResponseWriter, r *http.Request, p *Postgres, _ platformActor) {
	workspaces := r.URL.Query()["workspaceId"]
	if len(r.URL.Query()) != 1 || len(workspaces) != 1 || !ValidID(workspaces[0]) {
		a.fail(w, ErrInvalid)
		return
	}
	result, err := p.siteAIOptions(r.Context(), strings.ToLower(workspaces[0]), a.adminToken != "", p.siteAIConnection())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) siteAIAgents(w http.ResponseWriter, r *http.Request, p *Postgres, _ platformActor) {
	after, limit, err := siteAIPageQuery(r, "workspaceId")
	workspace := r.URL.Query().Get("workspaceId")
	if err != nil || (after != "" && !ValidID(after)) || (workspace != "" && !ValidID(workspace)) {
		a.fail(w, ErrInvalid)
		return
	}
	result, err := p.listSiteAIAgents(r.Context(), workspace, after, limit, p.siteAIConnection())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) siteAICreateAgent(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor) {
	if !protectedCredentialTransport(r) {
		a.failSiteAI(w, r, actor, errSiteAITransport)
		return
	}
	var body siteAINewAgent
	keys, err := readSiteAIBody(w, r, &body)
	if err != nil || (body.Mode == siteAISelfManaged && (keys["apiKey"] != nil || keys["profileId"] != nil)) {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	var requestKey []byte
	if p.Secrets != nil {
		requestKey = p.Secrets.siteAIRequestKey[:]
	}
	result, created, err := p.createSiteAIAgent(r.Context(), actor, body, requestKey, a.adminToken != "", p.siteAIConnection())
	if err != nil {
		a.failSiteAI(w, r, actor, err)
		return
	}
	a.wakeSiteAI(r)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, result)
}

func (a *API) siteAIAgent(w http.ResponseWriter, r *http.Request, p *Postgres, _ platformActor) {
	id := r.PathValue("agentId")
	if !ValidID(id) || len(r.URL.Query()) != 0 {
		a.fail(w, ErrInvalid)
		return
	}
	row, err := readSiteAIAgent(r.Context(), p.DB, id, false)
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, presentSiteAIAgent(row, p.siteAIConnection(), time.Now()))
}

func (a *API) siteAIRetryAgent(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor) {
	id := r.PathValue("agentId")
	var body struct {
		Revision int `json:"revision"`
	}
	if _, err := readSiteAIBody(w, r, &body); err != nil || !ValidID(id) || body.Revision < 1 {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	item, err := p.retrySiteAIAgent(r.Context(), actor, id, body.Revision, p.siteAIConnection())
	if err != nil {
		a.failSiteAI(w, r, actor, err)
		return
	}
	a.wakeSiteAI(r)
	status := http.StatusOK
	if item.Status == siteAIVerifying {
		status = http.StatusAccepted
	}
	writeJSON(w, status, item)
}

func (a *API) siteAIChangeKey(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor) {
	if !protectedCredentialTransport(r) {
		a.failSiteAI(w, r, actor, errSiteAITransport)
		return
	}
	id := r.PathValue("agentId")
	var body struct {
		Version   *int    `json:"expectedSecretVersion"`
		Key       *string `json:"apiKey"`
		Confirmed *bool   `json:"confirmed"`
	}
	keys, err := readSiteAIBody(w, r, &body)
	if err != nil || !ValidID(id) || body.Version == nil || len(keys) != 2 ||
		(r.Method == http.MethodPut && body.Key == nil) ||
		(r.Method == http.MethodDelete && (body.Confirmed == nil || !*body.Confirmed)) {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	item, err := p.changeSiteAIKey(r.Context(), actor, id, *body.Version, body.Key, p.siteAIConnection())
	if err != nil {
		a.failSiteAI(w, r, actor, err)
		return
	}
	a.wakeSiteAI(r)
	writeJSON(w, http.StatusOK, item)
}

func (a *API) siteAIRouting(w http.ResponseWriter, r *http.Request, p *Postgres, actor platformActor) {
	id := strings.ToLower(r.PathValue("id"))
	if !ValidID(id) {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	if r.Method == http.MethodGet {
		item, err := readSiteAIRouting(r.Context(), p.DB, id)
		if err != nil {
			a.fail(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
		return
	}
	var body struct {
		Revision int     `json:"revision"`
		SkillID  string  `json:"skillId"`
		AgentID  *string `json:"agentId"`
	}
	keys, err := readSiteAIBody(w, r, &body)
	if err != nil || body.Revision < 1 || keys["agentId"] == nil || !slices.Contains(siteAIPrimarySkills, body.SkillID) ||
		(body.AgentID != nil && !ValidID(*body.AgentID)) {
		a.failSiteAI(w, r, actor, ErrInvalid)
		return
	}
	if body.AgentID != nil {
		*body.AgentID = strings.ToLower(*body.AgentID)
	}
	item, err := p.setSiteAIRouting(r.Context(), actor, id, body.SkillID, body.AgentID, body.Revision, p.siteAIConnection())
	if err != nil {
		a.failSiteAI(w, r, actor, err)
		return
	}
	a.wakeSiteAI(r)
	writeJSON(w, http.StatusOK, item)
}

func (a *API) siteAIResolveKey(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.TLS == nil {
		a.fail(w, errSiteAITransport)
		return
	}
	p, ok := a.store.(*Postgres)
	if !ok {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	var req siteAIKeyRequest
	keys, err := readSiteAIBody(w, r, &req)
	if err != nil || !req.valid() || req.Purpose == "run" && len(keys) != 5 || req.Purpose == "probe" && len(keys) != 4 {
		a.fail(w, ErrInvalid)
		return
	}
	conn := p.siteAIConnection()
	nonces := r.Header.Values("X-Whippet-Manager-Session")
	if len(nonces) != 1 || conn.Nonce == "" || subtle.ConstantTimeCompare([]byte(nonces[0]), []byte(conn.Nonce)) != 1 {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	result, err := p.resolveSiteAIKey(r.Context(), conn, req)
	if err != nil {
		a.fail(w, err)
		return
	}
	if current := p.siteAIConnection(); current.Nonce != conn.Nonce || !current.online(time.Now()) {
		a.fail(w, ErrCredentialUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (a *API) wakeSiteAI(r *http.Request) {
	if a.engine != nil {
		a.engine.refreshLive(r.Context())
		a.engine.Wake()
	}
}
