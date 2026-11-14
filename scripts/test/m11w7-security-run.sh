#!/bin/sh
# Run only M11 Wave 7 security checks using a disposable Go overlay.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
overlay_dir=$(mktemp -d /private/tmp/whippet-m11w7-security.XXXXXXXX)
trap 'rm -rf -- "$overlay_dir"' EXIT HUP INT TERM
python3 - "$repo_root" "$overlay_dir/overlay.json" <<'PY'
import json
from pathlib import Path
import sys
root = Path(sys.argv[1])
source = root / "scripts" / "test"
target = root / "services" / "server" / "internal"
pairs = {
    target / "server" / "m11w7_security_resolver_test.go": source / "m11w7-security-resolver_test.go",
    target / "server" / "m11w7_security_live_test.go": source / "m11w7-security-live_test.go",
    target / "gateway" / "m11w7_security_gateway_test.go": source / "m11w7-security-gateway_test.go",
}
with open(sys.argv[2], "w", encoding="utf-8") as out:
    json.dump({"Replace": {str(k): str(v) for k, v in pairs.items()}}, out)
PY
cd "$repo_root/services/server"
go test -vet=off -tags integration -overlay "$overlay_dir/overlay.json" -run '^TestM11W7Security' -count=1 ./internal/server ./internal/gateway
