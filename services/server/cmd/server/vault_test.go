package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/whippet/whippet/services/server/internal/server"
)

func TestLoadSecretVault(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	dir := t.TempDir()
	file := func(name, data string, mode os.FileMode) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(data), mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, mode); err != nil {
			t.Fatal(err)
		}
		return p
	}
	plain := file("valid", key+"\n", 0600)
	readonly := file("readonly", key, 0400)
	missing := filepath.Join(dir, "missing")
	link := filepath.Join(dir, "link")
	if err := os.Symlink(plain, link); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0600); err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, key, path, fallback string
		available, wantErr        bool
	}{
		{"unconfigured", "", "", "", false, false},
		{"direct", key, "", missing, true, false},
		{"file", "", plain, missing, true, false},
		{"fallback", "", "", readonly, true, false},
		{"both", key, plain, "", false, true},
		{"invalid-direct", "bad", "", plain, false, true},
		{"missing", "", missing, plain, false, true},
		{"empty", "", file("empty", "", 0600), "", false, true},
		{"space", "", file("space", key+" ", 0600), "", false, true},
		{"oversize", "", file("big", key+strings.Repeat("\n", 1025), 0600), "", false, true},
		{"shared", "", file("shared", key, 0644), "", false, true},
		{"directory", "", dir, "", false, true}, {"symlink", "", link, "", false, true}, {"fifo", "", fifo, "", false, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			v, err := loadSecretVault(tt.key, tt.path, tt.fallback)
			if (v != nil) != tt.available || (err != nil) != tt.wantErr {
				t.Fatal("unexpected vault state")
			}
			if err != nil && tt.name != "both" && !errors.Is(err, server.ErrSecretsUnavailable) {
				t.Fatal("expected a sanitized vault error")
			}
			if tt.name == "both" && (err == nil || !strings.Contains(err.Error(), "mutually exclusive")) {
				t.Fatal("expected explicit conflict")
			}
		})
	}
}
