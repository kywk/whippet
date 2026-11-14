#!/usr/bin/env python3
"""W2 #3 official Stage retry: prepare/observe are read-only; run-once is gated."""

import argparse
import ast
import datetime as dt
import hashlib
import http.cookiejar
import importlib.util
import json
import os
import re
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
WAVE = Path('/private/tmp/whippet-m10z-20261115-wave2')
OLD = Path('/private/tmp/whippet-m10z-20261114')
OUT = WAVE / 'odd'
STATE_PATH = OUT / 'driver-state.json'
ORIGINAL_PATH = OUT / 'driver-state-original.json'
EVENTS_PATH = OUT / 'live-events.jsonl'
INTENT_PATH = OUT / 'case3-retry-intent.json'
PACKAGE_PATH = WAVE / 'worker-package.json'
MANAGER_PATH = WAVE / 'manager-diagnostic.json'
OBSERVATION_PATH = WAVE / 'observation-latest.json'
ADMISSION_PATH = WAVE / 'admission.json'
UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
ORIGINAL_STATE_SHA = 'd0c6772b0f2ce12f0f12f4df9753bde51ead2651178868055434162263592557'
RETRY_CONTENT_SHA = '56c7eac0ade09bd6aeaf428528cb3fdf3cd0acc9eaf806c4b0e61956d513936c'
EXPECTED_SOURCE = 'c70331fd-acfa-47f8-87b3-ac23f52c154f'
STAGE = 's2-query'
TERMINAL = {'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'}


def load(path):
    return json.loads(path.read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def event(name, **fields):
    record = {'event': name, 'at': dt.datetime.now(dt.timezone.utc).isoformat(), **fields}
    with EVENTS_PATH.open('a') as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')


def save_state(state):
    temp = OUT / 'driver-state.next.json'
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    os.replace(temp, STATE_PATH)


def source_state():
    if sha(ORIGINAL_PATH.read_bytes()) != ORIGINAL_STATE_SHA:
        raise RuntimeError('original_state_copy_mismatch')
    state = load(STATE_PATH)
    if (state.get('planId') != '3f2fe522-4809-452e-a607-f8ad4428fd96'
            or state.get('queryRetryRunId') != EXPECTED_SOURCE):
        raise RuntimeError('source_binding_mismatch')
    return state


def retry_content():
    tree = ast.parse((ROOT / 'scripts/test/m10z-odd-driver.py').read_text())
    nodes = [node.value for node in tree.body if isinstance(node, ast.Assign)
             and any(isinstance(target, ast.Name) and target.id == 'RETRY_CONTENT' for target in node.targets)]
    if len(nodes) != 1:
        raise RuntimeError('retry_content_missing')
    content = ast.literal_eval(nodes[0])
    if sha(content.encode()) != RETRY_CONTENT_SHA:
        raise RuntimeError('retry_content_changed')
    return content


def local_gate(admission, package, manager, observation):
    image = package.get('image')
    worker_pin = (isinstance(image, str) and re.fullmatch(r'sha256:[0-9a-f]{64}', image)
                  and package.get('status') == 'PASS' and package.get('noOldDeploymentsChanged') is True
                  and admission.get('workerImage') == image and image != admission.get('priorWorkerImage'))
    manager_ready = (manager.get('status') == 'PASS' and manager.get('running') is True
                     and manager.get('flagEnabledByPinnedWrapper') is True
                     and manager.get('binaryVerified') is True and manager.get('wrapperVerified') is True
                     and manager.get('journalPreserved') is True and manager.get('configEnvOrTokenRead') is False)
    age = None
    try:
        observed = dt.datetime.fromisoformat(observation['observedAt'].replace('Z', '+00:00'))
        age = (dt.datetime.now(dt.timezone.utc) - observed).total_seconds()
    except (KeyError, TypeError, ValueError):
        pass
    counts = observation.get('counts') or {}
    observer_ready = (age is not None and 0 <= age <= 30
                      and observation.get('exactManagerLabel') == admission.get('managerId')
                      and observation.get('containerCount') == 0
                      and all(counts.get(key) == 0 for key in ('active', 'occupied', 'unreclaimed')))
    budget_ready = admission.get('budgetMustRemain') == {
        'maxModelRequests': 8, 'maxToolCalls': 12, 'maxDurationMs': 180000}
    return {'workerPin': bool(worker_pin), 'managerDiagnostic': bool(manager_ready),
            'observerFreshAndEmpty': bool(observer_ready), 'budgetUnchanged': budget_ready,
            'observationAgeSeconds': round(age, 1) if age is not None else None}


def admission_ready(admission):
    return (admission.get('wave') == 'M10Z_W2_20261115' and admission.get('leader') == 't6g'
            and admission.get('offlineOnly') is False and admission.get('modelRuns') is True
            and admission.get('case3Retry') is True and admission.get('installManagerDiagnostics') is True
            and admission.get('maxWorkers') == 1 and admission.get('managerId') == 'm10z-20261114')


def api_client():
    environment = load(OLD / 'environment.json')
    admission = load(ADMISSION_PATH)
    if environment.get('api') != admission.get('api') or environment.get('api') != 'https://127.0.0.1:19889':
        raise RuntimeError('api_binding_mismatch')
    context = ssl.create_default_context(cafile=environment['ca'])
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        urllib.request.HTTPSHandler(context=context))
    return environment['api'].rstrip('/'), opener


