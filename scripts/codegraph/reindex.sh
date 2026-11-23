#!/bin/sh
# Rebuild this project's CodeGraph index.
# Called by .githooks/post-commit on main; safe to run manually.
# Concurrent calls coalesce: at most one rebuild plus one follow-up run.

set -u

repo_root=$(git rev-parse --show-toplevel)
state_dir="$repo_root/.codegraph"
lock_dir="$state_dir/reindex.lock"
pending_file="$state_dir/reindex.pending"
log_file="$state_dir/reindex.log"

if ! command -v codegraph >/dev/null 2>&1; then
  printf '%s\n' "codegraph not found; skipping index rebuild" >&2
  exit 0
fi

mkdir -p "$state_dir"

acquire_lock() {
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" >"$lock_dir/pid"
    return 0
  fi

  lock_pid=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    return 1
  fi

  # Remove a lock left behind by an interrupted run.
  rm -rf "$lock_dir"
  mkdir "$lock_dir" 2>/dev/null || return 1
  printf '%s\n' "$$" >"$lock_dir/pid"
}

cleanup() {
  rm -rf "$lock_dir"
}
trap cleanup EXIT HUP INT TERM

if ! acquire_lock; then
  : >"$pending_file"
  exit 0
fi

cd "$repo_root" || exit 1

# Keep the log bounded.
if [ -f "$log_file" ] && [ "$(wc -c <"$log_file")" -gt 1048576 ]; then
  mv -f "$log_file" "$log_file.1"
fi

while :; do
  rm -f "$pending_file"
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  commit=$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')

  if codegraph index --quiet >>"$log_file" 2>&1; then
    printf '[%s] rebuild ok at %s\n' "$timestamp" "$commit" >>"$log_file"
  else
    status=$?
    printf '[%s] rebuild failed (%s) at %s\n' "$timestamp" "$status" "$commit" >>"$log_file"
  fi

  [ -e "$pending_file" ] || break
  sleep 1
done
