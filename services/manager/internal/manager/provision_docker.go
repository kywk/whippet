package manager

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func (d dockerCLI) probeName(id string) string {
	owner := sha256.Sum256([]byte(d.cfg.ManagerID))
	return fmt.Sprintf("whippet-%x-probe-%s", owner[:6], strings.ToLower(id))
}

func (d dockerCLI) Probe(ctx context.Context, request provisionRequest, dir string) probeOutcome {
	failure := failedProbe("probe_failed")
	if os.Mkdir(dir, 0700) != nil || atomicJSON(filepath.Join(dir, "input.json"), request) != nil {
		return failure
	}
	name := d.probeName(request.OperationID)
	args := []string{"create", "--pull=never", "--name", name, "--init", "--interactive",
		"--label", "whippet.manager.id=" + d.cfg.ManagerID, "--label", "whippet.provision.id=" + request.OperationID,
		"--mount", "type=bind,source=" + dir + ",target=/work",
		"--memory", "1g", "--cpus", "1", "--pids-limit", "256", "--security-opt", "no-new-privileges=true",
		d.cfg.WorkerImage, "node", "dist/author/probe.js", "--managed-model-key"}
	if dockerCommand(ctx, args...).Run() != nil {
		return failure
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := dockerCommand(runCtx, "start", "--attach", "--interactive", name)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return failure
	}
	defer stdin.Close()
	input := &attemptInputWriter{ctx: runCtx, input: stdin}
	defer input.close()
	key := &modelKeyChannel{
		ctx: runCtx, input: input, resolve: d.resolveModelKey, workspaceID: request.WorkspaceID,
		request: modelKeyRequest{modelCredential: request.credential(), Purpose: "probe", OperationID: request.OperationID},
	}
	cmd.Stdout = &lineWriter{emit: func(string, string) {}, intercept: key.handle}
	cmd.Stderr = io.Discard
	if cmd.Run() != nil {
		return failure
	}
	return readProbeOutcome(dir)
}

func readProbeOutcome(dir string) probeOutcome {
	failure := failedProbe("probe_failed")
	root, err := openOutputRoot(dir)
	if err != nil {
		return failure
	}
	defer root.Close()
	info, err := root.Lstat("probe.json")
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1024 {
		return failure
	}
	file, err := root.Open("probe.json")
	if err != nil {
		return failure
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 1025))
	var outcome probeOutcome
	if err != nil || len(raw) > 1024 || !exactAdminFields(raw, "status", "code") || json.Unmarshal(raw, &outcome) != nil || !outcome.valid() {
		return failure
	}
	return outcome
}

func (d dockerCLI) RemoveProbe(ctx context.Context, id string) error {
	name := d.probeName(id)
	out, err := dockerCommand(ctx, "container", "inspect", "--format", `{{.Id}} {{json .Config.Labels}}`, name).CombinedOutput()
	if err != nil {
		if bytes.Contains(out, []byte("No such object")) || bytes.Contains(out, []byte("No such container")) {
			return nil
		}
		return errors.New("probe container inspection failed")
	}
	containerID, labelsJSON, _ := strings.Cut(strings.TrimSpace(string(out)), " ")
	var labels map[string]string
	if !workerContentID.MatchString(containerID) || json.Unmarshal([]byte(labelsJSON), &labels) != nil ||
		labels["whippet.manager.id"] != d.cfg.ManagerID || labels["whippet.provision.id"] != id {
		return errors.New("probe container ownership mismatch")
	}
	out, err = dockerCommand(ctx, "rm", "--force", containerID).CombinedOutput()
	if err != nil && !bytes.Contains(out, []byte("No such container")) {
		return errors.New("probe container cleanup failed")
	}
	return nil
}
