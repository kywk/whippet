#!/usr/bin/env python3
"""Fail-closed W2 single-capacity admission, consuming safe metadata only."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys

W = Path('/private/tmp/whippet-m10z-20261115-wave2')
OUT = W/'even'
OLD = Path('/private/tmp/whippet-m10z-20261114')
ROOT = Path(__file__).resolve().parents[2]
OUT.mkdir(parents=True, exist_ok=True)
SHA = re.compile(r'^[a-f0-9]{64}$')

def exact(obj, names):
    return isinstance(obj, dict) and set(obj) == set(names)

def pin(obj):
    return exact(obj, ('expectedSha256','observedSha256')) and all(
        isinstance(obj[k],str) and SHA.fullmatch(obj[k]) for k in obj
    ) and obj['expectedSha256'] == obj['observedSha256']

def file_hash(relative):
    return hashlib.sha256((ROOT/relative).read_bytes()).hexdigest()

def source_hash(relatives):
    h=hashlib.sha256()
    for relative in relatives:
        h.update(relative.encode()+b'\0'+(ROOT/relative).read_bytes()+b'\0')
    return h.hexdigest()

def manifest_matches(files):
    return all(isinstance(path,str) and isinstance(digest,str) and SHA.fullmatch(digest) and file_hash(path)==digest for path,digest in files.items())

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--input',type=Path,required=True)
    args=parser.parse_args()
    if args.input.resolve().parent != OUT.resolve(): raise ValueError('input must be under W/even')
    gate=json.loads((W/'admission.json').read_text())
    datum=json.loads(args.input.read_text())
    offline=json.loads((OUT/'sidecar-probe.json').read_text())
    side=json.loads((OUT/'sidecar-size.json').read_text())
    side_raw=(OUT/'synthetic-sidecar.json').read_bytes()
    producer=json.loads((OUT/'docker-producer.json').read_text())
    package=json.loads((W/'worker-package.json').read_text())
    manager=json.loads((W/'manager-diagnostic.json').read_text())
    old_manager=json.loads((OLD/'manager-live-diag.json').read_text())
    old_worker=json.loads((OLD/'worker-fix3.json').read_text())
    final=json.loads((OLD/'final-source-manifest.json').read_text())
    observed=json.loads((W/'observation-latest.json').read_text())
    worker_files={path:digest for path,digest in old_worker['trackedFiles'].items() if path.startswith('runtimes/worker/')}
    worker_files.update({path:value['sha256'] for path,value in final['files'].items() if path.startswith('runtimes/worker/')})
    worker_files.update(package['sourceFiles'])
    named=('managerCode','workerCode','managerBinary','workerImage','registry','moduleSkill','testSkill')
    valid=exact(datum,('schemaVersion','pins','diagnostics','capacity','observedAt'))
    valid=valid and datum['schemaVersion']==1 and exact(datum['pins'],named)
    valid=valid and exact(datum['diagnostics'],('capabilityEnabled','flagEnabled','positiveSidecar','negativeSidecar','sidecarBytes'))
    valid=valid and exact(datum['capacity'],('active','occupied','unreclaimed','exactLabelContainers'))
    valid=valid and isinstance(datum['observedAt'],str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)',datum['observedAt']) is not None
    age=(datetime.now(timezone.utc)-datetime.fromisoformat(datum['observedAt'].replace('Z','+00:00'))).total_seconds() if valid else float('inf')
    checks={
        'leaderSingleCapacity': gate.get('schemaVersion')==1 and gate.get('offlineOnly') is False and gate.get('dockerProbe') is True and gate.get('modelRuns') is False and gate.get('leader')=='t6g' and gate.get('maxWorkers')==1,
        'safeShape': bool(valid),
        'pins': bool(valid and all(pin(datum['pins'][n]) for n in named)),
        'sourceMatchesPins': bool(valid and datum['pins']['managerCode']['expectedSha256']==source_hash(('services/manager/internal/manager/author.go','services/manager/internal/manager/manager.go','services/manager/internal/manager/docker.go','services/manager/internal/manager/module_diagnostics.go')) and datum['pins']['workerCode']['expectedSha256']==source_hash(('runtimes/worker/src/author/main.ts','runtimes/worker/src/author/loop.ts','runtimes/worker/src/author/module-diagnostics.ts','runtimes/worker/src/author/tools.ts','runtimes/worker/src/author/engine.ts')) and datum['pins']['registry']['expectedSha256']==file_hash('contracts/tools/registry.json') and datum['pins']['moduleSkill']['expectedSha256']==file_hash('runtimes/worker/skills/module-authoring/SKILL.md') and datum['pins']['testSkill']['expectedSha256']==file_hash('runtimes/worker/skills/test-author/SKILL.md')),
        'sourceManifests': manifest_matches(old_manager['sourceFiles']) and manifest_matches(worker_files),
        'runtimePins': bool(valid and manager.get('status')=='PASS' and manager.get('binaryVerified') is True and manager.get('wrapperVerified') is True and manager.get('flagEnabledByPinnedWrapper') is True and manager.get('configEnvOrTokenRead') is False and datum['pins']['managerBinary']['expectedSha256']==manager.get('binarySha256') and datum['pins']['workerImage']['expectedSha256']==package.get('image','').removeprefix('sha256:') and package.get('status')=='PASS' and datum['pins']['registry']['expectedSha256']==package.get('registrySha256')==final.get('registrySha256') and all(datum['pins'][label]['expectedSha256']==package['skills'][path]==final['skillPins'][path] for label,path in [('moduleSkill','runtimes/worker/skills/module-authoring/SKILL.md'),('testSkill','runtimes/worker/skills/test-author/SKILL.md')])),
        'diagnostics': bool(valid and all(datum['diagnostics'][n] is True for n in ('capabilityEnabled','flagEnabled','positiveSidecar','negativeSidecar')) and datum['diagnostics']['flagEnabled']==manager.get('flagEnabledByPinnedWrapper') and side.get('singleGoOverlayPassed') is True and side.get('exactKeys') is True and side.get('within4KiB') is True and side.get('positiveSidecar') is True and side.get('negativeSidecar') is True and type(datum['diagnostics']['sidecarBytes']) is int and datum['diagnostics']['sidecarBytes']==side.get('sidecarBytes')==side.get('sizeBytes')==len(side_raw) and 0<len(side_raw)<=4096 and side.get('sha256')==hashlib.sha256(side_raw).hexdigest()),
        'producerProof': bool(valid and producer.get('status')=='PASS' and producer.get('modelCalls')==0 and producer.get('containerCountAfter')==0 and producer.get('imageSha256')==package.get('image','').removeprefix('sha256:') and producer.get('distSha256')==package['dist'].get('dist/author/module-diagnostics.js') and set(producer.get('checks',{}))=={'dockerExit','positive','negative','distPin','noFreeText','reclaimed'} and all(value is True for value in producer['checks'].values())),
        'offlineProof': offline.get('kind')=='m10z-w2-even-zero-model' and offline.get('modelCalls')==0 and offline.get('dockerStarts')==0 and all(isinstance(v,dict) and v.get('passed') is True for v in offline.get('checks',{}).values()) and set(offline.get('checks',{}))=={'compile','workerFixedEvent','managerSidecarAndGate','cancelReclaim'},
        'drained': bool(valid and all(type(datum['capacity'][n]) is int and datum['capacity'][n]==0 for n in datum['capacity'])),
        'freshCapacity': bool(valid and 0 <= age <= 30),
        'observedCapacity': bool(valid and datum['capacity']=={**observed['counts'],'exactLabelContainers':observed['containerCount']} and datum['observedAt']==observed['observedAt'] and observed.get('exactManagerLabel')==gate.get('managerId')),
    }
    result={'schemaVersion':1,'kind':'m10z-w2-even-admission','admitted':all(checks.values()),'checks':checks}
    (OUT/'admission-check.json').write_text(json.dumps(result,sort_keys=True,indent=2)+'\n')
    print(json.dumps(result,sort_keys=True))
    return 0 if result['admitted'] else 2

if __name__=='__main__':
    try: sys.exit(main())
    except (OSError,ValueError,TypeError,KeyError):
        result={'schemaVersion':1,'kind':'m10z-w2-even-admission','admitted':False,'checks':{'inputValid':False}}
        (OUT/'admission-check.json').write_text(json.dumps(result,sort_keys=True)+'\n')
        print(json.dumps(result,sort_keys=True))
        sys.exit(2)
