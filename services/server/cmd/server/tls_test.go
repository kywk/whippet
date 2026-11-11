package main

import (
	"context"
	"encoding/pem"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTLSConfigurationPairAndInvalidFiles(t *testing.T) {
	for _, values := range []map[string]string{{}, {"TLS_CERT_FILE": "synthetic.pem"}, {"TLS_KEY_FILE": "synthetic.key"}, {"TLS_CERT_FILE": "synthetic.pem", "TLS_KEY_FILE": "synthetic.key"}} {
		cert, key, err := tlsFiles(func(k string) string { return values[k] })
		wantError := (values["TLS_CERT_FILE"] == "") != (values["TLS_KEY_FILE"] == "")
		if (err != nil) != wantError {
			t.Fatal("TLS pair validation")
		}
		if err == nil && cert == "" && key == "" {
			if c, err := listenerTLS(cert, key); c != nil || err != nil {
				t.Fatal("HTTP listener compatibility")
			}
		}
	}
	invalid := filepath.Join(t.TempDir(), "invalid.pem")
	if err := os.WriteFile(invalid, []byte("synthetic invalid certificate"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := listenerTLS(invalid, invalid); err == nil {
		t.Fatal("invalid TLS cert/key must fail startup")
	}
	if _, err := readinessTLS(invalid); err == nil {
		t.Fatal("invalid readiness certificate accepted")
	}
}

func TestTLSReadinessVerifiesCertificate(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			t.Error("wrong probe path")
		}
		w.WriteHeader(http.StatusOK)
	})
	plain := httptest.NewServer(h)
	defer plain.Close()
	secure := httptest.NewUnstartedServer(h)
	secure.Config.ErrorLog = log.New(io.Discard, "", 0)
	secure.StartTLS()
	defer secure.Close()
	// httptest owns this synthetic certificate; no deployment key/cert is read.
	certFile := filepath.Join(t.TempDir(), "synthetic.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: secure.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, httpPort, _ := net.SplitHostPort(plain.Listener.Addr().String())
	_, httpsPort, _ := net.SplitHostPort(secure.Listener.Addr().String())
	if err := probeReadiness(ctx, httpPort, ""); err != nil {
		t.Fatalf("HTTP healthcheck: %v", err)
	}
	if err := probeReadiness(ctx, httpsPort, certFile); err != nil {
		t.Fatalf("verified HTTPS healthcheck: %v", err)
	}
	if err := probeReadiness(ctx, httpsPort, ""); err == nil {
		t.Fatal("HTTPS listener accepted plaintext readiness")
	}
	config, err := readinessTLS(certFile)
	if err != nil || config.InsecureSkipVerify || config.RootCAs == nil || config.ServerName == "" {
		t.Fatal("TLS verification disabled")
	}
	config.ServerName = "wrong.invalid"
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: config}, Timeout: time.Second}
	defer client.CloseIdleConnections()
	if response, err := client.Get(secure.URL + "/readyz"); err == nil {
		response.Body.Close()
		t.Fatal("hostname mismatch accepted")
	}
}
