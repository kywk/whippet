"""Read-only independent review of the single admitted Docker verifyDraft batch."""
import hashlib
import json
import time
from pathlib import Path

OUT = Path('/private/tmp/whippet-m10z-20261115-wave3/odd')
EXPECTED = {
    'reporter_assertion': ('TEST_FAILED', 'EXPECT', 'UNOBSERVED'),
    'api_step_failure': ('TEST_FAILED', 'PW_API', 'UNOBSERVED'),
    'test_step_failure': ('TEST_FAILED', 'TEST_STEP', 'UNOBSERVED'),
    'no_navigation': ('TEST_FAILED', 'EXPECT', 'NOT_OBSERVED'),
    'navigation': ('TEST_FAILED', 'EXPECT', 'OBSERVED'),
    'unavailable_data': ('UNKNOWN', 'UNOBSERVED', 'UNOBSERVED'),
}
PAYLOAD_KEYS = {'checkpointCreated', 'checkpointPresentAtFinalize', 'checkpointRetainedAfterSecretGuard',
                'lastSelfTestFailedStepCategory', 'lastSelfTestFailureClass', 'lastSelfTestMainFrameNavigation',
                'modelRequestFailureStage', 'schemaVersion', 'selfTestFailedCount', 'selfTestPassedCount', 'terminalClass'}
FAILURES = {'INVALID_SPEC', 'GUARD', 'TIMEOUT', 'CANCELLED', 'TEST_FAILED', 'UNKNOWN'}
STEPS = {'EXPECT', 'PW_API', 'TEST_STEP', 'OTHER', 'UNOBSERVED'}
NAV = {'OBSERVED', 'NOT_OBSERVED', 'UNOBSERVED'}
MODEL = {'UNKNOWN', 'FETCH_REJECTED', 'HTTP_NON_OK', 'BODY_JSON_REJECTED', 'RESPONSE_GUARD_REJECTED',
         'INCOMPLETE_MAX_OUTPUT_TOKENS', 'INCOMPLETE_CONTENT_FILTER', 'INCOMPLETE_UNKNOWN', 'ENVELOPE_INVALID'}
TERMINAL = {'LIMIT', 'INVALID_RESPONSE', 'FINAL_JSON_PARSE', 'FINAL_SHAPE', 'CHECKPOINT_MISSING',
            'CHECKPOINT_REJECTED', 'PROVIDER_FAILED', 'TIMEOUT', 'CANCELLED', 'ARTIFACT_SERIALIZE_LIMIT',
            'ARTIFACT_WRITE_FAILED', 'COMPLETED', 'UNKNOWN'}


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate')
        result[key] = value
    return result


def read(name):
    raw = (OUT / name).read_bytes()
    return json.loads(raw, object_pairs_hook=unique), raw


started = time.monotonic()
selftest, selftest_raw = read('selftest.json')
samples, samples_raw = read('payload-samples.json')
rows = selftest.get('records', [])
payload_rows = samples.get('samples', [])
by_id = {row.get('id'): row for row in rows if isinstance(row, dict)}
by_sample = {row.get('scenarioId'): row.get('payload') for row in payload_rows if isinstance(row, dict)}


def valid_payload(payload):
    if type(payload) is not dict or set(payload) != PAYLOAD_KEYS or payload['schemaVersion'] != 4:
        return False
    if len(json.dumps(payload, separators=(',', ':')).encode()) > 2048:
        return False
    if payload['lastSelfTestFailureClass'] not in FAILURES or payload['lastSelfTestFailedStepCategory'] not in STEPS or payload['lastSelfTestMainFrameNavigation'] not in NAV:
        return False
    if payload['modelRequestFailureStage'] not in MODEL or payload['terminalClass'] not in TERMINAL:
        return False
    if any(type(payload[key]) is not bool for key in ('checkpointCreated', 'checkpointPresentAtFinalize', 'checkpointRetainedAfterSecretGuard')):
        return False
    if any(type(payload[key]) is not int or not 0 <= payload[key] <= 12 for key in ('selfTestPassedCount', 'selfTestFailedCount')):
        return False
    return True


checks = {
    'selftestPass': selftest.get('status') == 'PASS' and selftest.get('scenarioCount') == 6,
    'caseIdsExact': len(rows) == len(by_id) == len(EXPECTED) and set(by_id) == set(EXPECTED),
    'sampleIdsExact': samples.get('schemaVersion') == 1 and len(payload_rows) == len(by_sample) == len(EXPECTED) and set(by_sample) == set(EXPECTED),
    'payloadShapes': all(valid_payload(value) for value in by_sample.values()),
    'secretAbsent': b'SECRET_SENTINEL_W3_ODD' not in selftest_raw + samples_raw,
    'cancelled': selftest.get('cancellation') == {'cancelled': True, 'failureClass': 'CANCELLED', 'observationCount': 1},
}
checks['offOnEquivalent'] = all(by_id[name].get('equivalent') is True and by_id[name]['off'].get('passed') is False and by_id[name]['on'].get('passed') is False and by_id[name]['off'].get('observationCount') == 0 for name in EXPECTED) if checks['caseIdsExact'] else False
checks['expectedObservations'] = all(
    by_id[name].get('expected') is True and by_id[name]['on'].get('observationCount') == 1 and
    by_id[name]['on'].get('observationExact') is True and by_id[name]['on'].get('secretInEmittedFields') is False and
    (by_id[name]['on'].get('failureClass'), by_id[name]['on'].get('failedStepCategory'), by_id[name]['on'].get('mainFrameNavigation')) == expected and
    (by_id[name]['on'].get('diagnosticStepCategory'), by_id[name]['on'].get('diagnosticNavigation')) == expected[1:]
    for name, expected in EXPECTED.items()
) if checks['caseIdsExact'] else False
checks['payloadMatches'] = all(
    (by_sample[name]['lastSelfTestFailureClass'], by_sample[name]['lastSelfTestFailedStepCategory'], by_sample[name]['lastSelfTestMainFrameNavigation']) == expected
    for name, expected in EXPECTED.items()
) if checks['sampleIdsExact'] and checks['payloadShapes'] else False

record = {
    'status': 'PASS' if all(checks.values()) else 'FAIL',
    'checks': checks,
    'caseCount': len(EXPECTED),
    'maxPayloadBytes': max((len(json.dumps(value, separators=(',', ':')).encode()) for value in by_sample.values()), default=0),
    'selftestSha256': hashlib.sha256(selftest_raw).hexdigest(),
    'payloadSamplesSha256': hashlib.sha256(samples_raw).hexdigest(),
    'elapsedMs': round((time.monotonic() - started) * 1000),
}
with (OUT / 'independent-review.json').open('x') as stream:
    json.dump(record, stream, separators=(',', ':'))
    stream.write('\n')
print(json.dumps(record, separators=(',', ':')))
if record['status'] != 'PASS':
    raise SystemExit(1)