def request(base, opener, method, path, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={'Content-Type': 'application/json'})
    try:
        with opener.open(req, timeout=20) as response:
            raw = response.read(8 << 20)
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        return error.code, None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError('transport_unknown') from None


def official_snapshot(base, opener, state):
    plan_path = '/api/tests/' + state['usecaseTestId'] + '/plan?' + urllib.parse.urlencode(
        {'editingSessionId': state['usecaseSessionId']})
    retry_path = '/api/plans/' + state['planId'] + '/stages/' + STAGE + '/retry'
    p_status, p_reply = request(base, opener, 'GET', plan_path)
    r_status, r_reply = request(base, opener, 'GET', retry_path)
    if p_status != 200 or r_status != 200:
        return None, {'planHttp': p_status, 'retryHttp': r_status}
    return {'plan': p_reply.get('plan'), 'retry': r_reply.get('retry')}, {'planHttp': 200, 'retryHttp': 200}


def verify_retry(snapshot, state):
    plan, retry = snapshot['plan'], snapshot['retry']
    if not isinstance(plan, dict) or not isinstance(retry, dict):
        raise RuntimeError('official_snapshot_invalid')
    stages = plan.get('stages')
    if (plan.get('id') != state['planId'] or plan.get('status') != 'stopped'
            or not isinstance(stages, list) or len(stages) != 3
            or retry.get('eligible') is not True or retry.get('reason') is not None
            or retry.get('planRevision') != plan.get('revision')):
        raise RuntimeError('official_retry_not_eligible')
    target = next((item for item in stages if item.get('id') == STAGE), None)
    if target is None or target.get('status') != 'failed' or stages[-1].get('status') != 'pending':
        raise RuntimeError('stage_state_changed')
    source = retry.get('source') or {}
    if (source.get('authorRunId') != EXPECTED_SOURCE or source.get('reclaimed') is not True
            or target.get('authorRunId') != EXPECTED_SOURCE):
        raise RuntimeError('retry_source_changed')
    values = [retry.get('planRevision'), source.get('moduleRevision'), source.get('moduleContextRevision')]
    if any(type(value) is not int or value < 1 for value in values):
        raise RuntimeError('retry_cas_invalid')
    body = {'planRevision': values[0], 'moduleRevision': values[1],
            'moduleContextRevision': values[2], 'confirmed': True, 'content': retry_content()}
    digest = sha(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode())
    return body, digest, {'planRevision': values[0], 'moduleRevision': values[1],
                          'moduleContextRevision': values[2], 'sourceRunId': EXPECTED_SOURCE}


def prepare():
    state = source_state()
    admission, package, manager, observation = map(load, (ADMISSION_PATH, PACKAGE_PATH, MANAGER_PATH, OBSERVATION_PATH))
    gate = local_gate(admission, package, manager, observation)
    base, opener = api_client()
    snapshot, http = official_snapshot(base, opener, state)  # GET only; no login POST.
    official = None
    if snapshot:
        try:
            _, digest, cas = verify_retry(snapshot, state)
            official = {'eligible': True, 'bodySha256': digest, **cas}
        except RuntimeError:
            official = {'eligible': False}
    report = {'schemaVersion': 1, 'mode': 'prepare', 'postExecuted': False,
              'admissionOpen': admission_ready(admission), 'gate': gate, 'http': http,
              'official': official, 'oldSourceSidecar': 'missing',
              'status': 'READY_FOR_LEADER_REVIEW' if admission_ready(admission) and all(
                  gate[key] for key in ('workerPin', 'managerDiagnostic', 'observerFreshAndEmpty', 'budgetUnchanged'))
                  and official and official['eligible'] else 'BLOCKED'}
    (OUT / 'live-prepare.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'file': str(OUT / 'live-prepare.json'), 'status': report['status'],
                      'http': http, 'postExecuted': False}))


