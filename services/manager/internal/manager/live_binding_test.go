package manager

import "testing"

func TestLiveSensitiveOfferBindingRejectsStaleDowngradeAndModeAnswers(t *testing.T) {
	b := liveOfferBinding{}
	c := liveControl{Mode: "webrtc"}
	first, second := newID(), newID()
	_, _, err := b.plan(liveState{State: "connecting", Offer: "first", OfferID: first}, &c, true)
	if err != nil {
		t.Fatal(err)
	}
	if !b.acceptsAnswer(liveWire{OfferID: first}) || b.acceptsAnswer(liveWire{}) {
		t.Fatal("versioned answer binding missing")
	}
	c.Answer = "old"
	c.AnswerOfferID = first
	messages, dirty, err := b.plan(liveState{State: "waiting", Reason: "sensitive_input"}, &c, true)
	if err != nil || !dirty || c.Answer != "" || c.AnswerOfferID != "" || messages[0].Reason != "sensitive_input" || b.acceptsAnswer(liveWire{OfferID: first}) {
		t.Fatal("pause retained old answer")
	}
	messages, _, err = b.plan(liveState{State: "waiting", Reason: "sensitive_input_complete", Offer: "fresh", OfferID: second}, &c, true)
	if err != nil || len(messages) != 2 || messages[0].Type != "state" || messages[0].Reason != "sensitive_input_complete" || messages[1].Type != "offer" || messages[1].OfferID != second {
		t.Fatal("resume was not ordered complete then fresh offer", messages, err)
	}
	if b.acceptsAnswer(liveWire{OfferID: first}) || !b.acceptsAnswer(liveWire{OfferID: second}) {
		t.Fatal("stale answer accepted")
	}
	b.clear(&c) // Same viewer changing mode still retains versioned history.
	if b.acceptsAnswer(liveWire{OfferID: second}) {
		t.Fatal("mode change kept active answer")
	}
	messages, _, err = b.plan(liveState{State: "connecting", Offer: "retired", OfferID: first}, &c, true)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range messages {
		if v.Type == "offer" {
			t.Fatal("retired offer reactivated")
		}
	}
	if _, _, err = b.plan(liveState{State: "connecting", Offer: "legacy"}, &c, true); err == nil {
		t.Fatal("downgraded after versioned signaling")
	}
}

func TestLiveSensitiveLegacyInitialAndJPEGResumeOrdering(t *testing.T) {
	legacy := liveOfferBinding{}
	c := liveControl{Mode: "webrtc"}
	if _, _, err := legacy.plan(liveState{State: "connecting", Offer: "legacy"}, &c, true); err != nil || !legacy.acceptsAnswer(liveWire{}) {
		t.Fatal("legacy first negotiation broke", err)
	}
	b := liveOfferBinding{}
	c = liveControl{Mode: "jpeg"}
	pause, _, err := b.plan(liveState{State: "waiting", Reason: "sensitive_input"}, &c, true)
	if err != nil || !b.paused || pause[0].Reason != "sensitive_input" {
		t.Fatal("JPEG not paused")
	}
	resume, _, err := b.plan(liveState{State: "waiting", Reason: "sensitive_input_complete"}, &c, true)
	if err != nil || b.paused || len(resume) != 1 || resume[0].Reason != "sensitive_input_complete" {
		t.Fatal("JPEG not resumed after state delivery")
	}
	if safeLiveReason("arbitrary script text") != "" {
		t.Fatal("untrusted reason forwarded")
	}
}
