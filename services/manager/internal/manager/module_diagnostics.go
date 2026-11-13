package manager

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
)

const m109Prefix = "m109_diagnostic:"

type m109Worker struct {
	ModelRequestFailureStage           string `json:"modelRequestFailureStage,omitempty"`
	SchemaVersion                      int    `json:"-"`
	LastSelfTestFailureClass           string `json:"lastSelfTestFailureClass,omitempty"`
	SelfTestPassedCount                int    `json:"selfTestPassedCount"`
	SelfTestFailedCount                int    `json:"selfTestFailedCount"`
	CheckpointCreated                  bool   `json:"checkpointCreated"`
	CheckpointPresentAtFinalize        bool   `json:"checkpointPresentAtFinalize"`
	CheckpointRetainedAfterSecretGuard bool   `json:"checkpointRetainedAfterSecretGuard"`
	TerminalClass                      string `json:"terminalClass"`
}
type m109Manager struct {
	WorkerResultPresent   bool   `json:"workerResultPresent"`
	WorkerResultValid     bool   `json:"workerResultValid"`
	WorkerStatus          string `json:"workerStatus"`
	AuthorArtifactPresent bool   `json:"authorArtifactPresent"`
	AuthorParserChecked   bool   `json:"authorParserChecked"`
	AuthorParserAccepted  bool   `json:"authorParserAccepted"`
	UploadAttempted       bool   `json:"uploadAttempted"`
	UploadAccepted        bool   `json:"uploadAccepted"`
	Disposition           string `json:"disposition"`
}
type m109Diagnostic struct {
	mu             sync.Mutex
	SchemaVersion  int         `json:"schemaVersion"`
	WorkerObserved bool        `json:"workerObserved"`
	Worker         m109Worker  `json:"worker"`
	Manager        m109Manager `json:"manager"`
}

func newM109Diagnostic() *m109Diagnostic {
	return &m109Diagnostic{SchemaVersion: 3, Worker: m109Worker{ModelRequestFailureStage: "UNKNOWN", TerminalClass: "UNKNOWN", LastSelfTestFailureClass: "UNKNOWN"}, Manager: m109Manager{WorkerStatus: "UNKNOWN", Disposition: "UNKNOWN"}}
}
func m109Enabled() bool { return os.Getenv("WHIPPET_M109_DIAGNOSTICS") == "1" }

