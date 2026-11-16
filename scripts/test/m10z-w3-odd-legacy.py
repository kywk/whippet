"""Pure v1-v3 diagnostic decoder probe; no service, DB, or browser access."""
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = Path('/private/tmp/whippet-m10z-20261115-wave3/odd/legacy.json')
SOURCE = ROOT / 'services/server/m10_shop_t4t_observe.py'
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('m10z_w3_odd_decoder', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

worker = dict(selfTestPassedCount=0, selfTestFailedCount=1,
              checkpointCreated=False, checkpointPresentAtFinalize=False,
              checkpointRetainedAfterSecretGuard=False, terminalClass='UNKNOWN')
manager = dict(workerResultPresent=True, workerResultValid=True,
               authorArtifactPresent=False, authorParserChecked=False,
               authorParserAccepted=False, uploadAttempted=False,
               uploadAccepted=False, workerStatus='failed', disposition='WORKER_FAILED')


def payload(version):
    value = dict(worker)
    if version >= 2:
        value['lastSelfTestFailureClass'] = 'TEST_FAILED'
    if version >= 3:
        value['modelRequestFailureStage'] = 'UNKNOWN'
    return dict(schemaVersion=version, workerObserved=True, worker=value, manager=manager)


def accepted(value):
    try:
        module.decode_diagnostic(json.dumps(value, separators=(',', ':')).encode())
        return True
    except ValueError:
        return False


started = time.monotonic()
legacy = {str(version): accepted(payload(version)) for version in (1, 2, 3)}
unknown = payload(3)
unknown['worker']['lastSelfTestFailureClass'] = 'SECRET_SENTINEL_W3_ODD'
mixed = payload(2)
mixed['worker']['modelRequestFailureStage'] = 'UNKNOWN'
null_value = payload(3)
null_value['worker']['lastSelfTestFailureClass'] = None
extra = payload(3)
extra['worker']['unrecognized'] = True
duplicate = json.dumps(payload(3), separators=(',', ':')).replace('"schemaVersion":3,', '"schemaVersion":3,"schemaVersion":3,', 1).encode()
try:
    module.decode_diagnostic(duplicate)
    duplicate_rejected = False
except ValueError:
    duplicate_rejected = True
checks = dict(legacyV1=legacy['1'], legacyV2=legacy['2'], legacyV3=legacy['3'],
              unknownEnumRejected=not accepted(unknown), mixedVersionRejected=not accepted(mixed),
              nullRejected=not accepted(null_value), unknownFieldRejected=not accepted(extra),
              duplicateRejected=duplicate_rejected)
record = dict(status='PASS' if all(checks.values()) else 'FAIL', checks=checks,
              count=len(checks), elapsedMs=round((time.monotonic() - started) * 1000))
assert 'SECRET_SENTINEL_W3_ODD' not in json.dumps(record)
with OUT.open('x') as stream:
    json.dump(record, stream, separators=(',', ':'))
    stream.write('\n')
print(json.dumps(record, separators=(',', ':')))
if record['status'] != 'PASS':
    raise SystemExit(1)
