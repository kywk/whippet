package manager

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// This contract suite enters the Manager package only through the QA overlay.
func w3EvenPayload(t *testing.T, version int) []byte {
	t.Helper()
	value := map[string]any{
		"selfTestPassedCount":                0,
		"selfTestFailedCount":                1,
		"checkpointCreated":                  false,
		"checkpointPresentAtFinalize":        false,
		"checkpointRetainedAfterSecretGuard": false,
		"terminalClass":                      "LIMIT",
	}
	if version >= 2 {
		value["schemaVersion"] = version
		value["lastSelfTestFailureClass"] = "TEST_FAILED"
	}
	if version >= 3 {
		value["modelRequestFailureStage"] = "UNKNOWN"
	}
	if version >= 4 {
		value["lastSelfTestFailedStepCategory"] = "EXPECT"
		value["lastSelfTestMainFrameNavigation"] = "OBSERVED"
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal("ENCODE_FAILED")
	}
	return raw
}

func w3EvenExactKeys(value map[string]any, names ...string) bool {
	if len(value) != len(names) {
		return false
	}
	for _, name := range names {
		if _, found := value[name]; !found {
			return false
		}
	}
	return true
}

func TestM10ZW3EvenV4AndLegacyExactShape(t *testing.T) {
	for version := 1; version <= 4; version++ {
		raw := w3EvenPayload(t, version)
		decoded, ok := decodeM109(raw)
		if !ok || decoded.SchemaVersion != version || decoded.TerminalClass != "LIMIT" || decoded.SelfTestFailedCount != 1 {
			t.Fatal("VALID_VERSION_REJECTED")
		}
		d := newM109Diagnostic()
		if !d.consume(m109Prefix+string(raw)) || !d.WorkerObserved || d.SchemaVersion != version {
			t.Fatal("VERSION_NOT_OBSERVED")
		}
		root := t.TempDir()
		id := newID()
		if err := writeM109(root, id, d); err != nil {
			t.Fatal("SIDECAR_WRITE_FAILED")
		}
		saved, err := os.ReadFile(filepath.Join(root, "diagnostics", id+".json"))
		if err != nil || len(saved) > 4096 {
			t.Fatal("SIDECAR_READ_OR_SIZE_FAILED")
		}
		var top map[string]any
		if json.Unmarshal(saved, &top) != nil || !w3EvenExactKeys(top, "schemaVersion", "workerObserved", "worker", "manager") || top["schemaVersion"] != float64(version) {
			t.Fatal("SIDECAR_TOP_SHAPE_FAILED")
		}
		worker, ok := top["worker"].(map[string]any)
		if !ok {
			t.Fatal("SIDECAR_WORKER_MISSING")
		}
		keys := []string{"selfTestPassedCount", "selfTestFailedCount", "checkpointCreated", "checkpointPresentAtFinalize", "checkpointRetainedAfterSecretGuard", "terminalClass"}
		if version >= 2 {
			keys = append(keys, "lastSelfTestFailureClass")
		}
		if version >= 3 {
			keys = append(keys, "modelRequestFailureStage")
		}
		if version >= 4 {
			keys = append(keys, "lastSelfTestFailedStepCategory", "lastSelfTestMainFrameNavigation")
		}
		if !w3EvenExactKeys(worker, keys...) {
			t.Fatal("SIDECAR_WORKER_SHAPE_FAILED")
		}
		manager, ok := top["manager"].(map[string]any)
		if !ok || !w3EvenExactKeys(manager, "workerResultPresent", "workerResultValid", "workerStatus", "authorArtifactPresent", "authorParserChecked", "authorParserAccepted", "uploadAttempted", "uploadAccepted", "disposition") {
			t.Fatal("SIDECAR_MANAGER_SHAPE_FAILED")
		}
	}
}

