package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"os"
	"strings"
)

func tlsFiles(getenv func(string) string) (string, string, error) {
	cert, key := getenv("TLS_CERT_FILE"), getenv("TLS_KEY_FILE")
	if (cert == "") != (key == "") {
		return "", "", errors.New("TLS_CERT_FILE and TLS_KEY_FILE must be configured together")
	}
	return cert, key, nil
}

func listenerTLS(certFile, keyFile string) (*tls.Config, error) {
	if certFile == "" && keyFile == "" {
		return nil, nil
	}
	pair, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, errors.New("TLS certificate/key could not be loaded")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{pair}}, nil
}

// The CLI probe still connects only to loopback. It verifies the configured
// public certificate and its SAN, including synthetic deployment test certs.
func readinessTLS(certFile string) (*tls.Config, error) {
	body, err := os.ReadFile(certFile)
	if err != nil {
		return nil, errors.New("TLS readiness certificate unavailable")
	}
	block, _ := pem.Decode(body)
	if block == nil {
		return nil, errors.New("TLS readiness certificate invalid")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return nil, errors.New("TLS readiness certificate invalid")
	}
	name := ""
	if len(cert.DNSNames) > 0 {
		name = cert.DNSNames[0]
		if strings.HasPrefix(name, "*.") {
			name = "healthcheck." + strings.TrimPrefix(name, "*.")
		}
	} else if len(cert.IPAddresses) > 0 {
		name = cert.IPAddresses[0].String()
	}
	if name == "" {
		return nil, errors.New("TLS readiness certificate needs a subject alternative name")
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(body) {
		return nil, errors.New("TLS readiness certificate invalid")
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots, ServerName: name}, nil
}
