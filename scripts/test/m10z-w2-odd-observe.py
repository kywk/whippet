#!/usr/bin/env python3
"""Read-only W2 #3 Plan observer. Uses GET and safe local projections only."""

import datetime as dt
import importlib.util
import json
import sys
import urllib.parse
from pathlib import Path


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('w2_odd_live', HERE / 'm10z-w2-odd-live.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def get(base, opener, path):
    status, value = live.request(base, opener, 'GET', path)
    if status != 200 or not isinstance(value, dict):
        raise RuntimeError('get_failed')
    return value


def main():
    state = live.source_state()
    if not state.get('w2Case3RetryRunId'):
        raise RuntimeError('w2_retry_not_started')
    base, opener = live.api_client()
    path = '/api/tests/' + state['usecaseTestId'] + '/plan?' + urllib.parse.urlencode(
        {'editingSessionId': state['usecaseSessionId']})
    plan = get(base, opener, path).get('plan') or {}
    if plan.get('id') != state['planId']:
        raise RuntimeError('plan_binding_changed')
    stages = [{key: stage.get(key) for key in ('id', 'action', 'status', 'authorRunId', 'validationRunId')}
              for stage in plan.get('stages', [])]
    if len(stages) != 3 or not any(stage['authorRunId'] == state['w2Case3RetryRunId'] for stage in stages):
        raise RuntimeError('stage_binding_changed')
    all_ids = {stage[key] for stage in stages for key in ('authorRunId', 'validationRunId') if stage.get(key)}
    if plan.get('validationRunId'):
        all_ids.add(plan['validationRunId'])
    baseline = set(state.get('w2Case3BaselineRunIds') or [])
    new_ids = all_ids - baseline
    observation = live.load(live.OBSERVATION_PATH)
    indexed = {item.get('id'): item for item in observation.get('runs', [])}
    runs = []
    outcome = 'RUNNING'
    for run_id in sorted(new_ids):
        run = get(base, opener, '/api/runs/' + run_id)
        record = {'id': run_id, 'kind': run.get('kind'), 'status': run.get('status'),
                  'reportReady': bool(run.get('reportUrl'))}
        if record['kind'] == 'author' and record['status'] in live.TERMINAL:
            observed = indexed.get(run_id) or {}
            record['slotReleased'] = observed.get('slotReleased')
            if record['slotReleased'] is not True:
                record['diagnostic'] = {'status': 'pending_reclaim'}
                outcome = 'DIAGNOSTIC_PENDING'
            else:
                record['diagnostic'] = live.safe_sidecar(observed.get('attemptId'))
                if record['diagnostic']['status'] != 'validated':
                    outcome = 'BLOCKED_DIAGNOSTIC_MISSING'
        runs.append(record)
        if outcome == 'BLOCKED_DIAGNOSTIC_MISSING':
            break
    if outcome == 'RUNNING':
        if plan.get('status') == 'composed':
            outcome = 'READY_FOR_BUSINESS_REVIEW'
        elif plan.get('status') == 'stopped':
            outcome = 'BLOCKED_PLAN_STOPPED'
    report = {'schemaVersion': 1, 'evidenceClass': 'public_get_and_safe_local_projection',
              'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
              'status': outcome, 'planId': plan['id'], 'planStatus': plan.get('status'),
              'planRevision': plan.get('revision'), 'stages': stages,
              'validationRunId': plan.get('validationRunId'), 'runs': runs,
              'postExecuted': False, 'summaryOrPublishPosted': False}
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    historical = live.OUT / f'live-observe-{stamp}.json'
    live.event('case3_readonly_observe', status=outcome, planStatus=plan.get('status'),
               planRevision=plan.get('revision'), snapshot=historical.name)
    historical.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    (live.OUT / 'live-observe.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'status': outcome, 'file': str(historical), 'postExecuted': False}))
    if outcome.startswith('BLOCKED'):
        raise SystemExit(2)


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        name = str(error)
        live.event('case3_readonly_observe_blocked', reason=name if name.isidentifier() else 'safe_failure')
        print(json.dumps({'status': 'BLOCKED', 'reason': name if name.isidentifier() else 'safe_failure',
                          'postExecuted': False}))
        raise SystemExit(2)
