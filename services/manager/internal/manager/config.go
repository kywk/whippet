package manager

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	ServerURL    string
	ServerCAFile string
	Token        string
	ManagerID    string
	WorkerImage  string
	WorkDir      string
	MaxWorkers   int
}

func LoadConfig() (Config, error) {
	cfg := Config{
		ServerURL:    strings.TrimRight(os.Getenv("SERVER_URL"), "/"),
		ServerCAFile: os.Getenv("SERVER_CA_FILE"),
		Token:        os.Getenv("MANAGER_TOKEN"),
		ManagerID:    os.Getenv("MANAGER_ID"),
		WorkerImage:  os.Getenv("WORKER_IMAGE"),
		WorkDir:      os.Getenv("WORK_DIR"),
		MaxWorkers:   1,
	}
	// The v1 contract names both variables. WORKER_IMAGE is the canonical name.
	if alias := os.Getenv("WHIPPET_WORKER_IMAGE"); alias != "" {
		if cfg.WorkerImage != "" && cfg.WorkerImage != alias {
			return cfg, errors.New("WORKER_IMAGE and WHIPPET_WORKER_IMAGE disagree")
		}
		cfg.WorkerImage = alias
	}
	if cfg.ServerURL == "" || cfg.Token == "" || cfg.ManagerID == "" || cfg.WorkerImage == "" {
		return cfg, errors.New("SERVER_URL, MANAGER_TOKEN, MANAGER_ID and WORKER_IMAGE are required")
	}
	u, err := url.Parse(cfg.ServerURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return cfg, errors.New("SERVER_URL must be an http(s) origin, without credentials, query or path")
	}
	if len(cfg.ManagerID) > 128 || strings.ContainsAny(cfg.ManagerID, "\r\n\t ") || strings.ContainsAny(cfg.Token, "\r\n") {
		return cfg, errors.New("invalid MANAGER_ID or MANAGER_TOKEN")
	}
	if value := os.Getenv("MAX_WORKERS"); value != "" {
		cfg.MaxWorkers, err = strconv.Atoi(value)
		if err != nil || cfg.MaxWorkers < 1 || cfg.MaxWorkers > 64 {
			return cfg, errors.New("MAX_WORKERS must be an integer between 1 and 64")
		}
	}
	if cfg.WorkDir == "" {
		cfg.WorkDir = "./work"
	}
	cfg.WorkDir, err = filepath.Abs(cfg.WorkDir)
	if err != nil {
		return cfg, fmt.Errorf("WORK_DIR: %w", err)
	}
	if strings.Contains(cfg.WorkDir, ",") {
		return cfg, errors.New("WORK_DIR cannot contain commas (Docker bind mount syntax)")
	}
	return cfg, nil
}

func serverTLSConfig(cfg Config) (*tls.Config, error) {
	if cfg.ServerCAFile == "" {
		return nil, nil
	}
	if !strings.HasPrefix(cfg.ServerURL, "https://") {
		return nil, errors.New("SERVER_CA_FILE requires an HTTPS SERVER_URL")
	}
	info, err := os.Stat(cfg.ServerCAFile)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 1<<20 {
		return nil, errors.New("invalid SERVER_CA_FILE")
	}
	pem, err := os.ReadFile(cfg.ServerCAFile)
	if err != nil {
		return nil, errors.New("cannot read SERVER_CA_FILE")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("SERVER_CA_FILE contains no CA certificate")
	}
	return &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, nil
}