// Reject nulls, duplicates, unknown fields and trailing bytes, not just struct decode.
func decodeM109(raw []byte) (m109Worker, bool) {
	var out m109Worker
	if len(raw) > 2048 {
		return out, false
	}
	types := map[string]bool{"selfTestPassedCount": false, "selfTestFailedCount": false, "checkpointCreated": true, "checkpointPresentAtFinalize": true, "checkpointRetainedAfterSecretGuard": true, "terminalClass": false, "schemaVersion": false, "lastSelfTestFailureClass": false, "modelRequestFailureStage": false}
	dec := json.NewDecoder(bytes.NewReader(raw))
	start, err := dec.Token()
	if err != nil || start != json.Delim('{') {
		return out, false
	}
	seen := map[string]bool{}
	for dec.More() {
		token, e := dec.Token()
		key, ok := token.(string)
		if e != nil || !ok || seen[key] {
			return out, false
		}
		isBool, known := types[key]
		if !known {
			return out, false
		}
		seen[key] = true
		var value any
		if dec.Decode(&value) != nil {
			return out, false
		}
		if isBool {
			if _, ok := value.(bool); !ok {
				return out, false
			}
		} else if key == "terminalClass" || key == "lastSelfTestFailureClass" || key == "modelRequestFailureStage" {
			if _, ok := value.(string); !ok {
				return out, false
			}
		} else if key == "schemaVersion" {
			if value != float64(2) && value != float64(3) {
				return out, false
			}
			out.SchemaVersion = int(value.(float64))
		} else {
			n, ok := value.(float64)
			if !ok || n < 0 || n > 12 || n != float64(int(n)) {
				return out, false
			}
		}
	}
	if _, err = dec.Token(); err != nil || !(len(seen) == 6 && !seen["schemaVersion"] && !seen["lastSelfTestFailureClass"] && !seen["modelRequestFailureStage"] || len(seen) == 8 && out.SchemaVersion == 2 && seen["lastSelfTestFailureClass"] && !seen["modelRequestFailureStage"] || len(seen) == 9 && out.SchemaVersion == 3 && seen["lastSelfTestFailureClass"] && seen["modelRequestFailureStage"]) || dec.Decode(new(any)) != io.EOF || json.Unmarshal(raw, &out) != nil {
		return out, false
	}
	if out.SchemaVersion == 0 {
		out.SchemaVersion = 1
	} else {
		switch out.LastSelfTestFailureClass {
		case "INVALID_SPEC", "GUARD", "TIMEOUT", "CANCELLED", "TEST_FAILED", "UNKNOWN":
		default:
			return m109Worker{}, false
		}
	}
	if out.SchemaVersion == 3 {
		switch out.ModelRequestFailureStage {
		case "UNKNOWN", "FETCH_REJECTED", "HTTP_NON_OK", "BODY_JSON_REJECTED", "RESPONSE_GUARD_REJECTED", "INCOMPLETE_MAX_OUTPUT_TOKENS", "INCOMPLETE_CONTENT_FILTER", "INCOMPLETE_UNKNOWN", "ENVELOPE_INVALID":
		default:
			return m109Worker{}, false
		}
	}
	switch out.TerminalClass {
	case "LIMIT", "INVALID_RESPONSE", "FINAL_JSON_PARSE", "FINAL_SHAPE", "CHECKPOINT_MISSING", "CHECKPOINT_REJECTED", "PROVIDER_FAILED", "TIMEOUT", "CANCELLED", "ARTIFACT_SERIALIZE_LIMIT", "ARTIFACT_WRITE_FAILED", "COMPLETED", "UNKNOWN":
	default:
		return m109Worker{}, false
	}
	if out.CheckpointRetainedAfterSecretGuard && !out.CheckpointPresentAtFinalize || out.CheckpointPresentAtFinalize && !out.CheckpointCreated {
		return m109Worker{}, false
	}
	return out, true
}
func (d *m109Diagnostic) consume(text string) bool {
	if !strings.HasPrefix(text, m109Prefix) {
		return false
	}
	value, valid := decodeM109([]byte(strings.TrimPrefix(text, m109Prefix)))
	d.mu.Lock()
	defer d.mu.Unlock()
	if valid && !d.WorkerObserved {
		d.SchemaVersion = value.SchemaVersion
		d.Worker = value
		d.WorkerObserved = true
	}
	return true // Swallow even invalid diagnostic content; never route it to product logs.
}
func m109Present(taskDir, name string) bool {
	f, e := openArtifact(taskDir, name)
	if e != nil {
		return false
	}
	f.Close()
	return true
}

// Anchor the work root, open diagnostics with O_NOFOLLOW, then use only its
// pinned descriptor. No user-controlled intermediate symlink is traversed.
func writeM109(workDir, attempt string, d *m109Diagnostic) error {
	if d == nil || !uuidPattern.MatchString(attempt) {
		return nil
	}
	d.mu.Lock()
	raw, err := json.Marshal(d)
	d.mu.Unlock()
	if err != nil || len(raw)+1 > 4096 {
		return errCapability
	}
	work, err := os.OpenFile(workDir, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer work.Close()
	root, err := os.OpenRoot(filepath.Join("/dev/fd", strconv.Itoa(int(work.Fd()))))
	if err != nil {
		return err
	}
	defer root.Close()
	if err = root.Mkdir("diagnostics", 0700); err != nil && !os.IsExist(err) {
		return err
	}
	dir, err := root.OpenFile("diagnostics", os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer dir.Close()
	pinned, err := os.OpenRoot(filepath.Join("/dev/fd", strconv.Itoa(int(dir.Fd()))))
	if err != nil {
		return err
	}
	defer pinned.Close()
	f, err := pinned.OpenFile(attempt+".json", os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(raw, '\n'))
	return err
}
