#!/usr/bin/env python3
"""Build and run WLA-4 from one Git commit or working-tree snapshot."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
from uuid import uuid4


EXCLUDED_NAMES = {
    ".git", ".aws", ".ssh", ".docker", ".envrc", ".npmrc", ".netrc", ".pypirc", ".git-credentials",
    ".venv", ".npm-cache", ".DS_Store", "__pycache__", "node_modules", "dist", "coverage",
    "playwright-report", "test-results",
}
LOCAL_BINARIES = {Path("services/server/server"), Path("services/manager/manager")}
WEB = Path("web-build/apps/web")
MANIFEST = "build.json"


def git(repo, *args):
    return subprocess.check_output(["git", *args], cwd=repo)


def included(path):
    name = path.name
    local_env = name == ".env" or (name.startswith(".env.") and not name.endswith(".example"))
    return (not local_env and path not in LOCAL_BINARIES and EXCLUDED_NAMES.isdisjoint(path.parts)
            and path.suffix.lower() not in {".key", ".pem", ".p12", ".pfx", ".log"})


def snapshot_commit(repo, source, commit):
    with subprocess.Popen(["git", "archive", "--format=tar", commit], cwd=repo,
                          stdout=subprocess.PIPE) as archive:
        with tarfile.open(fileobj=archive.stdout, mode="r|") as tar:
            for member in tar:
                relative = Path(member.name)
                if member.isdir() or not included(relative):
                    continue
                target = source / relative
                if relative.is_absolute() or ".." in relative.parts or target.parent.resolve() != target.parent:
                    raise ValueError(f"invalid archive path: {relative}")
                target.parent.mkdir(parents=True, exist_ok=True)
                if member.isfile():
                    with tar.extractfile(member) as contents, target.open("xb") as output:
                        shutil.copyfileobj(contents, output)
                    target.chmod(0o755 if member.mode & stat.S_IXUSR else 0o644)
                elif member.issym():
                    target.symlink_to(member.linkname)
                else:
                    raise ValueError(f"unsupported archive member: {relative}")
        if archive.wait():
            raise RuntimeError("git archive failed")


def snapshot_worktree(repo, source):
    paths = git(repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard").split(b"\0")
    for name in sorted(set(paths) - {b""}):
        relative = Path(os.fsdecode(name))
        original = repo / relative
        if not included(relative) or original.parent.resolve() != original.parent:
            continue
        try:
            mode_bits = original.lstat().st_mode
        except FileNotFoundError:
            continue  # A tracked file deleted from the working tree.
        if stat.S_ISDIR(mode_bits):
            continue  # Git can list a nested repository without listing its files.
        if not (stat.S_ISREG(mode_bits) or stat.S_ISLNK(mode_bits)):
            raise ValueError(f"unsupported source file: {relative}")
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(original, target, follow_symlinks=False)


def snapshot(repo, source, commit, mode):
    source.mkdir()
    if mode == "commit":
        snapshot_commit(repo, source, commit)
    else:
        snapshot_worktree(repo, source)

    for path in source.rglob("*"):
        if path.is_symlink() and (path.readlink().is_absolute()
                                  or not path.resolve().is_relative_to(source) or not path.exists()):
            raise ValueError(f"source symlink must resolve inside the snapshot: {path.relative_to(source)}")


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as contents:
        for chunk in iter(lambda: contents.read(65536), b""):
            digest.update(chunk)
    return digest.digest()


def tree_sha256(root):
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            kind, contents = b"l", hashlib.sha256(os.fsencode(os.readlink(path))).digest()
        elif path.is_file():
            kind = b"x" if path.stat().st_mode & stat.S_IXUSR else b"f"
            contents = file_sha256(path)
        else:
            continue
        digest.update(kind + os.fsencode(path.relative_to(root).as_posix()) + b"\0" + contents)
    return digest.hexdigest()


def build_image(source, tag, dockerfile, *flags):
    subprocess.run(["docker", "build", "-f", dockerfile, "-t", tag, *flags, "."], cwd=source, check=True)
    image_id = subprocess.check_output(["docker", "image", "inspect", tag, "--format", "{{.Id}}"],
                                       cwd=source, text=True).strip()
    if not image_id.startswith("sha256:"):
        raise RuntimeError(f"missing image ID for {tag}")
    return {"tag": tag, "imageId": image_id}


def build(args):
    repo = Path(os.fsdecode(git(Path.cwd(), "rev-parse", "--show-toplevel").rstrip(b"\n"))).resolve()
    ref = "HEAD" if args.worktree else args.commit
    commit = git(repo, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode().strip()
    out = args.out.resolve()
    if out.is_relative_to(repo):
        raise ValueError("place the build output outside the checkout so later snapshots exclude it")
    out.mkdir(mode=0o700)

    source = out / "source"
    artifacts = {}
    metadata = {"source": {"mode": "worktree" if args.worktree else "commit", "baseCommit": commit},
                "artifacts": artifacts, "status": "failed", "stage": "snapshot"}
    try:
        snapshot(repo, source, commit, metadata["source"]["mode"])
        metadata["source"]["sha256"] = tree_sha256(source)

        metadata["stage"] = "server"
        arch = args.linux_goarch or subprocess.check_output(
            ["docker", "version", "--format", "{{.Server.Arch}}"], text=True).strip()
        server_env = {**os.environ, "CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": arch}
        server = out / "server"
        go_build = ["go", "build", "-mod=readonly", "-buildvcs=false", "-trimpath"]
        subprocess.run([*go_build, "-o", str(server), "./cmd/server"], cwd=source / "services/server",
                       env=server_env, check=True)
        artifacts["server"] = {"path": server.name, "sha256": file_sha256(server).hex(),
                               "platform": f"linux/{arch}"}

        metadata["stage"] = "manager"
        manager = out / "manager"
        subprocess.run([*go_build, "-o", str(manager), "./cmd/manager"], cwd=source / "services/manager", check=True)
        artifacts["manager"] = {"path": manager.name, "sha256": file_sha256(manager).hex()}

        metadata["stage"] = "web"
        # Keep npm and Vite output out of the snapshot while preserving relative imports.
        shutil.copytree(source, out / "web-build", symlinks=True)
        web_root = out / WEB
        subprocess.run(["npm", "ci", "--no-audit", "--no-fund"], cwd=web_root, check=True)
        subprocess.run(["npm", "run", "build"], cwd=web_root, check=True)
        if not (web_root / "dist/index.html").is_file():
            raise RuntimeError("missing Vite build output")
        artifacts["web"] = {"path": str(WEB / "dist"), "sha256": tree_sha256(web_root / "dist")}

        metadata["stage"] = "worker"
        worker_tag = f"whippet-worker:wla4-{uuid4().hex[:12]}"
        artifacts["worker"] = build_image(source, worker_tag, "runtimes/worker/Dockerfile")
        metadata["stage"] = "wlaWorker"
        artifacts["wlaWorker"] = build_image(source, f"{worker_tag}-model", "scripts/test/wla4-worker.Dockerfile",
                                             "--network=none", "--build-arg", f"WORKER_IMAGE={worker_tag}")
        if tree_sha256(source) != metadata["source"]["sha256"]:
            metadata["stage"] = "snapshot"
            raise ValueError("source snapshot changed during the build")
        metadata["status"] = "passed"
        del metadata["stage"]
    finally:
        (out / MANIFEST).write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(out / MANIFEST)


def run(args):
    build_dir = args.build_dir.resolve()
    source = build_dir / "source"
    manifest = build_dir / MANIFEST
    metadata = json.loads(manifest.read_text(encoding="utf-8"))
    if metadata["status"] != "passed":
        raise ValueError(f"build stopped at {metadata['stage']}; use a completed build")
    if tree_sha256(source) != metadata["source"]["sha256"]:
        raise ValueError("source snapshot has changed; rebuild before running acceptance")
    artifacts = metadata["artifacts"]
    server, manager, web_root = build_dir / "server", build_dir / "manager", build_dir / WEB
    for name, digest in (("server", file_sha256(server).hex()), ("manager", file_sha256(manager).hex()),
                         ("web", tree_sha256(web_root / "dist"))):
        if digest != artifacts[name]["sha256"]:
            raise ValueError(f"{name} output has changed; rebuild before running acceptance")

    out = args.out.resolve()
    if out.is_relative_to(source) or out.is_relative_to(build_dir / "web-build"):
        raise ValueError("place acceptance output outside the source and Web build trees")
    out.mkdir(mode=0o700)
    shutil.copyfile(manifest, out / MANIFEST)
    runner_args = args.runner_args[1:] if args.runner_args[:1] == ["--"] else args.runner_args
    subprocess.run([sys.executable, "-B", str(source / "scripts/test/adm4-local.py"), *runner_args,
                    "--server-in-docker", "--tls", "--server", str(server), "--manager", str(manager),
                    "--web-root", str(web_root), "--worker-image", artifacts["wlaWorker"]["imageId"],
                    "--out", str(out / "wla")], cwd=source, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    builder = commands.add_parser("build", help="freeze one source tree, build artifacts and record their IDs")
    modes = builder.add_mutually_exclusive_group(required=True)
    modes.add_argument("--commit", metavar="REV", help="snapshot the selected Git commit")
    modes.add_argument("--worktree", action="store_true", help="snapshot the current files, including unignored additions")
    builder.add_argument("--linux-goarch", choices=("arm64", "amd64"), help="Server target (default: Docker host architecture)")
    builder.add_argument("--out", type=Path, required=True, help="new build directory outside the checkout")

    runner = commands.add_parser("run", help="run the frozen adm4-local.py with the recorded artifacts")
    runner.add_argument("--build-dir", type=Path, required=True, help="directory produced by build")
    runner.add_argument("--out", type=Path, required=True, help="new acceptance evidence directory")
    runner.add_argument("runner_args", nargs=argparse.REMAINDER, help="adm4-local.py options after --")

    args = parser.parse_args()
    try:
        if args.command == "build":
            build(args)
        else:
            run(args)
    except subprocess.CalledProcessError as error:
        parser.exit(1, f"{Path(error.cmd[0]).name} exited with status {error.returncode}\n")
    except (OSError, RuntimeError, ValueError, tarfile.TarError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
