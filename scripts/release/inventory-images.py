#!/usr/bin/env python3
"""Offline, stdlib-only evidence inventory. JSON on stdout; no legal verdict.

Only local image IDs are used. Never reads image/container Env, runs application
entrypoints, pulls, mounts host paths, or touches existing containers. Temporary
containers are read-only, offline, capability-free and removed (including their
own anonymous volumes). No files are extracted to the host.
"""

import argparse
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
import zipfile
from datetime import datetime, timezone

DEFAULT_IMAGES = [
    "whippet-server:m9-qa", "whippet-manager:m9-qa", "whippet-worker:m9-qa",
    "whippet-web:m8-real-qa", "postgres:16.11-bookworm",
]
PROBE = r'''
probe() { printf '\n@@ %s\n' "$1"; shift; "$@" 2>&1; printf '@@exit %s\n' "$?"; }
probe node node --version
probe npm npm --version --offline --ignore-scripts --update-notifier=false
probe nginx nginx -v
probe postgres /usr/lib/postgresql/16/bin/postgres --version
probe docker-cli docker --version
for p in /ms-playwright/chromium-*/chrome-linux*/chrome /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/headless_shell /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell /ms-playwright/firefox-*/firefox/firefox; do
  [ ! -f "$p" ] || probe "$p" "$p" --version
done
for p in /ms-playwright/webkit-*/pw_run.sh; do
  [ ! -f "$p" ] || probe "$p" timeout 5 "$p" --headless --version
done
for p in /ms-playwright/ffmpeg-*/ffmpeg-linux*; do
  [ ! -f "$p" ] || probe "$p" "$p" -version
done
printf '\n@@ license_sha256\n'
for root in /usr/share/doc /usr/share/licenses /usr/local/share/doc /usr/lib/node_modules /usr/local/lib/node_modules /usr/local/include/node /ms-playwright /opt/whippet/worker/node_modules /opt/whippet/licenses; do
  [ ! -d "$root" ] || find "$root" \( -type f -o -type l \) \( -iname '*license*' -o -iname '*notice*' -o -iname 'copying*' -o -iname 'copyright*' -o -name 'ABOUT' \) ! -iname '*.js' ! -iname '*.ts' ! -iname '*.json' ! -iname '*.map' -exec sha256sum '{}' \;
done
for p in /LICENSE /NOTICE /usr/local/LICENSE /usr/local/NOTICE; do
  [ ! -f "$p" ] || sha256sum "$p"
done
'''


def docker(*args, timeout=90):
    return subprocess.run(["docker", *args], capture_output=True, timeout=timeout)


def checked(*args):
    result = docker(*args)
    if result.returncode:
        # Do not echo arbitrary Docker diagnostics or config to stdout/stderr.
        raise RuntimeError("docker " + args[0] + " failed (exit %d)" % result.returncode)
    return result.stdout


def read_file(container, path, limit=64 * 1024 * 1024):
    result = docker("cp", "--follow-link", container + ":" + path, "-")
    if result.returncode:
        return None
    with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
        for member in archive:
            if member.isfile() and member.size <= limit:
                return archive.extractfile(member).read()
    return None


def go_buildinfo(data):
    """Go 1.18+ inline build info; never execute a Whippet application binary."""
    offset = data.find(b"\xff Go buildinf:")
    if offset < 0 or len(data) < offset + 32 or not data[offset + 15] & 2:
        return {"status": "unverified", "reason": "inline Go build info not found"}
    cursor = offset + 32

    def string():
        nonlocal cursor
        size, shift = 0, 0
        while cursor < len(data) and shift < 64:
            byte = data[cursor]
            cursor += 1
            size |= (byte & 127) << shift
            if byte < 128:
                if size > len(data) - cursor:
                    raise ValueError("invalid build info size")
                value = data[cursor:cursor + size]
                cursor += size
                return value
            shift += 7
        raise ValueError("invalid build info varint")

    try:
        version, modules = string().decode("utf-8"), string()
        # Module framing is a 16-byte sentinel on each end, not module content.
        content = modules[16:-16].decode("utf-8", "replace") if len(modules) >= 32 else ""
        return {"status": "verified_binary_metadata", "go_version": version,
                "modules": [line for line in content.splitlines()
                            if line.startswith(("path\t", "mod\t", "dep\t"))]}
    except (ValueError, UnicodeError):
        return {"status": "unverified", "reason": "unsupported Go build info"}


def packages(data, alpine=False, installed_only=True):
    records = []
    for block in data.decode("utf-8", "replace").split("\n\n"):
        fields = dict(line.split(":" if alpine else ": ", 1)
                      for line in block.splitlines()
                      if (":" if alpine else ": ") in line and not line.startswith(" "))
        if alpine and "P" in fields:
            records.append({"name": fields["P"], "version": fields.get("V"),
                            "architecture": fields.get("A"),
                            "license_metadata_only": fields.get("L")})
        elif fields.get("Package") and (fields.get("Status") == "install ok installed" or
                                        (not installed_only and fields.get("Version"))):
            records.append({"name": fields.get("Package"), "version": fields.get("Version"),
                            "architecture": fields.get("Architecture")})
    return sorted(records, key=lambda record: record["name"])


