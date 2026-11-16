//go:build m12module

package manager

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Invoked by the isolated Server integration with a real assignment and the
// actual Worker artifact. No model/environment secrets are inherited.
func TestModuleCheckpointWorkerArtifactBridge(t *testing.T) {
	if os.Getenv("WHIPPET_M12_MODULE_BRIDGE") != "1" {
		t.Fatal("explicit isolated bridge input required")
	}
	var input struct {
		Author   *AuthorTask     `json:"author"`
		Script   string          `json:"script"`
		Artifact json.RawMessage `json:"artifact"`
	}
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		t.Fatal(err)
	}
	if err := validAuthorMetadata(input.Author, &input.Script); err != nil {
		t.Fatal("assignment rejected", err)
	}
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "output"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "output", "author.json"), input.Artifact, 0600); err != nil {
		t.Fatal(err)
	}
	if !validAuthorArtifact(dir, input.Author, nil) {
		t.Fatal("actual Worker artifact rejected by Manager")
	}
}
