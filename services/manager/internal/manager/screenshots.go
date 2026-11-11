package manager

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
)

const maxScreenshotBytes int64 = 10 << 20
const maxScreenshotCount = 32
const maxScreenshotTotalBytes int64 = 64 << 20

var screenshotPattern = regexp.MustCompile(`^data/[0-9a-f]{40}\.png$`)

func openOutputRoot(taskDir string) (*os.Root, error) {
	task, err := os.OpenRoot(taskDir)
	if err != nil {
		return nil, err
	}
	defer task.Close()
	return task.OpenRoot("output")
}

func verifyScreenshot(f *os.File, name string) error {
	if _, err := png.DecodeConfig(f); err != nil {
		return errors.New("invalid screenshot PNG")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	hash := sha1.New()
	size, err := io.Copy(hash, io.LimitReader(f, maxScreenshotBytes+1))
	if err != nil || size > maxScreenshotBytes {
		return errors.New("invalid screenshot size")
	}
	if "data/"+hex.EncodeToString(hash.Sum(nil))+".png" != name {
		return errors.New("screenshot filename/content hash mismatch")
	}
	_, err = f.Seek(0, io.SeekStart)
	return err
}

func collectScreenshots(taskDir string) ([]string, error) {
	root, err := openOutputRoot(taskDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	info, err := root.Lstat("data")
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("screenshot data must be a regular directory")
	}
	dir, err := root.Open("data")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	var names []string
	var total int64
	for {
		entries, err := dir.ReadDir(64)
		if err != nil && err != io.EOF {
			return nil, err
		}
		for _, entry := range entries {
			if !strings.HasSuffix(strings.ToLower(entry.Name()), ".png") {
				continue
			}
			name := "data/" + entry.Name()
			if !screenshotPattern.MatchString(name) || len(names) >= maxScreenshotCount {
				return nil, errors.New("screenshot filename/count limit exceeded")
			}
			f, openErr := openArtifact(taskDir, name)
			if openErr != nil {
				return nil, fmt.Errorf("collect screenshot: %w", openErr)
			}
			stat, statErr := f.Stat()
			f.Close()
			if statErr != nil {
				return nil, statErr
			}
			total += stat.Size()
			if total > maxScreenshotTotalBytes {
				return nil, errors.New("screenshot total size limit exceeded")
			}
			names = append(names, name)
		}
		if err == io.EOF {
			break
		}
	}
	sort.Strings(names)
	return names, nil
}
