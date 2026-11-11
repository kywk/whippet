package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
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
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort("127.0.0.1", env("PORT", "8080"))+"/readyz", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Transport: &http.Transport{}}
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
	databaseURL, token := os.Getenv("DATABASE_URL"), os.Getenv("MANAGER_TOKEN")
	if databaseURL == "" || token == "" {
		return errors.New("DATABASE_URL and MANAGER_TOKEN are required")
	}
	port := env("PORT", "8080")
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
	store := &server.Postgres{DB: db}
	startupCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := store.Ping(startupCtx); err != nil {
		return fmt.Errorf("database connection: %w", err)
	}
	if err := store.Migrate(startupCtx); err != nil {
		return fmt.Errorf("database migrations: %w", err)
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
	api := server.NewAPI(store, artifacts, engine, token, log)
	ws := &gateway.Gateway{Engine: engine, Log: log}
	httpServer := &http.Server{
		Addr: net.JoinHostPort("", port), Handler: api.Handler(ws),
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 90 * time.Second,
		WriteTimeout: 90 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10,
	}
	go engine.Run(ctx)
	serveErr := make(chan error, 1)
	go func() {
		log.Info("server listening", "port", port)
		serveErr <- httpServer.ListenAndServe()
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

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
