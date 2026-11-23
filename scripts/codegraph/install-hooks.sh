#!/bin/sh
# Install the tracked Git hooks for this repository.
# Usage: sh scripts/codegraph/install-hooks.sh

set -eu

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

chmod +x .githooks/post-commit scripts/codegraph/reindex.sh
git config core.hooksPath .githooks

printf 'Git hooks enabled: core.hooksPath=%s\n' "$(git config --get core.hooksPath)"

if ! command -v codegraph >/dev/null 2>&1; then
  printf '%s\n' "warning: codegraph is not on PATH; the hook will skip until it is installed." >&2
elif [ ! -d "$repo_root/.codegraph" ]; then
  printf '%s\n' "warning: no .codegraph/ index yet; run 'codegraph init --local-only' first." >&2
fi
