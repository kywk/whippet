#!/usr/bin/env python3
"""Restartable, isolated M10.Z QA environment. Run create once, then start/status.

Secrets are kept under STATE_DIR. This recipe never reads an older M10.Z state,
model environment file, or free-form log. start does no fixture/DB seed work.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from urllib.parse import parse_qs, quote
import urllib.request

sys.dont_write_bytecode = True


REPO = Path(__file__).resolve().parents[2]
STATE_DIR = Path("/Users/kywk/.local/share/whippet/m10z-20261115")
PREFIX = "whippet-m10z-20261115"
MANAGER_ID = "m10z-20261115"
PG_NAME = PREFIX + "-pg"
PG_VOLUME = PREFIX + "-pgdata"
MANAGER_NAME = PREFIX + "-manager"
PG_IMAGE = "postgres:16"
MANAGER_IMAGE = "sha256:b1ad5410cdc64e7a6163a11e62e04a4f573d57698f307896d3811fa6cc0ed302"
WORKER_IMAGE = "sha256:f7306c35d1d7a6dd6924e6eec4a4b06fe2ee5c1733b9b600732c625b9cb4d66a"
PORTS = {"web": 19987, "target": 19988, "api": 19989}
PRIVATE_FILES = ("vault-key", "manager-token", "pg-password", "target-credentials.json",
                 "manager.env", "qa.crt", "qa.key", "state.json")


class RecipeError(Exception):
    pass


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tree_hash(root: Path) -> str:
    h = hashlib.sha256()
    if not root.is_dir() or root.is_symlink():
        raise RecipeError("source_tree_unavailable")
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RecipeError("source_symlink_rejected")
        if path.is_file():
            relative = path.relative_to(root).as_posix().encode()
            h.update(len(relative).to_bytes(4, "big") + relative)
            h.update(bytes.fromhex(sha256(path)))
    return h.hexdigest()


def web_hash() -> str:
    root = REPO / "apps/web"
    h = hashlib.sha256()
    for name in ("index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json"):
        path = root / name
        if not path.is_file() or path.is_symlink():
            raise RecipeError("web_source_unavailable")
        h.update(name.encode() + bytes.fromhex(sha256(path)))
    for name in ("src", "public"):
        h.update(name.encode() + bytes.fromhex(tree_hash(root / name)))
    return h.hexdigest()


def _new_file(path: Path, data: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, mode)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _json_file(path: Path, value: dict) -> None:
    _new_file(path, (json.dumps(value, sort_keys=True, indent=2) + "\n").encode())


def generate_tls(root: Path) -> None:
    result = subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:host.docker.internal",
        "-keyout", str(root / "qa.key"), "-out", str(root / "qa.crt"),
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    if result.returncode:
        raise RecipeError("tls_generation_failed")
    (root / "qa.key").chmod(0o600)
    (root / "qa.crt").chmod(0o600)


def manager_env(root: Path, token: str) -> bytes:
    lines = {
        "MANAGER_TOKEN": token,
        "SERVER_URL": "https://host.docker.internal:19989",
        "SERVER_CA_FILE": str(root / "qa.crt"),
        "MANAGER_ID": MANAGER_ID,
        "MAX_WORKERS": "1",
        "WORKER_IMAGE": WORKER_IMAGE,
        "WORK_DIR": str(root / "work"),
        "WHIPPET_M109_DIAGNOSTICS": "1",
    }
    return ("".join(f"{key}={value}\n" for key, value in lines.items())).encode()


def create_state(root: Path, server_binary: Path, server_sha256: str) -> None:
    if root.exists() or root.is_symlink():
        raise RecipeError("state_already_exists")
    if not re.fullmatch(r"[0-9a-f]{64}", server_sha256):
        raise RecipeError("invalid_server_sha256")
    if not server_binary.is_file() or server_binary.is_symlink() or sha256(server_binary) != server_sha256:
        raise RecipeError("server_binary_pin_mismatch")
    root.parent.mkdir(parents=True, exist_ok=True)
    root.mkdir(mode=0o700, exist_ok=False)
    for name in ("work", "artifacts"):
        (root / name).mkdir(mode=0o700)
    _new_file(root / "vault-key", base64.b64encode(secrets.token_bytes(32)) + b"\n")
    token = secrets.token_urlsafe(48)
    _new_file(root / "manager-token", (token + "\n").encode())
    _new_file(root / "pg-password", (secrets.token_urlsafe(36) + "\n").encode())
    credentials = {name: {"username": secrets.token_urlsafe(24),
                          "password": secrets.token_urlsafe(32)} for name in ("A", "B")}
    _json_file(root / "target-credentials.json", credentials)
    _new_file(root / "manager.env", manager_env(root, token))
    generate_tls(root)
    with server_binary.open("rb") as source, (root / "server.bin").open("xb") as target:
        shutil.copyfileobj(source, target)
    (root / "server.bin").chmod(0o700)
    if sha256(root / "server.bin") != server_sha256:
        raise RecipeError("server_copy_pin_mismatch")
    registry_src = REPO / "contracts/tools/registry.json"
    registry_sha = sha256(registry_src)
    shutil.copyfile(registry_src, root / "registry.json")
    (root / "registry.json").chmod(0o600)
    skills_src = REPO / "runtimes/worker/skills"
    skills_sha = tree_hash(skills_src)  # Reject symlinks before copying.
    shutil.copytree(skills_src, root / "skills")
    for path in (root / "skills").rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)
    (root / "skills").chmod(0o700)
    if sha256(root / "registry.json") != registry_sha or tree_hash(root / "skills") != skills_sha:
        raise RecipeError("snapshot_copy_pin_mismatch")
    target_src = REPO / "scripts/test/m11w3-ui-target.py"
    target_sha = sha256(target_src)
    shutil.copyfile(target_src, root / "target.py")
    (root / "target.py").chmod(0o600)
    if sha256(root / "target.py") != target_sha:
        raise RecipeError("target_copy_pin_mismatch")
    _json_file(root / "state.json", {
        "schemaVersion": 1, "prefix": PREFIX, "managerId": MANAGER_ID,
        "serverSha256": server_sha256, "managerImage": MANAGER_IMAGE,
        "workerImage": WORKER_IMAGE, "postgresImage": PG_IMAGE,
        "managerIdentitySha256": sha256(root / "manager.env"),
        "registrySha256": registry_sha, "skillsSha256": skills_sha,
        "targetSha256": target_sha, "webSha256": web_hash(),
        "ports": PORTS,
    })


def _check_private(path: Path, mode: int) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != mode:
        raise RecipeError("state_file_permissions_invalid")


def _check_directory(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RecipeError("state_directory_permissions_invalid")


def load_state(root: Path) -> dict:
    _check_directory(root)
    for name in ("work", "artifacts", "skills"):
        _check_directory(root / name)
    for path in (root / "skills").rglob("*"):
        if path.is_dir() and not path.is_symlink():
            _check_directory(path)
        else:
            _check_private(path, 0o600)
    for name in PRIVATE_FILES:
        _check_private(root / name, 0o600)
    for name in ("server.bin",):
        _check_private(root / name, 0o700)
    _check_private(root / "registry.json", 0o600)
    _check_private(root / "target.py", 0o600)
    data = json.loads((root / "state.json").read_text())
    if data.get("schemaVersion") != 1 or data.get("prefix") != PREFIX or data.get("managerId") != MANAGER_ID or data.get("ports") != PORTS:
        raise RecipeError("state_identity_mismatch")
    if data.get("managerImage") != MANAGER_IMAGE or data.get("workerImage") != WORKER_IMAGE or data.get("postgresImage") != PG_IMAGE:
        raise RecipeError("candidate_pin_mismatch")
    if (sha256(root / "server.bin") != data.get("serverSha256")
            or sha256(root / "registry.json") != data.get("registrySha256")
            or sha256(root / "target.py") != data.get("targetSha256")):
        raise RecipeError("source_pin_mismatch")
    if tree_hash(root / "skills") != data.get("skillsSha256") or web_hash() != data.get("webSha256"):
        raise RecipeError("source_pin_mismatch")
    vault = (root / "vault-key").read_text().strip()
    try:
        valid_vault = len(base64.b64decode(vault, validate=True)) == 32
    except (ValueError, binascii.Error):
        valid_vault = False
    if not valid_vault:
        raise RecipeError("vault_key_invalid")
    token = (root / "manager-token").read_text().strip()
    if not token or (root / "manager.env").read_bytes() != manager_env(root, token):
        raise RecipeError("manager_identity_mismatch")
    if data.get("managerIdentitySha256") not in (None, sha256(root / "manager.env")):
        raise RecipeError("manager_identity_pin_mismatch")
    credentials = json.loads((root / "target-credentials.json").read_text())
    if set(credentials) != {"A", "B"} or any(set(v) != {"username", "password"} or not all(v.values()) for v in credentials.values()):
        raise RecipeError("target_identity_invalid")
    if not (root / "pg-password").read_text().strip():
        raise RecipeError("postgres_identity_invalid")
    return data


def _command(args: list[str], *, env: dict | None = None, allow_failure: bool = False) -> str | None:
    result = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
    if result.returncode:
        if allow_failure:
            return None
        raise RecipeError("command_failed_" + Path(args[0]).name)
    return result.stdout.strip()


def docker(*args: str, allow_failure: bool = False) -> str | None:
    return _command(["docker", *args], allow_failure=allow_failure)


def _container(name: str) -> tuple[str, bool] | None:
    output = docker("inspect", "--format", '{{.Image}}|{{.State.Running}}|{{index .Config.Labels "whippet.qa"}}', name, allow_failure=True)
    if output is None:
        return None
    image, running, label = output.split("|", 2)
    if label != MANAGER_ID:
        raise RecipeError("owned_container_label_mismatch")
    return image, running == "true"


def _ensure_volume(*, create_if_missing: bool) -> None:
    label = docker("volume", "inspect", "--format", '{{index .Labels "whippet.qa"}}', PG_VOLUME, allow_failure=True)
    if label is None:
        if not create_if_missing:
            raise RecipeError("postgres_volume_missing")
        docker("volume", "create", "--label", "whippet.qa=" + MANAGER_ID, PG_VOLUME)
    elif label != MANAGER_ID:
        raise RecipeError("postgres_volume_label_mismatch")


def _mounts(name: str) -> list[dict]:
    return json.loads(docker("inspect", "--format", "{{json .Mounts}}", name))


def _has_mount(mounts: list[dict], *, kind: str, source: str, destination: str) -> bool:
    return any(item.get("Type") == kind and
               item.get("Name" if kind == "volume" else "Source") == source and
               item.get("Destination") == destination for item in mounts)


def _postgres(root: Path) -> int:
    existing = _container(PG_NAME)
    if existing is None:
        _ensure_volume(create_if_missing=True)
        docker("run", "-d", "--pull=never", "--restart", "unless-stopped", "--name", PG_NAME,
               "--label", "whippet.qa=" + MANAGER_ID, "-p", "127.0.0.1::5432",
               "--mount", f"type=volume,source={PG_VOLUME},target=/var/lib/postgresql/data",
               "--mount", f"type=bind,source={root / 'pg-password'},target=/run/secrets/pg-password,readonly",
               "-e", "POSTGRES_PASSWORD_FILE=/run/secrets/pg-password", PG_IMAGE)
    else:
        _ensure_volume(create_if_missing=False)
        mounts = _mounts(PG_NAME)
        if not _has_mount(mounts, kind="volume", source=PG_VOLUME, destination="/var/lib/postgresql/data") or not _has_mount(mounts, kind="bind", source=str(root / "pg-password"), destination="/run/secrets/pg-password"):
            raise RecipeError("postgres_mount_mismatch")
        if docker("inspect", "--format", "{{.Config.Image}}", PG_NAME) != PG_IMAGE:
            raise RecipeError("postgres_image_mismatch")
        if not existing[1]:
            docker("start", PG_NAME)
    for _ in range(80):
        if docker("exec", PG_NAME, "pg_isready", "-U", "postgres", allow_failure=True) is not None:
            break
        time.sleep(.25)
    else:
        raise RecipeError("postgres_not_ready")
    binding = docker("port", PG_NAME, "5432/tcp")
    if not binding or not binding.startswith("127.0.0.1:"):
        raise RecipeError("postgres_binding_invalid")
    return int(binding.rsplit(":", 1)[1])


def manager_run_args(root: Path, socket_path: str, model_env_file: Path | None) -> list[str]:
    args = ["docker", "run", "-d", "--pull=never", "--restart", "unless-stopped",
            "--name", MANAGER_NAME, "--label", "whippet.qa=" + MANAGER_ID,
            "--label", "whippet.qa.manager-identity=" + sha256(root / "manager.env"),
            "--label", "whippet.qa.worker-image=" + WORKER_IMAGE]
    if model_env_file is not None:
        args += ["--env-file", str(model_env_file)]
    args += ["--env-file", str(root / "manager.env"),
             "--env", "WHIPPET_WORKER_IMAGE=",
             "--mount", f"type=bind,source={socket_path},target=/var/run/docker.sock",
             "--mount", f"type=bind,source={root / 'work'},target={root / 'work'}",
             "--mount", f"type=bind,source={root / 'qa.crt'},target={root / 'qa.crt'},readonly",
             MANAGER_IMAGE]
    return args


def _manager_identity_matches(root: Path) -> bool:
    labels = docker("inspect", "--format", '{{index .Config.Labels "whippet.qa.manager-identity"}}|{{index .Config.Labels "whippet.qa.worker-image"}}', MANAGER_NAME)
    return labels == sha256(root / "manager.env") + "|" + WORKER_IMAGE


def _manager(root: Path, model_env_file: Path | None) -> None:
    existing = _container(MANAGER_NAME)
    if existing is not None:
        if existing[0] != MANAGER_IMAGE:
            raise RecipeError("manager_image_pin_mismatch")
        mounts = _mounts(MANAGER_NAME)
        if not _has_mount(mounts, kind="bind", source=str(root / "work"), destination=str(root / "work")) or not _has_mount(mounts, kind="bind", source=str(root / "qa.crt"), destination=str(root / "qa.crt")):
            raise RecipeError("manager_mount_mismatch")
        if not _manager_identity_matches(root):
            raise RecipeError("manager_identity_label_mismatch")
        if model_env_file is not None:
            raise RecipeError("manager_exists_model_env_change_requires_explicit_replacement")
        if not existing[1]:
            docker("start", MANAGER_NAME)
        return
    host = docker("context", "inspect", "--format", "{{.Endpoints.docker.Host}}")
    if not host or not host.startswith("unix://"):
        raise RecipeError("docker_socket_unavailable")
    socket_path = host.removeprefix("unix://")
    _command(manager_run_args(root, socket_path, model_env_file))


def _port_free(port: int, host: str) -> None:
    with socket.socket() as probe:
        try:
            probe.bind((host, port))
        except OSError:
            raise RecipeError("dedicated_port_occupied") from None


def _wait_http(url: str, cert: Path | None = None) -> None:
    handlers = [urllib.request.ProxyHandler({})]
    if cert:
        handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(cert))))
    opener = urllib.request.build_opener(*handlers)
    for _ in range(100):
        try:
            with opener.open(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(.2)
    raise RecipeError("service_not_ready")


def _target(root: Path) -> ThreadingHTTPServer:
    source = root / "target.py"
    spec = importlib.util.spec_from_file_location("m10z_public_target", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    page = module.PAGE
    credentials = json.loads((root / "target-credentials.json").read_text())

    class Target(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                body, content_type = page, "text/html; charset=utf-8"
            elif self.path == "/healthz":
                body, content_type = b"ok", "text/plain; charset=utf-8"
            elif self.path == "/login":
                body = b'<h1>QA Login</h1><form method="post" action="/login"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button id="submit">Sign in</button></form>'
                content_type = "text/html; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self.path != "/login":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 8192:
                self.send_error(400)
                return
            form = parse_qs(self.rfile.read(length).decode())
            role = next((name for name, value in credentials.items()
                         if form.get("username") == [value["username"]]
                         and form.get("password") == [value["password"]]), None)
            body = ("<h1>Authenticated " + role + "</h1>" if role else "<h1>Denied</h1>").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return ThreadingHTTPServer(("0.0.0.0", PORTS["target"]), Target)


def start(root: Path, model_env_file: Path | None = None) -> None:
    load_state(root)
    for name, port in PORTS.items():
        _port_free(port, "0.0.0.0" if name == "target" else "127.0.0.1")
    if model_env_file is not None and (not model_env_file.is_file() or model_env_file.is_symlink()):
        raise RecipeError("model_env_file_unavailable")
    if docker("info", "--format", "{{.ServerVersion}}", allow_failure=True) is None:
        raise RecipeError("docker_unavailable")
    if docker("image", "inspect", "--format", "{{.Id}}", MANAGER_IMAGE) != MANAGER_IMAGE:
        raise RecipeError("manager_image_unavailable")
    if docker("image", "inspect", "--format", "{{.Id}}", WORKER_IMAGE) != WORKER_IMAGE:
        raise RecipeError("worker_image_unavailable")
    pg_port = _postgres(root)
    base = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(Path.home())}
    server_env = {**base,
                  "DATABASE_URL": f"postgres://postgres:{quote((root / 'pg-password').read_text().strip(), safe='')}@127.0.0.1:{pg_port}/postgres?sslmode=disable",
                  "MANAGER_TOKEN": (root / "manager-token").read_text().strip(),
                  "WHIPPET_SECRET_MASTER_KEY": (root / "vault-key").read_text().strip(),
                  "TLS_CERT_FILE": str(root / "qa.crt"), "TLS_KEY_FILE": str(root / "qa.key"),
                  "ARTIFACT_DIR": str(root / "artifacts"),
                  "WHIPPET_TOOL_REGISTRY_PATH": str(root / "registry.json"),
                  "WHIPPET_SKILLS_PATH": str(root / "skills"),
                  "WHIPPET_BIND_HOST": "127.0.0.1", "PORT": str(PORTS["api"]),
                  "WHIPPET_PUBLIC_ORIGIN": "http://127.0.0.1:19987"}
    processes = []
    target = None
    try:
        server = subprocess.Popen([str(root / "server.bin")], cwd=REPO, env=server_env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(server)
        _wait_http("https://127.0.0.1:19989/readyz", root / "qa.crt")
        _manager(root, model_env_file)
        target = _target(root)
        Thread(target=target.serve_forever, daemon=True).start()
        web = subprocess.Popen(["node", "node_modules/vite/bin/vite.js", "--host", "127.0.0.1",
                                "--port", str(PORTS["web"]), "--strictPort"], cwd=REPO / "apps/web",
                               env={**base, "WHIPPET_API_PROXY_TARGET": "https://127.0.0.1:19989",
                                    "NODE_EXTRA_CA_CERTS": str(root / "qa.crt")},
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        processes.append(web)
        _wait_http("http://127.0.0.1:19988/healthz")
        _wait_http("http://127.0.0.1:19987")
        print(json.dumps({"status": "RUNNING", "web": "http://127.0.0.1:19987",
                          "api": "https://127.0.0.1:19989", "target": "http://host.docker.internal:19988",
                          "postgresContainer": PG_NAME, "managerContainer": MANAGER_NAME}), flush=True)
        while all(proc.poll() is None for proc in processes):
            time.sleep(.5)
        raise RecipeError("owned_process_exited")
    finally:
        if target:
            target.shutdown()
            target.server_close()
        for proc in reversed(processes):
            if proc.poll() is None:
                proc.terminate()
        for proc in reversed(processes):
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


def status(root: Path) -> dict:
    if not root.exists():
        return {"created": False}
    load_state(root)
    containers = {}
    for name in (PG_NAME, MANAGER_NAME):
        try:
            item = _container(name)
            containers[name] = {"present": item is not None, "running": item[1] if item else False}
            if name == MANAGER_NAME and item is not None:
                containers[name]["identityValid"] = item[0] == MANAGER_IMAGE and _manager_identity_matches(root)
        except RecipeError:
            containers[name] = {"present": "UNKNOWN", "running": "UNKNOWN"}
    listening = {}
    for name, port in PORTS.items():
        with socket.socket() as probe:
            probe.settimeout(.3)
            listening[name] = probe.connect_ex(("127.0.0.1", port)) == 0
    return {"created": True, "stateValid": True, "ports": listening, "containers": containers,
            "serverSha256": json.loads((root / "state.json").read_text())["serverSha256"]}


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("create")
    create.add_argument("--server-binary", type=Path, required=True)
    create.add_argument("--server-sha256", required=True)
    start_parser = sub.add_parser("start")
    start_parser.add_argument("--model-env-file", type=Path)
    sub.add_parser("status")
    args = parser.parse_args()
    try:
        if args.action == "create":
            create_state(STATE_DIR, args.server_binary, args.server_sha256)
            print(json.dumps({"status": "CREATED", "stateDir": str(STATE_DIR)}))
        elif args.action == "start":
            start(STATE_DIR, args.model_env_file)
        else:
            print(json.dumps(status(STATE_DIR), sort_keys=True))
    except (RecipeError, FileExistsError, FileNotFoundError, PermissionError, ValueError, OSError) as error:
        # Error strings are fixed codes only; never print subprocess output, env or credentials.
        code = str(error) if isinstance(error, RecipeError) else type(error).__name__
        print(json.dumps({"status": "STOP", "reason": code}), file=sys.stderr)
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
