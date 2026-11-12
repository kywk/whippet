package gateway

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/whippet/whippet/services/server/internal/server"
)

type liveWriterStore struct{ target server.LiveTarget }

func (s *liveWriterStore) LiveTarget(context.Context, string) (server.LiveTarget, error) {
	return s.target, nil
}

type liveWriterController struct{}

func (liveWriterController) LiveManagerEpoch(string) (string, bool)    { return "epoch", true }
func (liveWriterController) QueueLiveCommand(server.LiveCommand) error { return nil }

type liveWrite struct {
	kind int
	data []byte
}
type recordedLiveWriter struct {
	mu     sync.Mutex
	writes []liveWrite
	frame  chan struct{}
	closed chan struct{}
	once   sync.Once
}

func (w *recordedLiveWriter) SetWriteDeadline(time.Time) error { return nil }
func (w *recordedLiveWriter) EnableWriteCompression(bool)      {}
func (w *recordedLiveWriter) WriteMessage(kind int, data []byte) error {
	w.mu.Lock()
	w.writes = append(w.writes, liveWrite{kind, append([]byte(nil), data...)})
	w.mu.Unlock()
	if kind == websocket.BinaryMessage {
		w.once.Do(func() { close(w.frame) })
	}
	return nil
}
func (w *recordedLiveWriter) Close() error { close(w.closed); return nil }

func TestLiveWriterResumeBeforeFreshFrameWithBothQueuesReady(t *testing.T) {
	store := &liveWriterStore{target: server.LiveTarget{RunID: server.NewID(), WorkspaceID: server.NewID(), ManagerID: "manager", AttemptID: server.NewID(), Status: "running"}}
	hub := server.NewLiveHub(store, liveWriterController{}, nil)
	defer hub.Close()
	s, err := hub.OpenViewer(context.Background(), store.target.RunID)
	if err != nil {
		t.Fatal(err)
	}
	_, media, err := hub.AttachMedia(context.Background(), store.target.RunID, store.target.AttemptID, s.ViewerID)
	if err != nil {
		t.Fatal(err)
	}
	if err := hub.ViewerMessage(s, server.LiveMessage{Type: "mode", Mode: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	for len(s.Viewer.Messages) > 0 {
		<-s.Viewer.Messages
	}
	if err := hub.Frame(s, media, []byte{0xff, 0xd8, 1, 0xff, 0xd9}); err != nil {
		t.Fatal(err)
	}
	if len(s.Viewer.Frames) != 1 {
		t.Fatal("old frame fixture not queued")
	}
	if err := hub.MediaMessage(s, media, server.LiveMessage{Type: "state", ViewerID: server.NewID(), State: "waiting", Reason: "sensitive_input", Transport: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	if len(s.Viewer.Frames) != 0 {
		t.Fatal("pause retained old queued frame")
	}
	offerID := server.NewID()
	if err := hub.MediaMessage(s, media, server.LiveMessage{Type: "state", ViewerID: server.NewID(), OfferID: offerID, State: "waiting", Reason: "sensitive_input_complete", Transport: "jpeg"}); err != nil {
		t.Fatal(err)
	}
	if err := hub.Frame(s, media, []byte{0xff, 0xd8, 2, 0xff, 0xd9}); err != nil {
		t.Fatal(err)
	}
	if len(s.Viewer.Messages) < 2 || len(s.Viewer.Frames) != 1 {
		t.Fatal("both output queues must be ready together")
	}
	writer := &recordedLiveWriter{frame: make(chan struct{}), closed: make(chan struct{})}
	go writeLive(writer, s.Viewer)
	select {
	case <-writer.frame:
	case <-time.After(time.Second):
		hub.CloseViewer(s)
		t.Fatal("fresh frame did not reach actual writer")
	}
	hub.CloseViewer(s)
	select {
	case <-writer.closed:
	case <-time.After(time.Second):
		t.Fatal("writer did not stop")
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	pause, resume, binary := -1, -1, -1
	for i, write := range writer.writes {
		if write.kind == websocket.BinaryMessage {
			if len(write.data) != 5 || write.data[2] != 2 {
				t.Fatal("actual writer sent pre-pause frame")
			}
			binary = i
			continue
		}
		var message server.LiveMessage
		if json.Unmarshal(write.data, &message) != nil {
			t.Fatal("invalid public JSON")
		}
		if message.Type == "state" && message.ViewerID != s.ViewerID {
			t.Fatal("untrusted ViewerID reached writer")
		}
		if message.Reason == "sensitive_input" {
			pause = i
		}
		if message.Reason == "sensitive_input_complete" {
			resume = i
			if message.OfferID != offerID {
				t.Fatal("resume offer ID lost")
			}
		}
	}
	if pause < 0 || resume <= pause || binary <= resume {
		t.Fatal("actual output did not order pause/complete before fresh bytes")
	}
}
