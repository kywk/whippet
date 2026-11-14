#!/usr/bin/env python3
"""Zero-model Worker v3 -> Manager sidecar contract probe.

Writes only bounded, fixed-shape evidence under W/even. Never starts Docker,
Manager, Server, or a model. An overlay adds a test to the Go package without
editing product files.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
W = Path('/private/tmp/whippet-m10z-20261115-wave2/even')
W.mkdir(parents=True, exist_ok=True)
MANAGER = ROOT / 'services/manager'
WORKER = ROOT / 'runtimes/worker'
SOURCE = WORKER / 'src/author/module-diagnostics.ts'
GO_SOURCE = MANAGER / 'internal/manager/module_diagnostics.go'
GO_DOCKER = MANAGER / 'internal/manager/docker.go'
GO_MANAGER = MANAGER / 'internal/manager/manager.go'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(args, cwd, env=None):
    start = time.monotonic()
    result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=180)
    return {'passed': result.returncode == 0, 'exitCode': result.returncode,
            'durationMs': round((time.monotonic()-start)*1000)}

tsc = WORKER / 'node_modules/.bin/tsc'
compile_result = run([str(tsc), '--target', 'ES2022', '--module', 'NodeNext',
                      '--moduleResolution', 'NodeNext', '--outDir', str(W/'worker-pure'),
                      str(SOURCE)], WORKER)
producer_result = {'passed': False, 'exitCode': -1, 'durationMs': 0}
event_path = W / 'worker-v3-event.json'
if compile_result['passed']:
    producer = W / 'produce-event.mjs'
    producer.write_text('''import {ModuleDiagnostics} from './worker-pure/module-diagnostics.js';
import {writeFileSync} from 'node:fs';
const d=new ModuleDiagnostics();
d.selfTestFailure('TEST_FAILED');d.selfTest(false);d.failure('LIMIT');
let count=0;
d.finish('UNKNOWN',value=>{count++;writeFileSync(process.argv[2],JSON.stringify(value));});
d.finish('COMPLETED',()=>{count++;});
if(count!==1)process.exitCode=1;
''')
    producer_result = run(['node', str(producer), str(event_path)], W)

go_result = {'passed': False, 'exitCode': -1, 'durationMs': 0}
cancel_result = {'passed': False, 'exitCode': -1, 'durationMs': 0}
if producer_result['passed'] and event_path.exists():
    fixture = W / 'synthetic_sidecar_test.go'
    fixture.write_text('''package manager
import("encoding/json";"os";"path/filepath";"strings";"testing")
func exactW2Keys(value map[string]any,want ...string)bool{if len(value)!=len(want){return false};for _,name:=range want{if _,ok:=value[name];!ok{return false}};return true}
func TestM10ZW2SyntheticV3Sidecar(t *testing.T){
 raw,e:=os.ReadFile('''+json.dumps(str(event_path))+''');if e!=nil{t.Fatal(e)}
 value,ok:=decodeM109(raw);if !ok||value.SchemaVersion!=3||value.TerminalClass!="LIMIT"||value.LastSelfTestFailureClass!="TEST_FAILED"||value.SelfTestFailedCount!=1||value.SelfTestPassedCount!=0{t.Fatal("worker v3 rejected or fields lost")}
 d:=newM109Diagnostic();if !d.consume(m109Prefix+string(raw))||!d.WorkerObserved{t.Fatal("worker event not observed")}
 root:=t.TempDir();id:=newID();if e=writeM109(root,id,d);e!=nil{t.Fatal(e)}
 saved,e:=os.ReadFile(filepath.Join(root,"diagnostics",id+".json"));if e!=nil{t.Fatal(e)}
 if len(saved)>4096||strings.Contains(string(saved),"SECRET_SENTINEL"){t.Fatal("unsafe sidecar")}
 var top map[string]any;if e=json.Unmarshal(saved,&top);e!=nil{t.Fatal(e)}
 if !exactW2Keys(top,"schemaVersion","workerObserved","worker","manager")||top["schemaVersion"]!=float64(3)||top["workerObserved"]!=true{t.Fatal("sidecar top-level shape")}
 worker,ok:=top["worker"].(map[string]any);if !ok||!exactW2Keys(worker,"modelRequestFailureStage","lastSelfTestFailureClass","selfTestPassedCount","selfTestFailedCount","checkpointCreated","checkpointPresentAtFinalize","checkpointRetainedAfterSecretGuard","terminalClass"){t.Fatal("sidecar worker shape")}
 manager,ok:=top["manager"].(map[string]any);if !ok||!exactW2Keys(manager,"workerResultPresent","workerResultValid","workerStatus","authorArtifactPresent","authorParserChecked","authorParserAccepted","uploadAttempted","uploadAccepted","disposition"){t.Fatal("sidecar manager shape")}
 if e=os.WriteFile("/private/tmp/whippet-m10z-20261115-wave2/even/synthetic-sidecar.json",saved,0600);e!=nil{t.Fatal(e)}
 if e=writeM109(root,id,d);e==nil{t.Fatal("overwrote sidecar")}
 invalid:=strings.Replace(string(raw),"{","{\\"extra\\":\\"SECRET_SENTINEL\\",",1)
 rejected:=newM109Diagnostic();if !rejected.consume(m109Prefix+invalid)||rejected.WorkerObserved{t.Fatal("unknown field accepted")}
 if _,ok=decodeM109([]byte(strings.Replace(string(raw),"TEST_FAILED","TEST_FAILED SECRET_SENTINEL",1)));ok{t.Fatal("free enum accepted")}
 t.Setenv("WHIPPET_M109_DIAGNOSTICS","0");if m109Enabled(){t.Fatal("off gate")}
 t.Setenv("WHIPPET_M109_DIAGNOSTICS","1");if !m109Enabled(){t.Fatal("on gate")}
 cli:=dockerCLI{cfg:Config{WorkerImage:"fixture"}};args:=strings.Join(cli.createArgs(record{Kind:"author"},"/work")," ")
 if !strings.Contains(args,"WHIPPET_M109_DIAGNOSTICS=1"){t.Fatal("flag not propagated")}
 if strings.Contains(strings.Join(cli.createArgs(record{Kind:"run"},"/work")," "),"WHIPPET_M109"){t.Fatal("flag sent to normal run")}
}
''')
    overlay = W/'go-overlay.json'
    overlay.write_text(json.dumps({'Replace': {str(MANAGER/'internal/manager/m10z_w2_even_synthetic_test.go'): str(fixture)}}))
    go_env = os.environ.copy()
    go_env['GOCACHE'] = str(W/'go-cache')
    go_result = run(['go','test','-overlay',str(overlay),'./internal/manager',
                     '-run','^(TestM10ZW2SyntheticV3Sidecar|TestM109AuthorObservationGateAndWhitelist|TestM109LifecycleDisabledAndWriterFailure)$',
                     '-count=1'], MANAGER, go_env)
    cancel_result = run(['go','test','-overlay',str(overlay),'./internal/manager',
                         '-run','^(TestM2CancelMatchesAttemptAndWaitsForReclamation|TestM2CancelDuringCollectionCannotBeOverwritten|TestM2CancelLostDispatchAndRestartNeverReexecute|TestM2TimeoutCleanupFailureRetainsSlot|TestM3AuthorSharesCapacityCancelAndDedup)$',
                         '-count=1'], MANAGER, go_env)

report = {'schemaVersion':1,'kind':'m10z-w2-even-zero-model',
          'sourceSha256':{'workerDiagnostics':sha(SOURCE),'managerDiagnostics':sha(GO_SOURCE),
                          'managerDocker':sha(GO_DOCKER),'managerMain':sha(GO_MANAGER)},
          'checks':{'compile':compile_result,'workerFixedEvent':producer_result,
                    'managerSidecarAndGate':go_result,'cancelReclaim':cancel_result},
          'eventBytes':event_path.stat().st_size if event_path.exists() else 0,
          'modelCalls':0,'dockerStarts':0,'serviceRestarts':0}
(W/'sidecar-probe.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n')
print(json.dumps(report,sort_keys=True))
sys.exit(0 if all(v['passed'] for v in report['checks'].values()) else 1)
