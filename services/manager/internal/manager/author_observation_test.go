package manager

import (
	"encoding/json"
	"fmt"
	"testing"
)

func TestM109AuthorObservationGateAndWhitelist(t *testing.T) {
	events := []string{"started", "fetchInvoked", "headersReceived", "bodyParsed", "responseAccepted", "failed", "timeoutProviderWait", "timeoutBodyWait", "cancelled", "timeoutToolWait", "toolCancelled", "timeoutOther", "feedbackFrameAccepted", "feedbackQueued", "feedbackIncludedAtFetch", "toolsIncludedAtFetch", "functionCallObserved"}
	for _, gate := range []string{"", "0", "true", "1"} {
		t.Run("gate="+gate, func(t *testing.T) {
			t.Setenv("WHIPPET_M109_DIAGNOSTICS", gate)
			m, _, _ := lifecycleManager(t, 1)
			r := record{Kind: "author", RunID: newID(), AttemptID: newID()}
			for ordinal := 1; ordinal <= 8; ordinal++ {
				for _, event := range events {
					value := fmt.Sprintf("author:observe:%d:%s", ordinal, event)
					m.emit(r, "log", value)
					if gate != "1" {
						if len(m.events) != 0 {
							t.Fatal("disabled observation forwarded")
						}
						continue
					}
					select {
					case frame := <-m.events:
						var payload struct{ Message string }
						if json.Unmarshal(frame.Payload, &payload) != nil || payload.Message != value {
							t.Fatal("observation changed")
						}
					default:
						t.Fatal("enabled fixed observation missing")
					}
				}
			}
			for _, value := range []string{"author:observe:0:started", "author:observe:9:started", "author:observe:01:started", "author:observe:1:unknown", "author:observe:1:started SECRET_SENTINEL", "author:observe:1:started\n", " author:observe:1:started", "author:observe:1:feedbackMapped", "author:observe:1:started:secret"} {
				m.emit(r, "log", value)
			}
			m.emit(r, "stderr", "author:observe:1:started")
			if len(m.events) != 0 {
				t.Fatal("unsafe observation forwarded")
			}
		})
	}
}
