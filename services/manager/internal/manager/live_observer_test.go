package manager

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

type liveObserver struct {
	Flags                  map[string]bool        `json:"flags"`
	Requests               map[int]map[string]int `json:"requests"`
	ManagerProcessDeadline int                    `json:"managerProcessDeadline"`
	terminal               map[int]bool
}

func newLiveObserver() *liveObserver {
	return &liveObserver{Flags: map[string]bool{"feedbackMapped": false, "feedbackFrameAccepted": false, "feedbackQueued": false, "feedbackIncludedAtFetch": false, "toolsIncludedAtFetch": false, "functionCallObserved": false}, Requests: map[int]map[string]int{}, terminal: map[int]bool{}}
}

var liveObservationPattern = regexp.MustCompile(`^author:observe:([0-9]{1,2}):([A-Za-z]+)$`)

func (o *liveObserver) accept(text string) {
	m := liveObservationPattern.FindStringSubmatch(text)
	if m == nil {
		return
	}
	n, _ := strconv.Atoi(m[1])
	if n < 1 || n > 8 {
		return
	}
	event := m[2]
	if _, ok := o.Flags[event]; ok && event != "feedbackMapped" {
		o.Flags[event] = true
		return
	}
	terminal := false
	switch event {
	case "responseAccepted", "failed", "timeoutProviderWait", "timeoutBodyWait", "timeoutOther", "cancelled":
		terminal = true
	case "started", "fetchInvoked", "headersReceived", "bodyParsed", "timeoutToolWait", "toolCancelled":
	default:
		return
	}
	if terminal {
		if o.terminal[n] {
			return
		}
		o.terminal[n] = true
	}
	if o.Requests[n] == nil {
		o.Requests[n] = map[string]int{}
	}
	// Every event is one stage observation per ordinal; repeated emissions cannot inflate counts.
	o.Requests[n][event] = 1
}
func TestLiveObserverWhitelist(t *testing.T) {
	o := newLiveObserver()
	for _, s := range []string{"author:observe:1:started", "author:observe:1:fetchInvoked", "author:observe:1:feedbackQueued", "author:observe:1:timeoutProviderWait", "author:observe:1:failed"} {
		o.accept(s)
	}
	for _, s := range []string{"author:observe:1:SECRET_SENTINEL", "author:observe:1:started https://synthetic.invalid/SECRET_SENTINEL", "author:observe:1:feedbackMapped", "author:observe:99:started"} {
		o.accept(s)
	}
	raw, _ := json.Marshal(o)
	if strings.Contains(string(raw), "SECRET_SENTINEL") || o.Flags["feedbackMapped"] || !o.Flags["feedbackQueued"] || o.Requests[1]["failed"] != 0 || o.Requests[99] != nil {
		t.Fatal("unsafe observation")
	}
}
func TestLiveObserverFeedbackMappedOnlyMatchingReply(t *testing.T) {
	for _, valid := range []bool{false, true} {
		o := &liveToolObservation{pending: map[string]toolRequest{}}
		q := toolRequest{RequestID: newID(), AttemptID: newID(), Name: "catalog_search"}
		o.request(q)
		attempt := q.AttemptID
		if !valid {
			attempt = newID()
		}
		raw, _ := json.Marshal(toolReply{Kind: "tool_response", RequestID: q.RequestID, AttemptID: attempt, Error: "catalog_search_invalid_request"})
		o.response(raw)
		if o.feedbackMapped != valid {
			t.Fatal("feedback mapping scope")
		}
	}
}
