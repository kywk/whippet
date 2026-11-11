package server

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const MaxArtifactBytes int64 = 64 << 20
const MaxScreenshotBytes int64 = 10 << 20
const MaxScreenshotTotalBytes int64 = 64 << 20
const MaxScreenshotCount = 32
const MaxMarkdownBytes int64 = 1 << 20
const MaxEvidenceTotalBytes int64 = 128 << 20
const MaxEvidenceCount = 32

func checkEvidenceQuota(count, total, size int64) error {
	if count >= MaxEvidenceCount || total+size > MaxEvidenceTotalBytes {
		return fmt.Errorf("%w: ZIP/MD quota exceeds 32 files or 128 MiB per run", ErrInvalid)
	}
	return nil
}

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
	if isEvidenceArtifact(name) && strings.HasSuffix(name, ".md") {
		return MaxMarkdownBytes
	}
	return MaxArtifactBytes
}

func artifactContentType(name string) string {
	switch {
	case name == "report.html":
		return "text/html; charset=utf-8"
	case isScreenshotArtifact(name):
		return "image/png"
	case isEvidenceArtifact(name) && strings.HasSuffix(name, ".zip"):
		return "application/zip"
	case isEvidenceArtifact(name):
		return "text/markdown; charset=utf-8"
	default:
		return "application/json"
	}
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
	nameHash := sha1.New() // Native Playwright attachment filenames use SHA1.
	writers := []io.Writer{tmp, hash}
	if isEvidenceArtifact(name) {
		writers = append(writers, nameHash)
	}
	limit := artifactLimit(name)
	a.Size, err = io.Copy(io.MultiWriter(writers...), io.LimitReader(body, limit+1))
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
	if isEvidenceArtifact(name) {
		if a.Size == 0 || name != fmt.Sprintf("data/%x%s", nameHash.Sum(nil), filepath.Ext(name)) {
			return a, fmt.Errorf("%w: evidence filename/content hash mismatch or empty file", ErrInvalid)
		}
		if strings.HasSuffix(name, ".zip") {
			var signature [4]byte
			_, err := tmp.ReadAt(signature[:], 0)
			// Basic ZIP local-file / empty-archive signatures only. Never unpack.
			if err != nil || (!bytes.Equal(signature[:], []byte{'P', 'K', 3, 4}) && !bytes.Equal(signature[:], []byte{'P', 'K', 5, 6})) {
				return a, fmt.Errorf("%w: evidence must have a ZIP signature", ErrInvalid)
			}
		} else {
			data, err := io.ReadAll(io.NewSectionReader(tmp, 0, a.Size))
			if err != nil {
				return a, err
			}
			if !utf8.Valid(data) {
				return a, fmt.Errorf("%w: Markdown must be UTF-8", ErrInvalid)
			}
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
