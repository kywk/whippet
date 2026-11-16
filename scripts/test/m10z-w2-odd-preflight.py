#!/usr/bin/env python3
"""Offline CAS/intent preparation only. This program never opens a socket or sends POST."""

import argparse
import ast
import hashlib
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WAVE = Path('/private/tmp/whippet-m10z-20261115-wave2')
OLD = Path('/private/tmp/whippet-m10z-20261114/odd/final.json')
OUT = WAVE / 'odd'
SHA = re.compile(r'^sha256:[a-f0-9]{64}$')
UUID = re.compile(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')


def load(path):
    return json.loads(path.read_text())


def original_retry_content():
    # Read the previous driver's literal only; never import or execute its API code.
    source = ast.parse((ROOT / 'scripts/test/m10z-odd-driver.py').read_text())
    values = [node.value for node in source.body if isinstance(node, ast.Assign)
              and any(isinstance(name, ast.Name) and name.id == 'RETRY_CONTENT' for name in node.targets)]
    if len(values) != 1:
        raise ValueError('retry_content_missing')
    return ast.literal_eval(values[0])


def canonical_sha(body):
    return hashlib.sha256(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def valid_uuid(value):
    return isinstance(value, str) and UUID.fullmatch(value) is not None


def check_admission(admission, mode):
    return (admission.get('wave') == 'M10Z_W2_20261115'
            and admission.get('leader') == 't6g'
            and admission.get('offlineOnly') is False
            and admission.get('modelRuns') is True
            and admission.get('installManagerDiagnostics') is True
            and admission.get('maxWorkers') == 1
            and admission.get('case3Retry' if mode == 'case3' else 'case7Continue') is True
            and admission.get('budgetMustRemain') == {
                'maxModelRequests': 8, 'maxToolCalls': 12, 'maxDurationMs': 180000})


def expected_source(old, mode):
    case = old['case3'] if mode == 'case3' else old['case7']
    return case['stageRetry']['retryRunId'] if mode == 'case3' else case['fix3ContinueRunId']


def prepare(mode, snapshot, admission, old):
    case = old['case3'] if mode == 'case3' else old['case7']
    source = expected_source(old, mode)
    pin = admission.get('workerImage')
    if not SHA.fullmatch(pin or '') or pin == admission.get('priorWorkerImage'):
        return None, 'BLOCKED_NEW_PIN'
    if not isinstance(snapshot, dict) or snapshot.get('sourceRunId') != source:
        return None, 'BLOCKED_SOURCE_BINDING'
    if (snapshot.get('workerImage') != pin
            or snapshot.get('historicalSidecarStatus') != 'missing'
            or snapshot.get('newRuntimeDiagnosticGate') != 'validated'):
        return None, 'BLOCKED_DIAGNOSTIC_OR_PIN'
    if any(snapshot.get(name) != 0 for name in ('activeRuns', 'unreclaimedRuns', 'unresolvedValidations')):
        return None, 'BLOCKED_CAPACITY'
    if mode == 'case3':
        if (snapshot.get('planId') != case['planner']['planId'] or snapshot.get('stageId') != 's2-query'
                or snapshot.get('planStatus') != 'stopped' or snapshot.get('eligible') is not True
                or snapshot.get('reason') is not None or snapshot.get('reclaimed') is not True):
            return None, 'BLOCKED_RETRY_ELIGIBILITY'
        values = [snapshot.get('planRevision'), snapshot.get('moduleRevision'), snapshot.get('moduleContextRevision')]
        if any(not isinstance(v, int) or isinstance(v, bool) or v < 1 for v in values):
            return None, 'BLOCKED_RETRY_CAS'
        body = {'planRevision': values[0], 'moduleRevision': values[1],
                'moduleContextRevision': values[2], 'confirmed': True,
                'content': original_retry_content()}
        path = f"/api/plans/{snapshot['planId']}/stages/s2-query/retry"
        cas = {'planRevision': values[0], 'moduleRevision': values[1], 'moduleContextRevision': values[2]}
    else:
        if (snapshot.get('status') != 'succeeded' or snapshot.get('partialReason') != 'budget_exhausted'
                or snapshot.get('checkpointPresent') is not False or snapshot.get('slotReleased') is not True
                or snapshot.get('sessionStatus') != 'active' or snapshot.get('pendingRunIds') != []
                or snapshot.get('reclaimPending') is not False):
            return None, 'BLOCKED_CONTINUE_ELIGIBILITY'
        session_id, revision = snapshot.get('editingSessionId'), snapshot.get('revision')
        if (not valid_uuid(session_id) or not isinstance(revision, int) or isinstance(revision, bool)
                or revision < 1 or snapshot.get('draftRevision') != revision):
            return None, 'BLOCKED_CONTINUE_CAS'
        body = {'editingSessionId': session_id, 'revision': revision}
        path = f'/api/runs/{source}/continue'
        cas = {'revision': revision, 'editingSessionId': session_id}
    return {'schemaVersion': 1, 'mode': mode, 'method': 'POST', 'path': path,
            'sourceRunId': source, 'expectedWorkerImage': pin, 'bodySha256': canonical_sha(body),
            'cas': cas, 'postExecuted': False, 'snapshotClass': 'external_safe_projection',
            'historicalSidecarStatus': 'missing', 'newRuntimeDiagnosticGate': 'validated'}, None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('case3', 'case7'))
    parser.add_argument('--snapshot', type=Path, help='Leader-approved, safe read-only projection under W2/odd')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    admission = load(WAVE / 'admission.json')
    old = load(OLD)
    if not check_admission(admission, args.mode):
        status, intent = 'BLOCKED_ADMISSION', None
    elif args.snapshot is None or not args.snapshot.resolve().is_relative_to(OUT.resolve()):
        status, intent = 'BLOCKED_SNAPSHOT_MISSING', None
    else:
        intent, reason = prepare(args.mode, load(args.snapshot), admission, old)
        status = reason or 'READY_FOR_LEADER_REVIEW'
    report = {'schemaVersion': 1, 'mode': args.mode, 'status': status, 'postExecuted': False,
              'sourceRunId': expected_source(old, args.mode),
              'oldTrueRunStatus': 'FAIL', 'oldCommitResult': 'UNKNOWN' if args.mode == 'case3' else None,
              'oldCheckpointPresent': False if args.mode == 'case7' else None}
    (OUT / f'{args.mode}-preflight.json').write_text(json.dumps(report, indent=2) + '\n')
    if intent:
        # Exclusive create: a second invocation cannot silently replace an intent.
        with (OUT / f'{args.mode}-intent.json').open('x') as handle:
            handle.write(json.dumps(intent, indent=2) + '\n')
    print(json.dumps({'mode': args.mode, 'status': status, 'intentCreated': bool(intent)}))
    if not intent:
        raise SystemExit(2)


if __name__ == '__main__':
    main()
