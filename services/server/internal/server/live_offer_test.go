package server

import (
	"context"
	"encoding/json"
	"testing"
)

func liveOfferFixture(t *testing.T) (*LiveHub, *LiveSession, *LiveEndpoint) {
	t.Helper()
	hub, store, _ := liveFixture()
	s, err := hub.OpenViewer(context.Background(), store.target.RunID)
	if err != nil {
		t.Fatal(err)
	}
	_, media, err := hub.AttachMedia(context.Background(), store.target.RunID, store.target.AttemptID, s.ViewerID)
	if err != nil {
		t.Fatal(err)
	}
	for len(s.Viewer.Messages) > 0 {
		<-s.Viewer.Messages
	}
	<-media.Messages // Initial WebRTC mode.
	t.Cleanup(hub.Close)
	return hub, s, media
}

func noLiveMessages(t *testing.T, endpoint *LiveEndpoint) {
	t.Helper()
	if len(endpoint.Messages) != 0 {
		t.Fatal("stale signaling was relayed")
	}
}

func TestLiveOfferMatchingAndMismatchedAnswer(t *testing.T) {
	hub, s, media := liveOfferFixture(t)
	id := NewID()
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: id, SDP: "synthetic-offer"}); err != nil {
		t.Fatal(err)
	}
	offer := <-s.Viewer.Messages
	if offer.Type != "offer" || offer.OfferID != id {
		t.Fatal("offer ID missing")
	}
	data, err := json.Marshal(offer)
	var decoded LiveMessage
	if err != nil || json.Unmarshal(data, &decoded) != nil || decoded.OfferID != id {
		t.Fatal("offer ID wire round trip")
	}
	for _, bad := range []string{NewID(), ""} {
		if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: bad, SDP: "stale-answer"}); err != nil {
			t.Fatal("stale answer disconnected viewer", err)
		}
		noLiveMessages(t, media)
	}
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: id, SDP: "matched-answer"}); err != nil {
		t.Fatal(err)
	}
	answer := <-media.Messages
	if answer.Type != "answer" || answer.OfferID != id || answer.SDP != "matched-answer" {
		t.Fatal("answer ID not echoed")
	}
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: id, SDP: "duplicate-answer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, media)
	next := NewID()
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: next, SDP: "new-offer"}); err != nil {
		t.Fatal(err)
	}
	<-s.Viewer.Messages
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: id, SDP: "old-answer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, media)
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: next, SDP: "new-answer"}); err != nil {
		t.Fatal(err)
	}
	if (<-media.Messages).OfferID != next {
		t.Fatal("answer went to old offer")
	}
}

func TestLiveOfferSensitivePauseInvalidatesAndResumeKeepsNewOffer(t *testing.T) {
	hub, s, media := liveOfferFixture(t)
	old := NewID()
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: old, SDP: "old-offer"}); err != nil {
		t.Fatal(err)
	}
	<-s.Viewer.Messages
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", ViewerID: NewID(), State: "waiting", Transport: "webrtc", Reason: "sensitive_input"}); err != nil {
		t.Fatal(err)
	}
	pause := <-s.Viewer.Messages
	if pause.ViewerID != s.ViewerID || pause.State != "waiting" || pause.Reason != "sensitive_input" {
		t.Fatal("pause did not use trusted viewer/reason")
	}
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: old, SDP: "late-answer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, media)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: NewID(), SDP: "premature-offer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, s.Viewer)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", ViewerID: NewID(), State: "waiting", Transport: "webrtc", Reason: "sensitive_input_complete"}); err != nil {
		t.Fatal(err)
	}
	// Resume and offer share one FIFO; no new RPC or channel can reorder them.
	next := NewID()
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: next, SDP: "resumed-offer"}); err != nil {
		t.Fatal(err)
	}
	resume, offer := <-s.Viewer.Messages, <-s.Viewer.Messages
	if resume.Type != "state" || resume.Reason != "sensitive_input_complete" || resume.ViewerID != s.ViewerID || resume.Transport != "webrtc" || offer.Type != "offer" || offer.OfferID != next {
		t.Fatal("resume identity/order changed")
	}
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", State: "waiting", Transport: "webrtc", Reason: "sensitive_input_complete"}); err != nil {
		t.Fatal(err)
	}
	<-s.Viewer.Messages // A duplicate resume must not erase the current offer.
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: old, SDP: "old-answer-after-resume"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, media)
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: next, SDP: "new-answer"}); err != nil {
		t.Fatal(err)
	}
	if (<-media.Messages).OfferID != next {
		t.Fatal("resume invalidated the new offer")
	}
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", SDP: "anonymous-downgrade"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, s.Viewer)
}

