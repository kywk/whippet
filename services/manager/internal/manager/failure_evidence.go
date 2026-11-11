package manager

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"os"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const maxEvidenceZIPBytes int64 = 64 << 20
const maxEvidenceMDBytes int64 = 1 << 20
const maxEvidenceCount = 32
const maxEvidenceTotalBytes int64 = 128 << 20

var evidencePattern = regexp.MustCompile(`^data/[0-9a-f]{40}\.(zip|md)$`)

func evidenceLimit(name string) int64 {
	if strings.HasSuffix(name, ".md") {
		return maxEvidenceMDBytes
	}
	return maxEvidenceZIPBytes
}

func verifyEvidence(file *os.File, name string) error {
	var header [4]byte
	if strings.HasSuffix(name, ".zip") {
		if _, err := io.ReadFull(file, header[:]); err != nil || header[0] != 'P' || header[1] != 'K' ||
			!(header[2] == 3 && header[3] == 4 || header[2] == 5 && header[3] == 6) {
			return errors.New("invalid evidence ZIP signature")
		}
	} else {
		body, err := io.ReadAll(io.LimitReader(file, maxEvidenceMDBytes+1))
		if err != nil || int64(len(body)) > maxEvidenceMDBytes || !utf8.Valid(body) {
			return errors.New("invalid evidence Markdown UTF-8")
		}
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	hash := sha1.New()
	size, err := io.Copy(hash, io.LimitReader(file, evidenceLimit(name)+1))
	if err != nil || size > evidenceLimit(name) {
		return errors.New("invalid evidence size")
	}
	ext := ".zip"
	if strings.HasSuffix(name, ".md") {
		ext = ".md"
	}
	if "data/"+hex.EncodeToString(hash.Sum(nil))+ext != name {
		return errors.New("evidence filename/content hash mismatch")
	}
	_, err = file.Seek(0, io.SeekStart)
	return err
}

func admitEvidence(taskDir, name string, count *int, total *int64) bool {
	file, err := openArtifact(taskDir, name)
	if err != nil {
		slog.Warn("optional failure evidence skipped", "reason", "invalid_file")
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		slog.Warn("optional failure evidence skipped", "reason", "invalid_file")
		return false
	}
	if *count >= maxEvidenceCount || *total+info.Size() > maxEvidenceTotalBytes {
		slog.Warn("optional failure evidence skipped", "reason", "quota")
		return false
	}
	*count += 1
	*total += info.Size()
	return true
}

func collectFailureEvidence(taskDir string) []string {
	root, err := openOutputRoot(taskDir)
	if err != nil {
		return nil
	}
	defer root.Close()
	info, err := root.Lstat("data")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		slog.Warn("optional failure evidence skipped", "reason", "unsafe_directory")
		return nil
	}
	dir, err := root.Open("data")
	if err != nil {
		return nil
	}
	defer dir.Close()
	var names []string
	var total int64
	count, scanned := 0, 0
	for {
		entries, err := dir.ReadDir(64)
		if err != nil && err != io.EOF {
			slog.Warn("optional failure evidence skipped", "reason", "scan_failed")
			break
		}
		for _, entry := range entries {
			scanned++
			if scanned > 2048 {
				slog.Warn("optional failure evidence skipped", "reason", "scan_limit")
				return names
			}
			if !strings.HasSuffix(strings.ToLower(entry.Name()), ".zip") && !strings.HasSuffix(strings.ToLower(entry.Name()), ".md") {
				continue
			}
			name := "data/" + entry.Name()
			if !evidencePattern.MatchString(name) {
				slog.Warn("optional failure evidence skipped", "reason", "invalid_name")
				continue
			}
			if admitEvidence(taskDir, name, &count, &total) {
				names = append(names, name)
			}
		}
		if err == io.EOF {
			break
		}
	}
	sort.Strings(names)
	return names
}

// Recovery revalidates optional evidence before upload; corrupt or over-quota
// files must not poison the saved assertion result or block terminal delivery.
func filterFailureEvidence(taskDir string, names []string) []string {
	var filtered []string
	var total int64
	count := 0
	for _, name := range names {
		if !evidencePattern.MatchString(name) || admitEvidence(taskDir, name, &count, &total) {
			filtered = append(filtered, name)
		}
	}
	return filtered
}

type skippedEvidenceError struct{}

func (*skippedEvidenceError) Error() string { return "optional failure evidence HTTP 413; skipped" }