def run_once():
    state = source_state()
    if INTENT_PATH.exists() or state.get('w2Case3RetryRunId'):
        raise RuntimeError('w2_retry_already_intended')
    admission, package, manager, observation = map(load, (ADMISSION_PATH, PACKAGE_PATH, MANAGER_PATH, OBSERVATION_PATH))
    gate = local_gate(admission, package, manager, observation)
    if not admission_ready(admission) or not all(gate[key] for key in (
            'workerPin', 'managerDiagnostic', 'observerFreshAndEmpty', 'budgetUnchanged')):
        raise RuntimeError('admission_or_pin_blocked')
    base, opener = api_client()
    auth_status, _ = request(base, opener, 'POST', '/api/dev-login', {})
    if auth_status != 200:
        raise RuntimeError('dev_login_failed')
    snapshot, http = official_snapshot(base, opener, state)
    if not snapshot:
        raise RuntimeError('official_get_failed_' + str(http['retryHttp']))
    body, digest, cas = verify_retry(snapshot, state)
    baseline_ids = sorted({item[key] for item in snapshot['plan']['stages']
                           for key in ('authorRunId', 'validationRunId') if item.get(key)})
    intent = {'schemaVersion': 1, 'method': 'POST', 'path': '/api/plans/' + state['planId']
              + '/stages/' + STAGE + '/retry', 'bodySha256': digest,
              'contentSha256': RETRY_CONTENT_SHA, 'expectedWorkerImage': package['image'],
              'oldSourceSidecar': 'missing', 'newRuntimeDiagnosticGate': 'validated',
              'cas': cas, 'postExecuted': False}
    with INTENT_PATH.open('x') as handle:
        handle.write(json.dumps(intent, ensure_ascii=False, indent=2) + '\n')
    event('case3_post_intent', bodySha256=digest, **cas)
    try:
        status, reply = request(base, opener, 'POST', intent['path'], body)
    except RuntimeError:
        event('case3_transport_unknown')
        raise
    if status != 200 or not isinstance(reply, dict):
        event('case3_http_rejected', httpStatus=status)
        raise RuntimeError('case3_http_rejected')
    plan = reply.get('plan') or {}
    stage = next((item for item in plan.get('stages', []) if item.get('id') == STAGE), {})
    run_id = stage.get('authorRunId')
    if not isinstance(run_id, str) or not UUID.fullmatch(run_id) or run_id == EXPECTED_SOURCE:
        event('case3_response_unexpected', httpStatus=status)
        raise RuntimeError('case3_response_unexpected')
    state['w2Case3RetryRunId'] = run_id
    state['w2Case3PlanRevision'] = plan.get('revision')
    state['w2Case3BaselineRunIds'] = baseline_ids
    save_state(state)
    event('case3_accepted', runId=run_id, planRevision=plan.get('revision'))
    print(json.dumps({'status': 'ACCEPTED', 'runId': run_id, 'planRevision': plan.get('revision')}))


