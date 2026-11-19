//go:build integration

package server

import (
	"context"
	"errors"
	"strings"
	"testing"
)

const similarPublishedID = "10000000-0000-4000-8000-000000000001"
const similarMetadataMarker = "既有說明専用標記"

func newTestReviewFixture(t *testing.T, engine string) (m7DBHarness, Test, EditingSession, Test) {
	t.Helper()
	p, ctx := workspaceTestDB(t)
	if err := p.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	manualSeedVersions(t, p, ctx)
	files, err := NewLocalArtifacts(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p.Artifacts = files
	if err = p.RegisterManager(ctx, "m7-test", 1); err != nil {
		t.Fatal(err)
	}
	existing, err := p.Test(ctx, similarPublishedID)
	if err != nil {
		t.Fatal(err)
	}
	description := "確認購物車套用折扣後的結帳總額。" + similarMetadataMarker
	existing, err = p.PatchTestMetadata(ctx, existing.ID, TestMetadataPatch{
		MetadataRevision: existing.MetadataRevision, Description: &description, Tags: &[]string{"購物車", "結帳"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if engine == "external" {
		w, err := p.Workspace(ctx, existing.WorkspaceID)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := p.SetAuthorEngine(ctx, w.ID, w.Revision, engine); err != nil {
			t.Fatal(err)
		}
	}
	source, err := p.CreateTest(ctx, existing.WorkspaceID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	session, _, err := p.StartEditingSession(ctx, source.ID)
	if err != nil {
		t.Fatal(err)
	}
	return m7DBHarness{t, p, ctx, files}, source, session, existing
}

func TestSimilarNewTestChoicesAndContextIsolation(t *testing.T) {
	for _, engine := range []string{"builtin", "external"} {
		t.Run(engine, func(t *testing.T) {
			h, source, session, target := newTestReviewFixture(t, engine)
			p, ctx := h.p, h.ctx
			other, err := p.CreateWorkspace(ctx, "其他 Workspace")
			if err != nil {
				t.Fatal(err)
			}
			foreign, err := p.CreateTest(ctx, other.ID, "購物車結帳總額", "核對折扣後的購物車結帳總額")
			if err != nil {
				t.Fatal(err)
			}
			foreignVersion := NewID()
			if _, err := p.DB.ExecContext(ctx, `INSERT INTO test_versions
 (id,test_id,version,source_revision,script,script_hash,timeout_ms,workspace_settings,script_origin)
 SELECT $1,$2,1,source_revision,script,script_hash,timeout_ms,workspace_settings,script_origin FROM test_versions WHERE id=$3`,
				foreignVersion, foreign.ID, *target.PublishedVersionID); err != nil {
				t.Fatal(err)
			}
			if _, err := p.DB.ExecContext(ctx, `UPDATE tests SET published_version_id=$2 WHERE id=$1`, foreign.ID, foreignVersion); err != nil {
				t.Fatal(err)
			}
			rev := session.Draft.Revision
			const first = "我想驗證購物車的折扣。"
			const request = "核對折扣後的結帳總額。"
			reviews := 0
			p.NewTestReview = func(_ context.Context, messages []ChatMessage, candidates []similarTestCandidate) (string, error) {
				reviews++
				if len(candidates) != 2 || candidates[0].ID != target.ID || !strings.Contains(candidates[0].Description, similarMetadataMarker) ||
					strings.Join(candidates[0].Tags, ",") != "購物車,結帳" {
					t.Fatal("shortlist omitted relevant metadata or admitted an out-of-scope test")
				}
				if messages[len(messages)-1].Content == first {
					return "", nil
				}
				if engine == "builtin" && messages[0].Content != first {
					t.Fatal("review did not receive the earlier purpose")
				}
				return target.ID, nil
			}
			if engine == "builtin" {
				sub, err := p.CreateAuthor(ctx, source.ID, session.ID, first, rev)
				if err != nil || sub.SimilarTest != nil || sub.Run.ID == "" {
					t.Fatalf("unmatched request did not proceed: %v", err)
				}
				a := h.claim(sub.Run.ID)
				h.upload(a, "author.json", `{"message":"請說明要檢查的折扣結果。","requestValidation":false}`)
				h.complete(a, "succeeded")
				h.release()
			}
			proposal, err := p.CreateAuthor(ctx, source.ID, session.ID, request, rev)
			if err != nil || proposal.Run.ID != "" || proposal.SimilarTest == nil || proposal.SimilarTest.TestID != target.ID {
				t.Fatalf("match should wait before creating a Run: %+v %v", proposal, err)
			}
			id := proposal.SimilarTest.ID
			view, err := p.Conversation(ctx, source.ID, session.ID)
			if err != nil || view.SimilarTest == nil || view.SimilarTest.ID != id || view.ActiveRunID != nil {
				t.Fatalf("pending choice was not restored: %+v %v", view, err)
			}
			retry, err := p.CreateAuthor(ctx, source.ID, session.ID, request, rev)
			if err != nil || retry.SimilarTest == nil || retry.SimilarTest.ID != id {
				t.Fatal("lost response replaced the pending choice", err)
			}
			if _, err := p.CreateAuthor(ctx, source.ID, session.ID, "請直接產稿", rev); !errors.Is(err, ErrSimilarTestDecision) {
				t.Fatal("pending choice allowed another author turn", err)
			}
			if _, err := p.DecideSimilarTest(ctx, source.ID, session.ID, NewID(), rev, "continue"); !errors.Is(err, ErrConflict) {
				t.Fatal("unknown suggestion was accepted", err)
			}
			if _, err := p.DecideSimilarTest(ctx, source.ID, session.ID, id, rev+1, "edit"); !errors.Is(err, ErrConflict) {
				t.Fatal("stale revision was accepted", err)
			}
			var token AgentToken
			if engine == "external" {
				token, _, err = p.CreateAgentToken(ctx, source.WorkspaceID, "相似測試外部接單")
				if err != nil {
					t.Fatal(err)
				}
				if task, err := p.ClaimExternalAuthor(ctx, token, NewID()); err != nil || task != nil {
					t.Fatal("external agent obtained a pending author task", err)
				}
			}
			decision, err := p.DecideSimilarTest(ctx, source.ID, session.ID, id, rev, "edit")
			if err != nil || decision.Test == nil || decision.Test.ID != target.ID || decision.Test.ActiveEditingSession == nil ||
				stringValue(decision.Test.PublishedVersionID) != *target.PublishedVersionID || decision.Run != nil {
				t.Fatalf("edit choice did not open the published candidate: %+v %v", decision, err)
			}
			reopened, err := p.DecideSimilarTest(ctx, source.ID, session.ID, id, rev, "edit")
			if err != nil || reopened.Test.ActiveEditingSession.ID != decision.Test.ActiveEditingSession.ID {
				t.Fatal("edit replay created another editing session", err)
			}

			// A failed admission must leave the saved choice available for a retry.
			p.AuthorIntent = func(context.Context, string, []ChatMessage) error { return ErrAuthorPolicy }
			if _, err := p.DecideSimilarTest(ctx, source.ID, session.ID, id, rev, "continue"); !errors.Is(err, ErrAuthorPolicy) {
				t.Fatal("continue bypassed author intent", err)
			}
			p.AuthorIntent = allowFixtureAuthorIntent
			continued, err := p.DecideSimilarTest(ctx, source.ID, session.ID, id, rev, "continue")
			if err != nil || continued.Run == nil || continued.Run.AuthorEngine != engine {
				t.Fatalf("continue failed: %+v %v", continued, err)
			}
			replayed, err := p.DecideSimilarTest(ctx, source.ID, session.ID, id, rev, "continue")
			if err != nil || replayed.Run == nil || replayed.Run.ID != continued.Run.ID {
				t.Fatal("continue replay duplicated the author turn", err)
			}
			var raw string
			if err := p.DB.QueryRowContext(ctx, `SELECT author_payload::text FROM runs WHERE id=$1`, continued.Run.ID).Scan(&raw); err != nil ||
				strings.Contains(raw, similarMetadataMarker) || strings.Contains(raw, target.ID) || !strings.Contains(raw, request) {
				t.Fatal("the author snapshot lost the original request or included the candidate", err)
			}
			view, err = p.Conversation(ctx, source.ID, session.ID)
			if err != nil || view.SimilarTest != nil || len(view.Messages) == 0 || view.Messages[len(view.Messages)-1].Content != request {
				t.Fatal("the decision did not replace the prompt with the original user turn", err)
			}
			var cleared bool
			if err := p.DB.QueryRowContext(ctx, `SELECT matched_test_id IS NULL AND request_text IS NULL FROM new_test_reviews WHERE id=$1`, id).Scan(&cleared); err != nil || !cleared {
				t.Fatal("candidate context was retained after continue", err)
			}
			if engine == "external" {
				task, err := p.ClaimExternalAuthor(ctx, token, NewID())
				if err != nil || task == nil || task.RunID != continued.Run.ID || task.ContextBundle.Script != "" ||
					strings.Contains(jsonText(task.ContextBundle), similarMetadataMarker) || strings.Contains(jsonText(task.ContextBundle), target.ID) {
					t.Fatal("external claim missing or contained matched test context", err)
				}
				return
			}
			a := h.claim(continued.Run.ID)
			if a.Script != "" || a.Author.SourceVersion != nil || a.Author.Messages[0].Content != first {
				t.Fatal("builtin worker received the wrong source context")
			}
			h.upload(a, "author.json", `{"message":"繼續新增。","requestValidation":false}`)
			h.complete(a, "succeeded")
			h.release()
			followUp, err := p.CreateAuthor(ctx, source.ID, session.ID, "也請加上小計確認。", rev)
			if err != nil || followUp.Run.ID == "" || reviews != 2 {
				t.Fatal("continue triggered a later similarity review", err)
			}
		})
	}
}

func TestNewTestSimilarityOnlyReviewsInitialRequests(t *testing.T) {
	h, source, session, _ := newTestReviewFixture(t, "builtin")
	reviews := 0
	h.p.NewTestReview = func(context.Context, []ChatMessage, []similarTestCandidate) (string, error) {
		reviews++
		return "", nil
	}
	for turn := 0; turn <= initialTestRequests; turn++ {
		out, err := h.p.CreateAuthor(h.ctx, source.ID, session.ID, "請確認結帳總額。", session.Draft.Revision)
		if err != nil || out.Run.ID == "" {
			t.Fatal("unmatched test request was blocked", err)
		}
		a := h.claim(out.Run.ID)
		h.upload(a, "author.json", `{"message":"請說明下一個驗證細節。","requestValidation":false}`)
		h.complete(a, "succeeded")
		h.release()
	}
	if reviews != initialTestRequests {
		t.Fatalf("got %d initial reviews, want %d", reviews, initialTestRequests)
	}
}
