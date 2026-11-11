package server

import (
	"bytes"
	_ "embed"
	"fmt"
	"io"
	"regexp"
)

//go:embed report-storage.js
var reportStorageScript string

var reportHead = regexp.MustCompile(`(?i)<head(?:\s[^>]*)?>`)
var reportDoctype = regexp.MustCompile(`(?i)<!doctype[^>]*>`)

// reportContent adapts the HTTP representation, preserving the saved artifact bytes.
// The upload limit bounds buffering; the compatibility script must precede report JS.
func reportContent(source io.Reader) (*bytes.Reader, error) {
	body, err := io.ReadAll(io.LimitReader(source, MaxArtifactBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > MaxArtifactBytes {
		return nil, fmt.Errorf("report exceeds artifact size limit")
	}
	prefix := body[:min(len(body), 32<<10)]
	insert := 0
	if match := reportHead.FindIndex(prefix); match != nil {
		insert = match[1]
	} else if match := reportDoctype.FindIndex(prefix); match != nil {
		insert = match[1]
	}
	shim := []byte("\n<script data-whippet-storage-shim>\n" + reportStorageScript + "\n</script>\n")
	originalSize := len(body)
	body = append(body, make([]byte, len(shim))...)
	copy(body[insert+len(shim):], body[insert:originalSize])
	copy(body[insert:], shim)
	return bytes.NewReader(body), nil
}
