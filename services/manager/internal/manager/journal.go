package manager

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// accepted -> running -> collecting -> complete. complete implies container
// removal and successful upload of all available v1 artifacts.
type record struct {
	RunID           string   `json:"runId"`
	AttemptID       string   `json:"attemptId"`
	Phase           string   `json:"phase"`
	TimeoutMS       int64    `json:"timeoutMs"`
	Result          *Result  `json:"result,omitempty"`
	Artifacts       []string `json:"artifacts,omitempty"`
	ResultMessageID string   `json:"resultMessageId"`
	CancelRequested bool     `json:"cancelRequested,omitempty"`
	Reclaimed       bool     `json:"reclaimed,omitempty"`
	Kind            string   `json:"kind,omitempty"`
}

func (r record) holdsSlot() bool { return r.Phase != "complete" && !r.Reclaimed }

func atomicJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func lockWorkDir(cfg Config) (*os.File, error) {
	if err := os.MkdirAll(filepath.Join(cfg.WorkDir, "journal"), 0700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(cfg.WorkDir, "runs"), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(cfg.WorkDir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("WORK_DIR is already owned by another Manager: %w", err)
	}
	ownerPath := filepath.Join(cfg.WorkDir, "manager-id")
	owner, err := os.ReadFile(ownerPath)
	if errors.Is(err, os.ErrNotExist) {
		err = os.WriteFile(ownerPath, []byte(cfg.ManagerID), 0600)
	} else if err == nil && string(owner) != cfg.ManagerID {
		err = errors.New("WORK_DIR belongs to a different MANAGER_ID")
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func loadRecords(workDir string) (map[string]record, error) {
	entries, err := os.ReadDir(filepath.Join(workDir, "journal"))
	if err != nil {
		return nil, err
	}
	records := make(map[string]record)
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(workDir, "journal", entry.Name()))
		if err != nil {
			return nil, err
		}
		var r record
		if err := json.Unmarshal(data, &r); err != nil {
			return nil, fmt.Errorf("corrupt journal %s: %w", entry.Name(), err)
		}
		if !uuidPattern.MatchString(r.RunID) || !uuidPattern.MatchString(r.AttemptID) || entry.Name() != r.AttemptID+".json" || !uuidPattern.MatchString(r.ResultMessageID) {
			return nil, fmt.Errorf("invalid journal identity: %s", entry.Name())
		}
		if r.Phase != "accepted" && r.Phase != "running" && r.Phase != "collecting" && r.Phase != "complete" {
			return nil, fmt.Errorf("invalid journal phase: %s", r.Phase)
		}
		if r.Kind != "" && r.Kind != "run" && r.Kind != "author" {
			return nil, fmt.Errorf("invalid journal kind: %s", entry.Name())
		}
		if r.Result != nil && !r.Result.valid() || (r.Phase == "complete" || r.Phase == "collecting") && r.Result == nil {
			return nil, fmt.Errorf("invalid journal result: %s", entry.Name())
		}
		pngCount, evidenceCount := 0, 0
		for _, name := range r.Artifacts {
			if !artifactAllowed(r, name) {
				return nil, fmt.Errorf("invalid journal artifact: %s", name)
			}
			if screenshotPattern.MatchString(name) {
				pngCount++
			}
			if evidencePattern.MatchString(name) {
				evidenceCount++
			}
		}
		if pngCount > maxScreenshotCount {
			return nil, errors.New("journal screenshot count limit exceeded")
		}
		if evidenceCount > maxEvidenceCount {
			return nil, errors.New("journal evidence count limit exceeded")
		}
		records[r.AttemptID] = r
	}
	return records, nil
}
