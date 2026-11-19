package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
)

const initialTestRequests = 3
const similarTestLimit = 6

var ErrSimilarTestDecision = errors.New("similar_test_decision_required")

type SimilarTestSuggestion struct {
	ID        string    `json:"id"`
	TestID    string    `json:"testId"`
	Name      string    `json:"name"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"createdAt"`
}

type SimilarTestDecision struct {
	Run  *Run  `json:"run,omitempty"`
	Test *Test `json:"test,omitempty"`
}

type newTestReview struct {
	SimilarTestSuggestion
	RunID *string
}

func readNewTestReview(ctx context.Context, q queryDB, s EditingSession) (*newTestReview, error) {
	var review newTestReview
	err := q.QueryRowContext(ctx, `SELECT r.id,COALESCE(t.id::text,''),COALESCE(t.name,''),COALESCE(r.request_text,''),r.created_at,r.continued_run_id
 FROM new_test_reviews r LEFT JOIN tests t ON t.id=r.matched_test_id AND t.workspace_id=$2
 WHERE r.editing_session_id=$1`, s.ID, s.WorkspaceID).
		Scan(&review.ID, &review.TestID, &review.Name, &review.Content, &review.CreatedAt, &review.RunID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	review.CreatedAt = review.CreatedAt.UTC()
	return &review, err
}

type similarTestCandidate struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Tags        []string `json:"tags"`
}

func purposeTerms(text string) map[string]struct{} {
	terms := map[string]struct{}{}
	var word []rune
	var previousHan rune
	flush := func() {
		if len(word) > 1 {
			terms[string(word)] = struct{}{}
		}
		word = word[:0]
	}
	for _, r := range strings.ToLower(text) {
		switch {
		case unicode.Is(unicode.Han, r):
			flush()
			if previousHan != 0 {
				terms[string([]rune{previousHan, r})] = struct{}{}
			}
			previousHan = r
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			word = append(word, r)
			previousHan = 0
		default:
			flush()
			previousHan = 0
		}
	}
	flush()
	return terms
}

func purposeOverlap(request map[string]struct{}, text string) int {
	score := 0
	for term := range purposeTerms(text) {
		if _, ok := request[term]; ok {
			score++
		}
	}
	return score
}

