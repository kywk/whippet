package manager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func openArtifact(taskDir, name string) (*os.File, error) {
	shot := screenshotPattern.MatchString(name)
	evidence := evidencePattern.MatchString(name)
	if name != "report.html" && name != "results.json" && name != "result.json" && name != "author.json" && !shot && !evidence {
		return nil, errors.New("unsupported artifact name")
	}
	// OpenRoot rejects symlinks escaping the output directory. A Worker must not
	// trick the host Manager into uploading arbitrary host files.
	root, err := openOutputRoot(taskDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	if shot || evidence {
		data, err := root.Lstat("data")
		if err != nil {
			return nil, err
		}
		if !data.IsDir() || data.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("screenshot data must be a regular directory")
		}
	}
	// A named pipe would otherwise block Open before we could inspect its type.
	entry, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !entry.Mode().IsRegular() {
		return nil, fmt.Errorf("artifact %s must be a regular file", name)
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	limit := int64(maxArtifactBytes)
	if name == "author.json" {
		limit = 2 << 20
	}
	if shot {
		limit = maxScreenshotBytes
	}
	if evidence {
		limit = evidenceLimit(name)
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > limit {
		f.Close()
		return nil, fmt.Errorf("artifact %s must be a nonempty regular file of at most %d bytes", name, limit)
	}
	if shot {
		if err := verifyScreenshot(f, name); err != nil {
			f.Close()
			return nil, err
		}
	}
	if evidence {
		if err := verifyEvidence(f, name); err != nil {
			f.Close()
			return nil, err
		}
	}
	return f, nil
}

func readOutput(taskDir, name string, value any) error {
	f, err := openArtifact(taskDir, name)
	if err != nil {
		return err
	}
	defer f.Close()
	decoder := json.NewDecoder(io.LimitReader(f, maxArtifactBytes+1))
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("output contains trailing JSON data")
	}
	return nil
}

func collectResult(taskDir string, outcome execution) (Result, []string) {
	var result Result
	if err := readOutput(taskDir, "result.json", &result); err != nil || !result.valid() {
		result = Result{Status: "failed", Error: "Worker result.json missing or invalid"}
	}
	artifacts, screenshotErr := collectScreenshots(taskDir)
	if screenshotErr != nil {
		result = Result{Status: "failed", Error: "Screenshot collection failed; HTML report withheld: " + screenshotErr.Error()}
		artifacts = nil
	}
	artifacts = append(artifacts, collectFailureEvidence(taskDir)...)
	for _, name := range []string{"report.html", "results.json"} {
		if name == "report.html" && screenshotErr != nil {
			continue
		}
		f, err := openArtifact(taskDir, name)
		if err == nil {
			f.Close()
			artifacts = append(artifacts, name)
		} else if result.Status == "succeeded" {
			result = Result{Status: "failed", Error: "Worker declared success without valid " + name}
		}
	}
	if result.Status == "succeeded" {
		var report struct {
			Stats struct {
				Expected   int `json:"expected"`
				Unexpected int `json:"unexpected"`
			} `json:"stats"`
			Errors []json.RawMessage `json:"errors"`
		}
		if err := readOutput(taskDir, "results.json", &report); err != nil || report.Stats.Expected < 1 || report.Stats.Unexpected != 0 || len(report.Errors) != 0 {
			result = Result{Status: "failed", Error: "Playwright JSON report does not prove a passing test run"}
		}
	}
	if outcome.Error != "" {
		result = Result{Status: "failed", Error: outcome.Error}
	} else if outcome.ExitCode != 0 && result.Status == "succeeded" {
		result = Result{Status: "failed", Error: fmt.Sprintf("Worker exited %d despite success manifest", outcome.ExitCode)}
	}
	if outcome.TimedOut {
		result = Result{Status: "timed_out", Error: "Manager watchdog exceeded Worker timeout plus 30s grace"}
	}
	if result.Status != "succeeded" && result.Error == "" {
		result.Error = "Playwright did not succeed; inspect results.json and report.html"
	}
	result.Error = clip(result.Error, 8192)
	return result, artifacts
}

func (m *Manager) upload(ctx context.Context, r record, name string) error {
	if !artifactAllowed(r, name) {
		return errors.New("artifact is not allowed for this task kind")
	}
	f, err := openArtifact(m.taskDir(r), name)
	if err != nil {
		return err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return err
	}
	u := m.cfg.ServerURL + "/api/manager/runs/" + url.PathEscape(r.RunID) + "/artifacts/" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, f)
	if err != nil {
		return err
	}
	req.ContentLength = info.Size()
	req.Header.Set("Authorization", "Bearer "+m.cfg.Token)
	req.Header.Set("X-Attempt-Id", r.AttemptID)
	if name == "report.html" {
		req.Header.Set("Content-Type", "text/html; charset=utf-8")
	} else if screenshotPattern.MatchString(name) {
		req.Header.Set("Content-Type", "image/png")
	} else if strings.HasSuffix(name, ".zip") {
		req.Header.Set("Content-Type", "application/zip")
	} else if strings.HasSuffix(name, ".md") {
		req.Header.Set("Content-Type", "text/markdown; charset=utf-8")
	} else {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := m.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if evidencePattern.MatchString(name) && resp.StatusCode == http.StatusRequestEntityTooLarge {
			return &skippedEvidenceError{}
		}
		// Do not log arbitrary response bodies, which can echo credentials.
		return fmt.Errorf("upload %s: HTTP %d", name, resp.StatusCode)
	}
	_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return err
}

func collectAttemptResult(r record, taskDir string, outcome execution) (Result, []string) {
	if r.Kind != "author" {
		return collectResult(taskDir, outcome)
	}
	var result Result
	if err := readOutput(taskDir, "result.json", &result); err != nil || !result.valid() {
		result.Status = "failed"
	}
	var artifacts []string
	if result.Status == "succeeded" {
		if !validAuthorArtifact(taskDir, r.Author, r.WorkspaceContext) {
			result.Status = "failed"
		} else {
			artifacts = []string{"author.json"}
		}
	}
	if outcome.Error != "" || outcome.ExitCode != 0 && result.Status == "succeeded" {
		result.Status = "failed"
	}
	if outcome.TimedOut {
		result.Status = "timed_out"
	}
	result.Error = ""
	if result.Status != "succeeded" {
		result.Error = "Author task did not complete; provider and browser details are hidden"
		artifacts = nil
	}
	return result, artifacts
}

func newHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 45 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("artifact upload redirects are not allowed")
		},
	}
}