func TestM10ZW3EvenV4RejectMalformed(t *testing.T) {
	valid := w3EvenPayload(t, 4)
	var value map[string]any
	if json.Unmarshal(valid, &value) != nil {
		t.Fatal("FIXTURE_DECODE_FAILED")
	}
	bad := make([][]byte, 0, 32)
	for _, key := range []string{"lastSelfTestFailedStepCategory", "lastSelfTestMainFrameNavigation"} {
		copy := map[string]any{}
		for k, v := range value {
			copy[k] = v
		}
		delete(copy, key)
		raw, _ := json.Marshal(copy)
		bad = append(bad, raw)
		copy[key] = nil
		raw, _ = json.Marshal(copy)
		bad = append(bad, raw)
		copy[key] = "ILLEGAL"
		raw, _ = json.Marshal(copy)
		bad = append(bad, raw)
	}
	for key, options := range map[string][]string{
		"lastSelfTestFailedStepCategory":  {"EXPECT", "PW_API", "TEST_STEP", "OTHER", "UNOBSERVED"},
		"lastSelfTestMainFrameNavigation": {"OBSERVED", "NOT_OBSERVED", "UNOBSERVED"},
	} {
		for _, option := range options {
			copy := map[string]any{}
			for k, v := range value {
				copy[k] = v
			}
			copy[key] = option
			raw, _ := json.Marshal(copy)
			if _, ok := decodeM109(raw); !ok {
				t.Fatal("VALID_ENUM_REJECTED")
			}
		}
	}
	copy := map[string]any{}
	for k, v := range value {
		copy[k] = v
	}
	copy["unknown"] = true
	raw, _ := json.Marshal(copy)
	bad = append(bad, raw)
	copy = map[string]any{}
	for k, v := range value {
		copy[k] = v
	}
	copy["schemaVersion"] = 3
	raw, _ = json.Marshal(copy)
	bad = append(bad, raw)
	copy = map[string]any{}
	for k, v := range value {
		copy[k] = v
	}
	copy["schemaVersion"] = nil
	raw, _ = json.Marshal(copy)
	bad = append(bad, raw)
	copy = map[string]any{}
	for k, v := range value {
		copy[k] = v
	}
	copy["lastSelfTestFailedStepCategory"] = 7
	raw, _ = json.Marshal(copy)
	bad = append(bad, raw)
	duplicate := bytes.Replace(valid, []byte(`"lastSelfTestFailedStepCategory":"EXPECT"`), []byte(`"lastSelfTestFailedStepCategory":"EXPECT","lastSelfTestFailedStepCategory":"EXPECT"`), 1)
	if bytes.Equal(duplicate, valid) {
		t.Fatal("DUPLICATE_FIXTURE_FAILED")
	}
	bad = append(bad, duplicate)
	for _, candidate := range bad {
		if _, ok := decodeM109(candidate); ok {
			t.Fatal("MALFORMED_ACCEPTED")
		}
	}
}

func TestM10ZW3EvenProducerInterop(t *testing.T) {
	const samplesPath = "/private/tmp/whippet-m10z-20261115-wave3/odd/payload-samples.json"
	raw, err := os.ReadFile(samplesPath)
	if err != nil {
		t.Fatal("PRODUCER_SAMPLES_MISSING")
	}
	var bundle struct {
		SchemaVersion int `json:"schemaVersion"`
		Samples       []struct {
			ScenarioID string          `json:"scenarioId"`
			Payload    json.RawMessage `json:"payload"`
		} `json:"samples"`
	}
	if json.Unmarshal(raw, &bundle) != nil || bundle.SchemaVersion != 1 || len(bundle.Samples) != 6 {
		t.Fatal("PRODUCER_BUNDLE_SHAPE_FAILED")
	}
	for _, sample := range bundle.Samples {
		if sample.ScenarioID == "" || len(sample.Payload) == 0 || len(sample.Payload) > 2048 {
			t.Fatal("PRODUCER_SAMPLE_SHAPE_FAILED")
		}
		decoded, ok := decodeM109(sample.Payload)
		if !ok || decoded.SchemaVersion != 4 {
			t.Fatal("PRODUCER_DECODE_FAILED")
		}
		d := newM109Diagnostic()
		if !d.consume(m109Prefix+string(sample.Payload)) || !d.WorkerObserved || d.SchemaVersion != 4 {
			t.Fatal("PRODUCER_CONSUME_FAILED")
		}
		root := t.TempDir()
		id := newID()
		if err := writeM109(root, id, d); err != nil {
			t.Fatal("PRODUCER_SIDECAR_WRITE_FAILED")
		}
		path := filepath.Join(root, "diagnostics", id+".json")
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 {
			t.Fatal("PRODUCER_SIDECAR_FILE_FAILED")
		}
		saved, err := os.ReadFile(path)
		if err != nil || len(saved) > 4096 {
			t.Fatal("PRODUCER_SIDECAR_SIZE_FAILED")
		}
		var top map[string]any
		if json.Unmarshal(saved, &top) != nil || !w3EvenExactKeys(top, "schemaVersion", "workerObserved", "worker", "manager") || top["schemaVersion"] != float64(4) || top["workerObserved"] != true {
			t.Fatal("PRODUCER_SIDECAR_TOP_FAILED")
		}
		worker, ok := top["worker"].(map[string]any)
		if !ok || !w3EvenExactKeys(worker, "selfTestPassedCount", "selfTestFailedCount", "checkpointCreated", "checkpointPresentAtFinalize", "checkpointRetainedAfterSecretGuard", "terminalClass", "lastSelfTestFailureClass", "modelRequestFailureStage", "lastSelfTestFailedStepCategory", "lastSelfTestMainFrameNavigation") {
			t.Fatal("PRODUCER_SIDECAR_WORKER_FAILED")
		}
		manager, ok := top["manager"].(map[string]any)
		if !ok || !w3EvenExactKeys(manager, "workerResultPresent", "workerResultValid", "workerStatus", "authorArtifactPresent", "authorParserChecked", "authorParserAccepted", "uploadAttempted", "uploadAccepted", "disposition") {
			t.Fatal("PRODUCER_SIDECAR_MANAGER_FAILED")
		}
	}
}