func shortlistSimilarTests(ctx context.Context, tx *sql.Tx, s EditingSession, messages []ChatMessage) ([]similarTestCandidate, error) {
	goals := []string{}
	for _, message := range messages {
		if message.Role == "user" {
			goals = append(goals, message.Content)
		}
	}
	terms := purposeTerms(strings.Join(goals, "\n"))
	if len(terms) == 0 {
		return nil, nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT t.id,t.name,LEFT(COALESCE(n.description_override,v.description,t.description),480),COALESCE(t.tags,'[]'::jsonb)
 FROM tests t JOIN test_versions v ON v.id=t.published_version_id AND v.test_id=t.id
 LEFT JOIN test_version_notes n ON n.version_id=v.id
 WHERE t.workspace_id=$1 AND t.id<>$2 AND t.kind IN ('test','usecase') AND t.deleted_at IS NULL
 ORDER BY v.created_at DESC,t.id`, s.WorkspaceID, s.TestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type ranked struct {
		candidate similarTestCandidate
		score     int
	}
	best := make([]ranked, 0, similarTestLimit+1)
	for rows.Next() {
		var item similarTestCandidate
		var tags []byte
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &tags); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(tags, &item.Tags); err != nil {
			return nil, err
		}
		score := 4*purposeOverlap(terms, item.Name) + 4*purposeOverlap(terms, strings.Join(item.Tags, " ")) + purposeOverlap(terms, item.Description)
		// Recency breaks ties and gives paraphrases with zero exact overlap a chance.
		best = append(best, ranked{item, score})
		sort.SliceStable(best, func(i, j int) bool { return best[i].score > best[j].score })
		best = best[:min(len(best), similarTestLimit)]
	}
	candidates := make([]similarTestCandidate, 0, len(best))
	for _, entry := range best {
		candidates = append(candidates, entry.candidate)
	}
	return candidates, rows.Err()
}

func (p *Postgres) checkNewTestRequest(ctx context.Context, tx *sql.Tx, s EditingSession, skill string, messages []ChatMessage, continuation bool) (*SimilarTestSuggestion, error) {
	review, err := readNewTestReview(ctx, tx, s)
	if err != nil {
		return nil, err
	}
	latest := messages[len(messages)-1].Content
	if review != nil && review.TestID != "" {
		if !continuation && review.Content == latest {
			return &review.SimilarTestSuggestion, nil
		}
		return nil, ErrSimilarTestDecision
	}
	if continuation {
		return nil, nil
	}
	if review == nil && p.NewTestReview != nil {
		var priorTurns int
		err = tx.QueryRowContext(ctx, `SELECT count(*) FROM (SELECT 1 FROM messages WHERE conversation_id=$1 AND role='user' LIMIT $2) turns`,
			s.ConversationID, initialTestRequests).Scan(&priorTurns)
		if err != nil {
			return nil, err
		}
		if priorTurns < initialTestRequests {
			candidates, err := shortlistSimilarTests(ctx, tx, s, messages)
			if err != nil {
				return nil, err
			}
			if len(candidates) > 0 {
				match, err := p.NewTestReview(ctx, messages, candidates)
				if err != nil || match == "" {
					return nil, err
				}
				for _, candidate := range candidates {
					if candidate.ID != match {
						continue
					}
					suggestion := &SimilarTestSuggestion{ID: NewID(), TestID: match, Name: candidate.Name, Content: latest}
					err = tx.QueryRowContext(ctx, `INSERT INTO new_test_reviews(editing_session_id,id,matched_test_id,request_text)
 VALUES($1,$2,$3,$4) RETURNING created_at`, s.ID, suggestion.ID, match, latest).Scan(&suggestion.CreatedAt)
					suggestion.CreatedAt = suggestion.CreatedAt.UTC()
					return suggestion, err
				}
				return nil, ErrAuthorPolicy
			}
		}
	}
	return nil, p.checkAuthorIntent(ctx, skill, messages)
}

func (p *Postgres) DecideSimilarTest(ctx context.Context, testID, sessionID, reviewID string, revision int, choice string) (SimilarTestDecision, error) {
	result := SimilarTestDecision{}
	if !ValidID(reviewID) || revision < 1 || (choice != "continue" && choice != "edit") {
		return result, ErrInvalid
	}
	tx, err := p.DB.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	d, session, err := requireEditingDraft(ctx, tx, testID, sessionID)
	if err != nil {
		return result, err
	}
	review, err := readNewTestReview(ctx, tx, session)
	if err != nil {
		return result, err
	}
	if review == nil || review.ID != reviewID {
		return result, ErrConflict
	}
	if review.RunID != nil && choice == "continue" {
		run, err := scanRun(tx.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs r WHERE r.id=$1 AND r.editing_session_id=$2`, *review.RunID, session.ID))
		if err != nil {
			return result, err
		}
		if run.DraftRevision == nil || *run.DraftRevision != revision {
			return result, ErrConflict
		}
		return SimilarTestDecision{Run: &run}, tx.Commit()
	}
	if review.TestID == "" {
		return result, ErrConflict
	}
	if err := checkRevision(revision, d.Revision); err != nil {
		return result, err
	}
	if choice == "edit" {
		var targetID string
		if err = tx.QueryRowContext(ctx, `SELECT id FROM tests WHERE id=$1 AND workspace_id=$2 AND kind IN ('test','usecase')
 AND published_version_id IS NOT NULL AND deleted_at IS NULL FOR UPDATE`, review.TestID, session.WorkspaceID).Scan(&targetID); err != nil {
			return result, dbError(err)
		}
		if _, _, err = startEditingSessionInTx(ctx, tx, targetID); err != nil {
			return result, err
		}
		target, err := readTest(ctx, tx, targetID)
		if err != nil {
			return result, err
		}
		return SimilarTestDecision{Test: &target}, tx.Commit()
	}
	if _, err = tx.ExecContext(ctx, `UPDATE new_test_reviews SET matched_test_id=NULL,request_text=NULL WHERE editing_session_id=$1`, session.ID); err != nil {
		return result, err
	}
	submission, err := p.createAuthorInTx(ctx, tx, d, session, review.Content)
	if err != nil {
		return result, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE new_test_reviews SET continued_run_id=$2 WHERE editing_session_id=$1`, session.ID, submission.Run.ID); err != nil {
		return result, err
	}
	return SimilarTestDecision{Run: &submission.Run}, tx.Commit()
}

func (a *API) decideSimilarTest(w http.ResponseWriter, r *http.Request) {
	testID, ok := a.id(w, r)
	if !ok {
		return
	}
	var body struct {
		ID       string `json:"id"`
		Revision int    `json:"revision"`
		Choice   string `json:"choice"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		a.fail(w, err)
		return
	}
	result, err := a.store.DecideSimilarTest(r.Context(), testID, r.PathValue("sessionId"), body.ID, body.Revision, body.Choice)
	if err != nil {
		a.fail(w, err)
		return
	}
	if result.Run != nil {
		a.engine.Wake()
		writeJSON(w, http.StatusAccepted, result)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
