#!/bin/sh
set -eu
umask 077

deploy_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
env_path="$deploy_dir/.env"
if [ -e "$env_path" ]; then
  printf '保留既有設定：%s\n' "$env_path"
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { printf '需要 openssl 產生本機部署 token。\n' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { printf '需要 Docker CLI。\n' >&2; exit 1; }

work_dir="$deploy_dir/.local/runner"
case "$work_dir" in
  *","*|*"'"*) printf '工作路徑不可包含逗號或單引號。\n' >&2; exit 1 ;;
esac

socket=${DOCKER_SOCKET_PATH:-}
if [ -z "$socket" ]; then
  endpoint=${DOCKER_HOST:-}
  if [ -z "$endpoint" ]; then
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
  fi
  case "$endpoint" in
    unix://*) socket=${endpoint#unix://} ;;
    *) printf 'M1 runner 需要本機 Unix Docker socket，請設定 DOCKER_SOCKET_PATH。\n' >&2; exit 1 ;;
  esac
fi
case "$socket" in
  /*) ;;
  *) printf 'DOCKER_SOCKET_PATH 必須是絕對路徑。\n' >&2; exit 1 ;;
esac
case "$socket" in
  *"'"*) printf 'Socket 路徑不可包含單引號。\n' >&2; exit 1 ;;
esac

postgres_password=$(openssl rand -hex 24)
manager_token=$(openssl rand -hex 32)
mkdir -p "$work_dir"
temp_env=$(mktemp "$deploy_dir/.env.tmp.XXXXXX")
trap 'rm -f "$temp_env"' EXIT HUP INT TERM
cat >"$temp_env" <<EOF
WHIPPET_PROJECT_NAME=whippet-m1
WHIPPET_RUNNER_PROJECT_NAME=whippet-m1-runner
WHIPPET_CONTROL_NETWORK=whippet-m1-control
WEB_PORT=18080
SERVER_PORT=18081
POSTGRES_DB=whippet
POSTGRES_USER=whippet
POSTGRES_PASSWORD=$postgres_password
MANAGER_TOKEN=$manager_token
SERVER_URL=http://server:8080
MANAGER_ID=local-runner
WORKER_IMAGE=whippet-worker:m1
WORK_DIR='$work_dir'
DOCKER_SOCKET_PATH='$socket'
EOF
# Atomic create without replacing an existing configuration from another process.
ln "$temp_env" "$env_path"
printf '已建立本機設定：%s（權限 600；token 不輸出）\n' "$env_path"
printf '已準備持久化 runner 目錄：%s\n' "$work_dir"