def inventory(reference):
    # Explicit projection: full inspect output (in particular Config.Env) is forbidden.
    template = '{"id":{{json .Id}},"repo_digests":{{json .RepoDigests}},"os":{{json .Os}},"architecture":{{json .Architecture}}}'
    identity = json.loads(checked("image", "inspect", "--format", template, reference))
    image_id = identity["id"]  # Pin once; tag changes cannot change subsequent probes.
    output = {"reference": reference, "status": "collected", "identity": identity, "files": [],
              "packages": [], "licenses": [], "runtime_probes": {},
              "runtime_probe_exit_codes": {}, "gaps": []}
    # Distroless has no shell. All other supplied images have /bin/sh.
    server = reference.startswith("whippet-server")
    command = ["--entrypoint", "/bin/false"] if server else ["--entrypoint", "/bin/sh"]
    container = checked("create", "--pull=never", "--network=none", "--read-only",
                        "--cap-drop=ALL", "--security-opt=no-new-privileges", "--log-driver=none",
                        *command, image_id, *([] if server else ["-c", PROBE])).decode().strip()
    try:
        for path in ("/etc/os-release", "/usr/lib/os-release", "/etc/debian_version",
                     "/etc/alpine-release", "/var/lib/dpkg/status",
                     "/lib/apk/db/installed",
                     "/opt/whippet/worker/node_modules/playwright-core/browsers.json",
                     "/opt/whippet/worker/node_modules/playwright-core/package.json",
                     "/usr/local/lib/node_modules/npm/package.json",
                     "/usr/lib/node_modules/npm/package.json"):
            data = read_file(container, path)
            if data is None:
                continue
            entry = {"path": path, "sha256": hashlib.sha256(data).hexdigest()}
            if path.endswith("/status") or path.endswith("/installed"):
                output["packages"].extend(packages(data, path.endswith("/installed")))
            elif path.endswith("package.json"):
                package = json.loads(data)
                entry["metadata_only"] = {k: package[k] for k in ("name", "version", "license") if k in package}
            elif path.endswith("browsers.json"):
                entry["metadata_only"] = json.loads(data)
            else:
                entry["content"] = data.decode("utf-8", "replace").strip()
            output["files"].append(entry)
        binary_path = "/app/whippet-server" if server else "/usr/local/bin/whippet-manager"
        if server or reference.startswith("whippet-manager"):
            data = read_file(container, binary_path)
            output["go_runtime"] = ({"path": binary_path, "sha256": hashlib.sha256(data).hexdigest(),
                                     **go_buildinfo(data)} if data else {"status": "unverified"})
        if server:
            # Inspect packaged copyright and dpkg records without needing a shell.
            for root in ("/usr/share/doc", "/var/lib/dpkg/status.d"):
                result = docker("cp", container + ":" + root, "-")
                if result.returncode:
                    output["gaps"].append(root + " unavailable")
                    continue
                with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
                    for member in archive:
                        if not member.isfile():
                            continue
                        data = archive.extractfile(member).read()
                        relative = member.name.split("/", 1)[-1]
                        if root.endswith("status.d"):
                            if not member.name.endswith(".md5sums"):
                                output["packages"].extend(packages(data, installed_only=False))
                        elif re.search(r"license|notice|copying|copyright", member.name, re.I):
                            output["licenses"].append({"path": root + "/" + relative,
                                                       "sha256": hashlib.sha256(data).hexdigest()})
        else:
            result = docker("start", "--attach", container)
            section = None
            for line in result.stdout.decode("utf-8", "replace").splitlines():
                if line.startswith("@@ "):
                    section = line[3:]
                elif line.startswith("@@exit ") and section:
                    output["runtime_probe_exit_codes"][section] = int(line[7:])
                elif section == "license_sha256":
                    match = re.fullmatch(r"([0-9a-f]{64})\s+(.+)", line)
                    if match:
                        output["licenses"].append({"path": match[2], "sha256": match[1]})
                elif section and line.strip():
                    output["runtime_probes"].setdefault(section, []).append(line)
            if result.returncode:
                output["status"] = "unverified"
                output["gaps"].append("isolated runtime probe failed; file evidence may be partial")
        output["embedded_licenses"] = []
        for path in output["runtime_probes"]:
            if not path.endswith("/firefox/firefox"):
                continue
            archive_path = path.rsplit("/", 1)[0] + "/omni.ja"
            data = read_file(container, archive_path)
            if data is None:
                output["gaps"].append(archive_path + " unavailable or exceeds read limit")
                continue
            try:
                with zipfile.ZipFile(io.BytesIO(data)) as archive:
                    for member in archive.infolist():
                        if re.search(r"(?:^|/)(?:license|notice|copying)[^/]*\.(?:html|xhtml|txt)$", member.filename, re.I):
                            output["embedded_licenses"].append({"archive": archive_path,
                                "archive_sha256": hashlib.sha256(data).hexdigest(),
                                "member": member.filename,
                                "sha256": hashlib.sha256(archive.read(member)).hexdigest()})
            except zipfile.BadZipFile:
                output["gaps"].append(archive_path + " not readable as ZIP")
        output["licenses"].sort(key=lambda entry: entry["path"])
        output["gaps"].append("File hashes and package license metadata do not establish complete image notices or compliance.")
        return output
    finally:
        checked("rm", "--force", "--volumes", container)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("images", nargs="*", help="Local references; defaults to the five QA images")
    args = parser.parse_args()
    report = {"schema_version": 1, "checked_at_utc": datetime.now(timezone.utc).isoformat(),
              "method": "local-image-only; offline disposable read-only containers; no Env inspection",
              "images": []}
    failed = False
    for reference in args.images or DEFAULT_IMAGES:
        try:
            entry = inventory(reference)
            report["images"].append(entry)
            failed |= entry["status"] == "unverified"
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
            failed = True
            report["images"].append({"reference": reference, "status": "unverified",
                                     "reason": type(error).__name__ + "; Docker unavailable or probe failed"})
    json.dump(report, sys.stdout, ensure_ascii=False, indent=2)
    print()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
