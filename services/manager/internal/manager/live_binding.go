package manager

import "errors"

// Scoped to one media/viewer connection. Versioned signaling never downgrades
// after pause/mode changes; old answers are ignored, not applied to a new peer.
type liveOfferBinding struct {
	id, sdp   string
	versioned bool
	paused    bool
	retired   map[string]bool
}

func safeLiveReason(reason string) string {
	switch reason {
	case "no_page", "media_failed", "sensitive_input", "sensitive_input_complete":
		return reason
	}
	return ""
}
func (b *liveOfferBinding) clear(control *liveControl) {
	if b.id != "" {
		if b.retired == nil {
			b.retired = map[string]bool{}
		}
		b.retired[b.id] = true
	}
	b.id = ""
	b.sdp = ""
	control.Answer = ""
	control.AnswerOfferID = ""
}
func (b *liveOfferBinding) acceptsAnswer(v liveWire) bool {
	if b.paused || b.sdp == "" {
		return false
	}
	if b.versioned {
		return b.id != "" && v.OfferID == b.id
	}
	return v.OfferID == ""
}
func (b *liveOfferBinding) plan(state liveState, control *liveControl, changed bool) ([]liveWire, bool, error) {
	if state.OfferID != "" {
		if !uuidPattern.MatchString(state.OfferID) {
			return nil, false, errors.New("invalid live offerId")
		}
		b.versioned = true
	}
	dirty := false
	reason := safeLiveReason(state.Reason)
	if reason == "sensitive_input" {
		dirty = !b.paused || b.sdp != "" || control.Answer != "" || control.AnswerOfferID != ""
		b.paused = true
		b.versioned = true
		b.clear(control)
	}
	if reason == "sensitive_input_complete" {
		b.paused = false
	}
	if state.Offer == "" && (b.sdp != "" || control.Answer != "") {
		b.clear(control)
		dirty = true
	}
	var offer *liveWire
	if state.Offer != "" && !b.paused && !b.retired[state.OfferID] && (state.Offer != b.sdp || state.OfferID != b.id) {
		if len(state.Offer) > maxLiveSDP || b.versioned && state.OfferID == "" {
			return nil, false, errors.New("invalid or downgraded live offer")
		}
		b.clear(control)
		dirty = true
		b.id = state.OfferID
		b.sdp = state.Offer
		offer = &liveWire{Type: "offer", SDP: state.Offer, OfferID: state.OfferID}
	}
	var status *liveWire
	if changed {
		switch state.State {
		case "waiting", "connecting", "streaming", "unavailable", "ended":
		default:
			return nil, false, errors.New("invalid live state")
		}
		if control.Mode == "webrtc" && state.State == "streaming" {
			state.State = "connecting"
		}
		status = &liveWire{Type: "state", State: state.State, Transport: control.Mode, Reason: reason, OfferID: state.OfferID}
	}
	messages := []liveWire{}
	// The resume marker must be on the wire before this epoch's new offer/frame.
	if reason == "sensitive_input_complete" {
		if status != nil {
			messages = append(messages, *status)
		}
		if offer != nil {
			messages = append(messages, *offer)
		}
	} else {
		if offer != nil {
			messages = append(messages, *offer)
		}
		if status != nil {
			messages = append(messages, *status)
		}
	}
	return messages, dirty, nil
}
