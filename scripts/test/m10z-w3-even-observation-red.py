#!/usr/bin/env python3
"""Record the pre-v4 observation gap without inferring a historical cause."""
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "services/manager/internal/manager/module_diagnostics.go"
W = Path("/private/tmp/whippet-m10z-20261115-wave3/even")
W.mkdir(parents=True, exist_ok=True)
raw = SOURCE.read_bytes()
text = raw.decode("utf-8")
body = text.split("type m109Manager struct {", 1)[1].split("\n}", 1)[0]
field_count = len(re.findall(r'`json:"[^"]+"`', body))
version3 = "SchemaVersion: 3" in text
report = {
    "schemaVersion": 1,
    "kind": "M10Z_W3_EVEN_OBSERVATION_BASELINE",
    "featureStatus": "RED_MISSING_OBSERVATION" if version3 and field_count == 9 else "UNKNOWN",
    "wave2HangRootCause": "UNKNOWN",
    "managerDiagnosticFieldCount": field_count,
    "defaultSidecarV3": version3,
    "sourceSha256": hashlib.sha256(raw).hexdigest(),
    "modelCalls": 0,
    "dockerCalls": 0,
    "dbCalls": 0,
}
(W / "observation-red.json").write_text(json.dumps(report, sort_keys=True, indent=2) + "\n")
print(json.dumps(report, sort_keys=True))
