#!/usr/bin/env python3
"""One authorized, networkless Docker invocation of the pinned Worker diagnostic producer."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import sys
import time

W=Path('/private/tmp/whippet-m10z-20261115-wave2')
OUT=W/'even'
OUT.mkdir(parents=True,exist_ok=True)
IMAGE='sha256:451c73251d47235e54afa6a9fd2aa968a4b6a8829f6df6ef3a4d0d3f0d49aba6'
LABEL='m10z-20261115-wave2-even-producer'
NAME='whippet-m10z-w2-even-producer'
SHA=re.compile(r'^[a-f0-9]{64}$')
KEYS={'schemaVersion','modelRequestFailureStage','lastSelfTestFailureClass','selfTestPassedCount','selfTestFailedCount','checkpointCreated','checkpointPresentAtFinalize','checkpointRetainedAfterSecretGuard','terminalClass'}

def cmd(args,timeout=30):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=timeout)

def fail(reason):
    result={'schemaVersion':1,'kind':'m10z-w2-even-docker-producer','status':'BLOCKED','reason':reason,'containerStarted':False,'modelCalls':0}
    (OUT/'docker-producer.json').write_text(json.dumps(result,sort_keys=True)+'\n')
    print(json.dumps(result,sort_keys=True))
    return 2

def fixed(value,passed,failed,last):
    return isinstance(value,dict) and set(value)==KEYS and value['schemaVersion']==3 and value['modelRequestFailureStage']=='UNKNOWN' and value['lastSelfTestFailureClass']==last and type(value['selfTestPassedCount']) is int and value['selfTestPassedCount']==passed and type(value['selfTestFailedCount']) is int and value['selfTestFailedCount']==failed and all(value[k] is b for k,b in [('checkpointCreated',passed>0),('checkpointPresentAtFinalize',False),('checkpointRetainedAfterSecretGuard',False)]) and value['terminalClass']=='COMPLETED'

def main():
    gate=json.loads((W/'admission.json').read_text())
    receipt=json.loads((W/'manager-diagnostic.json').read_text())
    package=json.loads((W/'worker-package.json').read_text())
    observation=json.loads((W/'observation-latest.json').read_text())
    offline=json.loads((OUT/'sidecar-probe.json').read_text())
    if gate.get('offlineOnly') is not False or gate.get('dockerProbe') is not True or gate.get('modelRuns') is not False or gate.get('maxWorkers')!=1: return fail('GATE_CLOSED')
    if receipt.get('status')!='PASS' or receipt.get('binaryVerified') is not True or receipt.get('wrapperVerified') is not True or receipt.get('flagEnabledByPinnedWrapper') is not True or receipt.get('configEnvOrTokenRead') is not False: return fail('MANAGER_RECEIPT_INVALID')
    if package.get('status')!='PASS' or package.get('image')!=IMAGE or not isinstance(package.get('dist'),dict): return fail('PACKAGE_PIN_INVALID')
    expected_dist=package['dist'].get('dist/author/module-diagnostics.js')
    if not isinstance(expected_dist,str) or SHA.fullmatch(expected_dist) is None: return fail('DIST_PIN_INVALID')
    if offline.get('kind')!='m10z-w2-even-zero-model' or any(v.get('passed') is not True for v in offline.get('checks',{}).values()) or len(offline.get('checks',{}))!=4: return fail('OFFLINE_PROOF_INVALID')
    counts=observation.get('counts')
    observed=datetime.fromisoformat(observation['observedAt'].replace('Z','+00:00'))
    age=(datetime.now(timezone.utc)-observed).total_seconds()
    if not isinstance(counts,dict) or set(counts)!={'active','occupied','unreclaimed'} or any(type(v) is not int or v!=0 for v in counts.values()) or observation.get('containerCount')!=0 or observation.get('exactManagerLabel')!=gate.get('managerId') or not 0<=age<=30: return fail('CAPACITY_NOT_FRESH_ZERO')
    metadata=cmd(['docker','image','inspect',IMAGE,'--format','{{.Id}}'])
    if metadata.returncode!=0 or metadata.stdout.decode().strip()!=IMAGE: return fail('IMAGE_ID_MISMATCH')

    js="""import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ModuleDiagnostics} from './dist/author/module-diagnostics.js';
const file='dist/author/module-diagnostics.js';
const distSha256=createHash('sha256').update(readFileSync(file)).digest('hex');
function sample(failure){const d=new ModuleDiagnostics();d.selfTestFailure(failure);d.selfTest(false);if(failure==='TEST_FAILED')d.selfTest(true);let output;d.finish('COMPLETED',v=>{output=v});return output;}
const positive=sample('TEST_FAILED');
const negative=sample('TEST_FAILED SECRET_SENTINEL');
process.stdout.write(JSON.stringify({distSha256,positive,negative})+'\\n');
"""
    start=time.monotonic()
    run=cmd(['docker','run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=64','--memory=128m','--cpus=0.25','--name',NAME,'--label','whippet.qa='+LABEL,'--entrypoint','node',IMAGE,'--input-type=module','-e',js],timeout=90)
    duration=round((time.monotonic()-start)*1000)
    output=None
    if run.returncode==0 and len(run.stdout)<=4096:
        try: output=json.loads(run.stdout)
        except (UnicodeDecodeError,ValueError): pass
    shape=isinstance(output,dict) and set(output)=={'distSha256','positive','negative'}
    positive=bool(shape and fixed(output['positive'],1,1,'TEST_FAILED'))
    negative=bool(shape and fixed(output['negative'],0,1,'UNKNOWN'))
    pin=bool(shape and output['distSha256']==expected_dist)
    leaked=bool(b'SECRET_SENTINEL' in run.stdout)
    leftover=cmd(['docker','ps','-a','--filter','label=whippet.qa='+LABEL,'--format','{{.ID}}'])
    reclaimed=leftover.returncode==0 and len(leftover.stdout.strip())==0
    result={'schemaVersion':1,'kind':'m10z-w2-even-docker-producer','status':'PASS' if run.returncode==0 and positive and negative and pin and not leaked and reclaimed else 'FAIL','imageSha256':IMAGE.removeprefix('sha256:'),'distSha256':expected_dist,'checks':{'dockerExit':run.returncode==0,'positive':positive,'negative':negative,'distPin':pin,'noFreeText':not leaked,'reclaimed':reclaimed},'durationMs':duration,'outputBytes':len(run.stdout),'containerStarted':True,'modelCalls':0,'containerCountAfter':0 if reclaimed else 1}
    (OUT/'docker-producer.json').write_text(json.dumps(result,sort_keys=True)+'\n')
    print(json.dumps(result,sort_keys=True))
    return 0 if result['status']=='PASS' else 1

if __name__=='__main__':
    try: sys.exit(main())
    except (OSError,ValueError,KeyError,subprocess.TimeoutExpired): sys.exit(fail('PRECHECK_OR_EXEC_ERROR'))
