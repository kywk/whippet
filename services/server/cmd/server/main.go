package main

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/whippet/whippet/services/server/internal/gateway"
	"github.com/whippet/whippet/services/server/internal/server"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	var err error
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		err = healthcheck()
	} else {
		err = run(log)
	}
	if err != nil {
		log.Error("server stopped", "error", err)
		os.Exit(1)
	}
}

// The distroless image has no shell or curl; Compose probes readiness via this binary.
func healthcheck() error {
	cert, _, err := tlsFiles(os.Getenv)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return probeReadiness(ctx, env("PORT", "8080"), cert)
}

func probeReadiness(ctx context.Context, port, cert string) error {
	scheme := "http"
	transport := &http.Transport{}
	if cert != "" {
		scheme = "https"
		config, err := readinessTLS(cert)
		if err != nil {
			return err
		}
		transport.TLSClientConfig = config
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+net.JoinHostPort("127.0.0.1", port)+"/readyz", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: transport}
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("readiness returned %s", response.Status)
	}
	return nil
}

func run(log *slog.Logger) error {
	certFile, keyFile, tlsErr := tlsFiles(os.Getenv)
	if tlsErr != nil {
		return tlsErr
	}
	tlsConfig, err := listenerTLS(certFile, keyFile)
	if err != nil {
		return err
	}
	databaseURL, token := os.Getenv("DATABASE_URL"), os.Getenv("MANAGER_TOKEN")
	if databaseURL == "" || token == "" {
		return errors.New("DATABASE_URL and MANAGER_TOKEN are required")
	}
	adminToken, publicOrigin := os.Getenv("WHIPPET_ADMIN_TOKEN"), os.Getenv("WHIPPET_PUBLIC_ORIGIN")
	if adminToken != "" && subtle.ConstantTimeCompare([]byte(adminToken), []byte(token)) == 1 {
		return errors.New("admin and Manager authentication must be distinct")
	}
	if publicOrigin != "" && !validPublicOrigin(publicOrigin) {
		return errors.New("WHIPPET_PUBLIC_ORIGIN must be an exact HTTP(S) origin")
	}
	iceServers, err := server.ParseICEServers(os.Getenv("WHIPPET_LIVE_ICE_SERVERS"))
	if err != nil {
		return err
	}
	port := env("PORT", "8080")
	bindHost := os.Getenv("WHIPPET_BIND_HOST")
	if bindHost != "" && net.ParseIP(bindHost) == nil {
		return errors.New("WHIPPET_BIND_HOST must be an IP address")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return errors.New("PORT must be 1..65535")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(10)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	store := &server.Postgres{DB: db, CredentialTLS: certFile != ""}
	store.Secrets, err = server.NewSecretVault(os.Getenv("WHIPPET_SECRET_MASTER_KEY"))
	if err != nil {
		log.Warn("Workspace credential storage unavailable")
	}
	startupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := store.Ping(startupCtx); err != nil {
		return fmt.Errorf("database connection: %w", err)
	}
	if err := store.Migrate(startupCtx); err != nil {
		return fmt.Errorf("database migrations: %w", err)
	}
	if err := store.RecoverBrowserLeases(startupCtx); err != nil {
		return fmt.Errorf("browser lease recovery: %w", err)
	}
	if err := store.RecoverExternalClaims(startupCtx); err != nil {
		return fmt.Errorf("external author recovery: %w", err)
	}
	artifacts, err := server.NewLocalArtifacts(env("ARTIFACT_DIR", "./data/artifacts"))
	if err != nil {
		return fmt.Errorf("artifact directory: %w", err)
	}
	store.Artifacts = artifacts
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	engine := server.NewEngine(store, log)
	defer engine.Close()
	liveHub := server.NewLiveHub(store, engine, iceServers)
	engine.SetLiveHub(liveHub)
	defer liveHub.Close()
	api := server.NewAPI(store, artifacts, engine, token, log)
	api.WithAdminAccess(adminToken, publicOrigin)
	ws := &gateway.Gateway{Engine: engine, Log: log}
	live := &gateway.LiveGateway{Hub: liveHub}
	api.WithLiveHandlers(http.HandlerFunc(live.Viewer), http.HandlerFunc(live.Media))
	httpServer := &http.Server{
		TLSConfig: tlsConfig,
		Addr:      net.JoinHostPort(bindHost, port), Handler: api.Handler(ws),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 90 * time.Second,
		WriteTimeout: 90 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10,
	}
	go engine.Run(ctx)
	go liveHub.Run(ctx)
	serveErr := make(chan error, 1)
	go func() {
		log.Info("server listening", "port", port)
		if certFile != "" {
			err := httpServer.ListenAndServeTLS("", "")
			if err != nil && !errors.Is(err, http.ErrServerClosed) {
				err = errors.New("TLS listener failed")
			}
			serveErr <- err
		} else {
			serveErr <- httpServer.ListenAndServe()
		}
	}()
	select {
	case err := <-serveErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	engine.Close()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	return httpServer.Shutdown(shutdownCtx)
}

func validPublicOrigin(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && u.String() == raw
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