def safe_sidecar(attempt_id):
    if not isinstance(attempt_id, str) or not UUID.fullmatch(attempt_id):
        return {'status': 'missing'}
    spec = importlib.util.spec_from_file_location('fixed_decoder', ROOT / 'services/server/m10_shop_t4t_observe.py')
    decoder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(decoder)
    descriptors = []
    try:
        fd = os.open('/private/tmp', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        descriptors.append(fd)
        for part in ('whippet-m10z-20261114', 'work', 'diagnostics'):
            fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            descriptors.append(fd)
        fd = os.open(attempt_id + '.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
        descriptors.append(fd)
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 4096:
            return {'status': 'unsafe_or_invalid'}
        value = decoder.decode_diagnostic(os.read(fd, 4097))
        if value['schemaVersion'] != 3:
            return {'status': 'wrong_schema'}
        worker = value['worker']
        return {'status': 'validated', 'schemaVersion': 3, 'workerObserved': value['workerObserved'],
                'terminalClass': worker['terminalClass'],
                'lastSelfTestFailureClass': worker['lastSelfTestFailureClass'],
                'selfTestPassedCount': worker['selfTestPassedCount'],
                'selfTestFailedCount': worker['selfTestFailedCount'],
                'checkpointCreated': worker['checkpointCreated'],
                'managerDisposition': value['manager']['disposition']}
    except FileNotFoundError:
        return {'status': 'missing'}
    except (OSError, ValueError, KeyError, TypeError):
        return {'status': 'unsafe_or_invalid'}
    finally:
        for fd in reversed(descriptors):
            os.close(fd)


def observe():
    state = source_state()
    if not state.get('w2Case3RetryRunId'):
        raise RuntimeError('w2_retry_not_started')
    base, opener = api_client()
    auth_status, _ = request(base, opener, 'POST', '/api/dev-login', {})
    if auth_status != 200:
        raise RuntimeError('dev_login_failed')
    plan_path = '/api/tests/' + state['usecaseTestId'] + '/plan?' + urllib.parse.urlencode(
        {'editingSessionId': state['usecaseSessionId']})
    status, reply = request(base, opener, 'GET', plan_path)
    if status != 200 or not isinstance(reply, dict):
        raise RuntimeError('plan_get_failed')
    plan = reply.get('plan') or {}
    if plan.get('id') != state['planId']:
        raise RuntimeError('plan_binding_changed')
    stages = [{key: item.get(key) for key in ('id', 'action', 'status', 'authorRunId', 'validationRunId')}
              for item in plan.get('stages', [])]
    if len(stages) != 3:
        raise RuntimeError('stage_count_changed')
    run_ids = {item[key] for item in stages for key in ('authorRunId', 'validationRunId') if item.get(key)}
    if plan.get('validationRunId'):
        run_ids.add(plan['validationRunId'])
    baseline_ids = set(state.get('w2Case3BaselineRunIds') or [])
    current_ids = run_ids - baseline_ids
    observation = load(OBSERVATION_PATH)
    indexed = {item.get('id'): item for item in observation.get('runs', [])}
    runs = []
    blocked = None
    for run_id in sorted(current_ids):
        run_status, run = request(base, opener, 'GET', '/api/runs/' + run_id)
        if run_status != 200 or not isinstance(run, dict):
            blocked = 'BLOCKED_RUN_GET'
            break
        record = {'id': run_id, 'kind': run.get('kind'), 'status': run.get('status'),
                  'reportReady': bool(run.get('reportUrl'))}
        if run.get('kind') == 'author' and run.get('status') in TERMINAL:
            observed = indexed.get(run_id) or {}
            record['slotReleased'] = observed.get('slotReleased')
            if record['slotReleased'] is not True:
                record['diagnostic'] = {'status': 'pending_reclaim'}
                blocked = 'DIAGNOSTIC_PENDING'
            else:
                record['diagnostic'] = safe_sidecar(observed.get('attemptId'))
                if record['diagnostic']['status'] != 'validated':
                    blocked = 'BLOCKED_DIAGNOSTIC_MISSING'
        runs.append(record)
        if blocked:
            break
    if not blocked and plan.get('status') == 'composed':
        outcome = 'READY_FOR_BUSINESS_REVIEW'
    elif blocked:
        outcome = blocked
    elif plan.get('status') == 'stopped':
        outcome = 'BLOCKED_PLAN_STOPPED'
    else:
        outcome = 'RUNNING'
    report = {'schemaVersion': 1, 'status': outcome, 'planId': plan['id'],
              'planStatus': plan.get('status'), 'planRevision': plan.get('revision'),
              'stages': stages, 'validationRunId': plan.get('validationRunId'), 'runs': runs,
              'postExecutedByObserve': False, 'summaryOrPublishPosted': False}
    (OUT / 'live-observe.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    event('case3_observed', status=outcome, planStatus=plan.get('status'), planRevision=plan.get('revision'))
    print(json.dumps({'status': outcome, 'file': str(OUT / 'live-observe.json')}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--prepare', action='store_true')
    group.add_argument('--run-once', action='store_true')
    group.add_argument('--observe', action='store_true')
    args = parser.parse_args()
    try:
        if args.prepare:
            prepare()
        elif args.run_once:
            run_once()
        else:
            observe()
    except RuntimeError as error:
        reason = str(error)
        if not re.fullmatch(r'[a-z_0-9]+', reason):
            reason = 'safe_failure'
        event('driver_blocked', reason=reason)
        print(json.dumps({'status': 'BLOCKED', 'reason': reason}))
        raise SystemExit(2)


if __name__ == '__main__':
    main()
