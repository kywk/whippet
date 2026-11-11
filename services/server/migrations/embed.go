package migrations

import "embed"

// Files contains the ordered, forward-only schema and seed migrations.
//
//go:embed *.sql
var Files embed.FS