func TestLiveOfferModeChangeRejectsLateAnswer(t *testing.T) {
	hub, s, media := liveOfferFixture(t)
	id := NewID()
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: id, SDP: "offer"}); err != nil {
		t.Fatal(err)
	}
	<-s.Viewer.Messages
	for _, mode := range []string{"jpeg", "webrtc"} {
		if err := hub.ViewerMessage(s, LiveMessage{Type: "mode", Mode: mode}); err != nil {
			t.Fatal(err)
		}
		if (<-media.Messages).Mode != mode {
			t.Fatal("mode relay changed")
		}
		if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: id, SDP: "late"}); err != nil {
			t.Fatal(err)
		}
		noLiveMessages(t, media)
	}
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: id, SDP: "replayed-invalidated-offer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, s.Viewer)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", SDP: "anonymous-downgrade"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, s.Viewer)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: NewID(), SDP: "fresh"}); err != nil {
		t.Fatal(err)
	}
	if (<-s.Viewer.Messages).OfferID == id {
		t.Fatal("new negotiation reused old offer")
	}
}

func TestLiveOfferLegacyInitialOnlyAndUUIDValidation(t *testing.T) {
	hub, s, media := liveOfferFixture(t)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", SDP: "legacy-initial-offer"}); err != nil {
		t.Fatal(err)
	}
	if (<-s.Viewer.Messages).OfferID != "" {
		t.Fatal("invented legacy offer identity")
	}
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", SDP: "legacy-answer"}); err != nil {
		t.Fatal(err)
	}
	if (<-media.Messages).Type != "answer" {
		t.Fatal("initial legacy path lost compatibility")
	}
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", SDP: "second-legacy-offer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, s.Viewer)
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: "invalid", SDP: "offer"}); err == nil {
		t.Fatal("non-UUID offer accepted")
	}
	id := NewID()
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "offer", OfferID: id, SDP: "modern-offer"}); err != nil {
		t.Fatal(err)
	}
	<-s.Viewer.Messages
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", SDP: "anonymous-answer"}); err != nil {
		t.Fatal(err)
	}
	noLiveMessages(t, media)
	if err := hub.ViewerMessage(s, LiveMessage{Type: "answer", OfferID: "invalid", SDP: "answer"}); err == nil {
		t.Fatal("non-UUID answer accepted")
	}
}

func TestLiveOfferFrameEpochAndWrittenResumeBarrier(t *testing.T) {
	hub, s, media := liveOfferFixture(t)
	if err := hub.ViewerMessage(s, LiveMessage{Type: "mode", Mode: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	<-media.Messages
	if err := hub.Frame(s, media, []byte{0xff, 0xd8, 1, 0xff, 0xd9}); err != nil {
		t.Fatal(err)
	}
	selected := <-s.Viewer.Frames // Writer selected the old frame before pause.
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", State: "waiting", Reason: "sensitive_input", Transport: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	writes := 0
	write := func([]byte) error { writes++; return nil }
	if err := s.Viewer.WriteFrame(selected, write); err != nil || writes != 0 {
		t.Fatal("already-selected stale frame crossed pause")
	}
	if err := hub.Frame(s, media, []byte{0xff, 0xd8, 2, 0xff, 0xd9}); err != nil {
		t.Fatal(err)
	}
	if len(s.Viewer.Frames) != 0 {
		t.Fatal("paused frame was queued")
	}
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", State: "waiting", Reason: "sensitive_input_complete", Transport: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	if err := hub.Frame(s, media, []byte{0xff, 0xd8, 3, 0xff, 0xd9}); err != nil {
		t.Fatal(err)
	}
	fresh := <-s.Viewer.Frames
	if err := s.Viewer.WriteFrame(fresh, write); err != nil || writes != 0 {
		t.Fatal("fresh frame escaped before complete was written")
	}
	var resume LiveMessage
	for len(s.Viewer.Messages) > 0 {
		m := <-s.Viewer.Messages
		if m.Reason == "sensitive_input_complete" {
			resume = m
		}
	}
	s.Viewer.MessageWritten(resume)
	if err := s.Viewer.WriteFrame(fresh, write); err != nil || writes != 1 {
		t.Fatal("written complete did not release fresh frame")
	}
	if err := hub.MediaMessage(s, media, LiveMessage{Type: "state", State: "waiting", Reason: "sensitive_input", Transport: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	s.Viewer.MessageWritten(resume)
	if err := s.Viewer.WriteFrame(fresh, write); err != nil || writes != 1 {
		t.Fatal("old complete unlocked a newer pause")
	}
}
