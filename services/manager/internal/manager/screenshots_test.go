package manager

import (
	"bytes"
	"crypto/sha1"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeScreenshot(t *testing.T, taskDir string, index int) string {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, 1, 1))
	img.Set(0, 0, color.NRGBA{R: uint8(index), A: 255})
	var body bytes.Buffer
	if err := png.Encode(&body, img); err != nil {
		t.Fatal(err)
	}
	name := fmt.Sprintf("data/%x.png", sha1.Sum(body.Bytes()))
	if err := os.MkdirAll(filepath.Join(taskDir, "output", "data"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taskDir, "output", filepath.FromSlash(name)), body.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestScreenshotUploadsPrecedeReportsAndRetainRelativeName(t *testing.T) {
	m, _, ctx := lifecycleManager(t, 1)
	r := record{RunID: newID(), AttemptID: newID(), Kind: "run"}
	name := writeScreenshot(t, m.taskDir(r), 1)
	output := filepath.Join(m.taskDir(r), "output")
	atomicJSON(filepath.Join(output, "result.json"), Result{Status: "succeeded"})
	atomicJSON(filepath.Join(output, "results.json"), map[string]any{"stats": map[string]int{"expected": 1, "unexpected": 0}, "errors": []string{}})
	os.WriteFile(filepath.Join(output, "report.html"), []byte(`<img src="`+name+`">`), 0600)
	result, names := collectResult(m.taskDir(r), execution{ExitCode: 0})
	if result.Status != "succeeded" || len(names) != 3 || names[0] != name || names[1] != "report.html" {
		t.Fatalf("invalid upload order: %v %+v", names, result)
	}
	m.http.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if !strings.HasSuffix(req.URL.Path, "/artifacts/"+name) || req.Header.Get("Content-Type") != "image/png" {
			t.Error("PNG name/MIME changed during upload")
		}
		if req.Header.Get("X-Attempt-Id") != r.AttemptID {
			t.Error("missing PNG attempt identity")
		}
		body, err := io.ReadAll(req.Body)
		if err != nil || !bytes.HasPrefix(body, []byte{137, 80, 78, 71}) {
			t.Error("PNG upload body is invalid")
		}
		return &http.Response{StatusCode: 201, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
	})
	if err := m.upload(ctx, r, name); err != nil {
		t.Fatal(err)
	}
	if artifactAllowed(record{Kind: "author"}, name) {
		t.Fatal("author accepted a PNG")
	}
}

func TestScreenshotAllowlistSymlinkAndCountAreEnforced(t *testing.T) {
	dir := t.TempDir()
	name := writeScreenshot(t, dir, 1)
	for _, invalid := range []string{"data/../report.html", "data/a.png", "data/" + strings.Repeat("A", 40) + ".png", "data/" + strings.Repeat("a", 40) + ".svg"} {
		if f, err := openArtifact(dir, invalid); err == nil {
			f.Close()
			t.Fatalf("accepted unsafe filename %s", invalid)
		}
	}
	path := filepath.Join(dir, "output", filepath.FromSlash(name))
	os.Remove(path)
	os.WriteFile(filepath.Join(dir, "host-data"), []byte("host data"), 0600)
	os.Symlink(filepath.Join(dir, "host-data"), path)
	if _, err := collectScreenshots(dir); err == nil {
		t.Fatal("accepted screenshot symlink")
	}
	os.Remove(path)
	for i := 0; i < 33; i++ {
		writeScreenshot(t, dir, i)
	}
	if _, err := collectScreenshots(dir); err == nil {
		t.Fatal("accepted more than 32 screenshots")
	}
}

func TestScreenshotFailureWithholdsHTMLAndOversizePNG(t *testing.T) {
	dir := t.TempDir()
	name := writeScreenshot(t, dir, 1)
	output := filepath.Join(dir, "output")
	f, err := os.OpenFile(filepath.Join(output, filepath.FromSlash(name)), os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	f.Truncate(maxScreenshotBytes + 1)
	f.Close()
	atomicJSON(filepath.Join(output, "result.json"), Result{Status: "succeeded"})
	os.WriteFile(filepath.Join(output, "report.html"), []byte("HTML must be withheld"), 0600)
	result, names := collectResult(dir, execution{ExitCode: 0})
	if result.Status != "failed" {
		t.Fatal("oversized PNG became success")
	}
	for _, artifact := range names {
		if artifact == "report.html" {
			t.Fatal("published HTML with missing screenshot")
		}
	}
}
