package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const MaxArtifactBytes int64 = 64 << 20
const MaxScreenshotBytes int64 = 10 << 20
const MaxScreenshotTotalBytes int64 = 64 << 20
const MaxScreenshotCount = 32

func checkScreenshotQuota(count, total, size int64) error {
	if count >= MaxScreenshotCount || size > MaxScreenshotBytes || total+size > MaxScreenshotTotalBytes {
		return fmt.Errorf("%w: PNG quota exceeds 32 files or 64 MiB per run (10 MiB per file)", ErrInvalid)
	}
	return nil
}

func artifactLimit(name string) int64 {
	if name == "author.json" {
		return MaxAuthorArtifactBytes
	}
	if isScreenshotArtifact(name) {
		return MaxScreenshotBytes
	}
	return MaxArtifactBytes
}

// ArtifactStorage keeps HTTP and metadata handling independent of the local filesystem.
type ArtifactStorage interface {
	Save(string, string, string, io.Reader) (Artifact, error)
	Open(string) (*os.File, error)
}

// LocalArtifacts must be owned exclusively by the server OS user.
type LocalArtifacts struct{ root string }

func NewLocalArtifacts(root string) (*LocalArtifacts, error) {
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	abs, err = filepath.EvalSymlinks(abs)
	if err != nil {
		return nil, err
	}
	return &LocalArtifacts{root: abs}, nil
}

func (s *LocalArtifacts) Save(runID, attemptID, name string, body io.Reader) (Artifact, error) {
	a := Artifact{RunID: runID, AttemptID: attemptID, Name: name}
	if !ValidID(runID) || !ValidID(attemptID) || !validArtifact(name) {
		return a, ErrInvalid
	}
	tmp, err := os.CreateTemp(s.root, ".upload-*")
	if err != nil {
		return a, err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	hash := sha256.New()
	limit := artifactLimit(name)
	a.Size, err = io.Copy(io.MultiWriter(tmp, hash), io.LimitReader(body, limit+1))
	if err != nil {
		return a, err
	}
	if a.Size > limit {
		return a, fmt.Errorf("%w: artifact exceeds %d MiB", ErrInvalid, limit>>20)
	}
	if isScreenshotArtifact(name) {
		if _, err := png.DecodeConfig(io.NewSectionReader(tmp, 0, a.Size)); err != nil {
			return a, fmt.Errorf("%w: screenshot must be a valid PNG", ErrInvalid)
		}
	}
	if err := tmp.Sync(); err != nil {
		return a, err
	}
	if err := tmp.Close(); err != nil {
		return a, err
	}
	a.SHA256 = hex.EncodeToString(hash.Sum(nil))
	// Content addressed keys prevent a conflicting retry from overwriting a saved report.
	a.StorageKey = filepath.Join(runID, attemptID, a.SHA256, name)
	path, err := s.resolve(a.StorageKey, true)
	if err != nil {
		return a, err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return a, err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return a, err
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return a, err
	}
	return a, nil
}

func (s *LocalArtifacts) Open(key string) (*os.File, error) {
	path, err := s.resolve(key, false)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, ErrInvalid
	}
	return os.Open(path)
}

func (s *LocalArtifacts) resolve(key string, create bool) (string, error) {
	parts := strings.Split(filepath.ToSlash(key), "/")
	if (len(parts) != 4 && len(parts) != 5) || !ValidID(parts[0]) || !ValidID(parts[1]) || len(parts[2]) != 64 || !validArtifact(strings.Join(parts[3:], "/")) {
		return "", ErrInvalid
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		return "", ErrInvalid
	}
	path := s.root
	for _, part := range parts[:len(parts)-1] {
		path = filepath.Join(path, part)
		if create {
			if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
				return "", err
			}
		}
		info, err := os.Lstat(path)
		if err != nil {
			return "", err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", ErrInvalid
		}
	}
	return filepath.Join(path, parts[len(parts)-1]), nil
}
