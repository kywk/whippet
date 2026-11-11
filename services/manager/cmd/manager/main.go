package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"whippet/services/manager/internal/manager"
)

func main() {
	if err := run(); err != nil {
		slog.Error("manager stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := manager.LoadConfig()
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	m, err := manager.New(cfg)
	if err != nil {
		return err
	}
	defer m.Close()
	return m.Run(ctx)
}
