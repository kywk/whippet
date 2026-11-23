package main

import (
	"errors"
	"io"
	"os"
	"syscall"

	"github.com/whippet/whippet/services/server/internal/server"
)

// Deployments may set this path with -ldflags '-X main.defaultSecretMasterKeyFile=…'.
var defaultSecretMasterKeyFile string

func loadSecretVault(key, file, fallback string) (*server.SecretVault, error) {
	if key != "" && file != "" {
		return nil, errors.New("WHIPPET_SECRET_MASTER_KEY and WHIPPET_SECRET_MASTER_KEY_FILE are mutually exclusive")
	}
	if key != "" {
		return server.NewSecretVault(key)
	}
	if file == "" {
		file = fallback
	}
	if file == "" {
		return nil, nil
	}
	// O_NONBLOCK keeps a misconfigured FIFO from blocking startup before Stat.
	f, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, server.ErrSecretsUnavailable
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || (info.Mode().Perm() != 0600 && info.Mode().Perm() != 0400) {
		return nil, server.ErrSecretsUnavailable
	}
	const maxBytes = 1024
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil || len(data) == 0 || len(data) > maxBytes {
		return nil, server.ErrSecretsUnavailable
	}
	return server.NewSecretVault(string(data))
}
