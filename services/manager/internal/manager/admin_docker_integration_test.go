package manager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// The supplied Worker image inherits the v14 build and replaces only the
// provider transport with a fixture accepting the two synthetic keys below.
func TestADM14DockerManagedProbeAndAuthor(t *testing.T) {
	image := os.Getenv("WHIPPET_ADM14_SYNTHETIC_WORKER_IMAGE")
	if image == "" {
		t.Skip("set WHIPPET_ADM14_SYNTHETIC_WORKER_IMAGE to the isolated provider fixture")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	nonce := strings.Repeat("a", 32)
	type binding struct {
		modelCredential
		WorkspaceID string
		Key         string
	}
	var pins, uploads sync.Map
	backend := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if r.URL.Path == "/api/manager/agent-keys/resolve" {
			var request map[string]any
			if r.Header.Get("X-Whippet-Manager-Session") != nonce || json.NewDecoder(r.Body).Decode(&request) != nil {
				w.WriteHeader(http.StatusConflict)
				return
			}
			id := request["operationId"]
			if request["purpose"] == "run" {
				id = request["attemptId"]
			}
			pin, found := pins.Load(id)
			if !found {
				w.WriteHeader(http.StatusConflict)
				return
			}
			b := pin.(binding)
			if request["agentId"] != b.AgentID || request["secretVersion"] != float64(b.SecretVersion) {
				w.WriteHeader(http.StatusConflict)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			request["workspaceId"], request["apiKey"] = b.WorkspaceID, b.Key
			_ = json.NewEncoder(w).Encode(request)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/artifacts/author.json") {
			raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
			if err == nil {
				uploads.Store(r.Header.Get("X-Attempt-Id"), raw)
			}
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer backend.Close()
	dir := t.TempDir()
	ca := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: backend.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	m, err := New(Config{ServerURL: backend.URL, ServerCAFile: ca, ManagerID: "adm14-test-" + newID(), Token: "fixture", WorkDir: dir, WorkerImage: image, MaxWorkers: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	m.configureAdmin(ctx)
	if m.admin == nil || !workerContentID.MatchString(m.admin.WorkerRevision) {
		t.Fatal("Worker capability inspection did not pin a local image ID")
	}
	m.keySession = &modelKeySession{ctx: ctx, nonce: nonce}
	a, b := admFixture(t), admFixture(t)
	for _, item := range []struct {
		Request provisionRequest
		Engine  string
		Version int64
		Key     string
		Code    string
		Message string
	}{
		{a, "builtin", 1, "adm-synthetic-key-wrong", "provider_auth_failed", ""},
		{b, "vercel", 1, "adm-synthetic-key-b", "", "Agent B"},
		{a, "builtin", 2, "adm-synthetic-key-a", "", "Agent A"},
		{a, "pi", 2, "adm-synthetic-key-a", "", "Agent A"},
	} {
		p := item.Request
		p.OperationID, p.SecretVersion, p.DeadlineAt = newID(), item.Version, time.Now().Add(30*time.Second).UTC()
		p.Runtime.Engine = item.Engine
		runtime, _ := json.Marshal(p.Runtime.runtimeData)
		p.Runtime.SHA256 = fmt.Sprintf("%x", sha256.Sum256(runtime))
		pins.Store(p.OperationID, binding{p.credential(), p.WorkspaceID, item.Key})
		if err := m.acceptProvision(ctx, ctx, message(m.cfg.ManagerID, "agent.provision", "", "", p)); err != nil {
			t.Fatal(err)
		}
		m.wg.Wait()
		result := m.provisions[p.OperationID].Result
		if result == nil || !result.Reclaimed {
			t.Fatalf("%s probe did not confirm Docker reclamation", item.Engine)
		}
		if item.Code != "" {
			if result.Status != "failed" || result.Code == nil || *result.Code != item.Code {
				t.Fatalf("%s probe classified the wrong Key incorrectly: %s %v", item.Engine, result.Status, result.Code)
			}
			continue
		}
		if result.Status != "succeeded" {
			code := ""
			if result.Code != nil {
				code = *result.Code
			}
			t.Fatalf("%s probe reported %s/%s", item.Engine, result.Status, code)
		}
		attemptID := newID()
		pins.Store(attemptID, binding{p.credential(), p.WorkspaceID, item.Key})
		d := Dispatch{Kind: "author", TimeoutMS: 15000, Author: dockerAuthorFixture(t, p.Runtime), WorkspaceID: p.WorkspaceID,
			TestID: json.RawMessage(`"` + newID() + `"`), ModelCredential: &modelCredential{p.AgentID, p.SecretVersion}}
		// The fixture uses the normal dispatch handler and runs offline only for
		// ACK/result delivery. Key resolution and artifact upload use real TLS.
		_ = m.accept(ctx, message(m.cfg.ManagerID, "dispatch", newID(), attemptID, d))
		m.wg.Wait()
		run := journalRecord(m, attemptID)
		body, found := uploads.Load(attemptID)
		if run.Result == nil || run.Result.Status != "succeeded" || !run.Reclaimed || !found ||
			!bytes.Contains(body.([]byte), []byte(item.Message)) || bytes.Contains(body.([]byte), []byte("adm-synthetic-key-")) {
			t.Fatalf("%s normal author entry failed or used the wrong Agent Key", item.Engine)
		}
	}
	if err := filepath.WalkDir(filepath.Join(dir, "journal"), func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		body, err := os.ReadFile(path)
		if bytes.Contains(body, []byte("adm-synthetic-key-")) {
			t.Fatal("journal retained a Key")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func dockerAuthorFixture(t *testing.T, runtime runtimeSnapshot) *AuthorTask {
	t.Helper()
	root := "../../../../runtimes/worker/skills/test-author"
	main, err := os.ReadFile(filepath.Join(root, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	var config struct {
		Budget     json.RawMessage
		Model      json.RawMessage
		References []struct{ ID, SHA256 string }
	}
	if err != nil || json.Unmarshal(manifest, &config) != nil {
		t.Fatal("invalid packaged test-author manifest")
	}
	references := map[string]string{}
	for _, r := range config.References {
		references[r.ID] = r.SHA256
	}
	a := v10Author(t)
	a.AllowedTools = &[]string{"read_draft"}
	a.Skills, _ = json.Marshal([]map[string]any{{"id": "test-author", "version": "1", "sha256": fmt.Sprintf("%x", sha256.Sum256(main)),
		"manifestSha256": fmt.Sprintf("%x", sha256.Sum256(manifest)), "referenceHashes": references}})
	a.Runtime, _ = json.Marshal(runtime)
	a.Budget, a.Model = config.Budget, config.Model
	return a
}
