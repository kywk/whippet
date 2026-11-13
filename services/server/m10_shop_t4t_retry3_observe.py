"""Read-only observation of the PM-confirmed Plan; local safe evidence only."""
import datetime,json,os,stat,subprocess,urllib.request,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parent
BASE='http://127.0.0.1:19287/api'
TEST='7bb3430f-3acc-4eb6-ba72-556441acc145'
SESSION='6947dc0f-9417-4b36-b0e9-c57c88f713bc'
PLAN='b7c83de2-5b1f-4531-b526-ba4d65682045'
TERMINAL={'succeeded','failed','cancelled','timed_out','interrupted'}
def get(path):
 with urllib.request.urlopen(BASE+path,timeout=30) as r:return json.load(r)
def unique(pairs):
 d={}
 for k,v in pairs:
  if k in d:raise ValueError('duplicate field')
  d[k]=v
 return d
def decode_diagnostic(raw):
 if len(raw)>4096:raise ValueError('oversize')
 d=json.loads(raw,object_pairs_hook=unique)
 if not (type(d) is dict and set(d)=={'schemaVersion','workerObserved','worker','manager'} and type(d['schemaVersion']) is int and d['schemaVersion'] in (1,2,3) and type(d['workerObserved']) is bool):raise ValueError('invalid diagnostic schema')
 w=d['worker'];m=d['manager']
 if type(w) is not dict or type(m) is not dict:raise ValueError('invalid diagnostic schema')
 wb={'checkpointCreated','checkpointPresentAtFinalize','checkpointRetainedAfterSecretGuard'}
 mb={'workerResultPresent','workerResultValid','authorArtifactPresent','authorParserChecked','authorParserAccepted','uploadAttempted','uploadAccepted'}
 extra={'lastSelfTestFailureClass'} if d['schemaVersion']>=2 else set()
 if d['schemaVersion']==3:extra.add('modelRequestFailureStage')
 if not (set(w)==wb|{'selfTestPassedCount','selfTestFailedCount','terminalClass'}|extra):raise ValueError('invalid diagnostic schema')
 if d['schemaVersion']>=2:
  if not (type(w['lastSelfTestFailureClass']) is str and w['lastSelfTestFailureClass'] in {'INVALID_SPEC','GUARD','TIMEOUT','CANCELLED','TEST_FAILED','UNKNOWN'}):raise ValueError('invalid diagnostic schema')
 if d['schemaVersion']==3:
  if not (type(w['modelRequestFailureStage']) is str and w['modelRequestFailureStage'] in {'UNKNOWN','FETCH_REJECTED','HTTP_NON_OK','BODY_JSON_REJECTED','RESPONSE_GUARD_REJECTED','INCOMPLETE_MAX_OUTPUT_TOKENS','INCOMPLETE_CONTENT_FILTER','INCOMPLETE_UNKNOWN','ENVELOPE_INVALID'}):raise ValueError('invalid diagnostic schema')
 if not (set(m)==mb|{'workerStatus','disposition'}):raise ValueError('invalid diagnostic schema')
 if not (all(type(w[k]) is bool for k in wb) and all(type(m[k]) is bool for k in mb)):raise ValueError('invalid diagnostic schema')
 if not (all(type(w[k]) is int and 0<=w[k]<=12 for k in ['selfTestPassedCount','selfTestFailedCount'])):raise ValueError('invalid diagnostic schema')
 if not (type(w['terminalClass']) is str and w['terminalClass'] in {'LIMIT','INVALID_RESPONSE','FINAL_JSON_PARSE','FINAL_SHAPE','CHECKPOINT_MISSING','CHECKPOINT_REJECTED','PROVIDER_FAILED','TIMEOUT','CANCELLED','ARTIFACT_SERIALIZE_LIMIT','ARTIFACT_WRITE_FAILED','COMPLETED','UNKNOWN'}):raise ValueError('invalid diagnostic schema')
 if not (type(m['workerStatus']) is str and type(m['disposition']) is str and m['workerStatus'] in TERMINAL|{'UNKNOWN'} and m['disposition'] in {'UNKNOWN','RESULT_INVALID','WORKER_FAILED','AUTHOR_REJECTED','ACCEPTED','UPLOAD_FAILED'}):raise ValueError('invalid diagnostic schema')
 return d
def diagnostic(attempt):
 if not attempt:return {'status':'UNKNOWN','reason':'no_attempt'}
 uuid.UUID(attempt)
 fds=[]
 try:
  fd=os.open('/private/tmp',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(fd)
  for part in ['whippet-m10-shop-environment','work','diagnostics']:
   fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);fds.append(fd)
  fd=os.open(attempt+'.json',os.O_RDONLY|os.O_NOFOLLOW,dir_fd=fd);fds.append(fd)
  st=os.fstat(fd)
  if not stat.S_ISREG(st.st_mode) or st.st_size>4096:raise ValueError('invalid size/type')
  raw=os.read(fd,4097)
  d=decode_diagnostic(raw)
  return {'status':'validated','value':d,'lastSelfTestFailureClass':d['worker'].get('lastSelfTestFailureClass','UNKNOWN') if d['workerObserved'] else 'UNKNOWN','modelRequestFailureStage':d['worker'].get('modelRequestFailureStage','UNKNOWN') if d['workerObserved'] else 'UNKNOWN'}
 except FileNotFoundError:return {'status':'UNKNOWN','reason':'missing'}
 except Exception:return {'status':'UNKNOWN','reason':'unsafe_or_invalid'}
 finally:
  for fd in reversed(fds):os.close(fd)
def observe():
 p=get('/tests/'+TEST+'/plan?editingSessionId='+SESSION)['plan'];assert p['id']==PLAN
 ids=set()
 for s in p['stages']:
  for k in ['authorRunId','validationRunId']:
   if s.get(k):ids.add(str(uuid.UUID(s[k])))
 if p.get('validationRunId'):ids.add(str(uuid.UUID(p['validationRunId'])))
 rows=[]
 if ids:
  quoted=','.join("'"+i+"'" for i in sorted(ids))
  sql="BEGIN TRANSACTION READ ONLY; SELECT json_build_object('id',id,'status',status,'slotReleased',slot_released,'cancelRequested',cancel_requested,'attemptId',attempt_id) FROM runs WHERE id IN ("+quoted+"); COMMIT;"
  r=subprocess.run(['docker','exec','whippet-m10-shop-postgres','psql','-X','-U','whippet','-d','whippet_shop','-At','-v','ON_ERROR_STOP=1','-c',sql],capture_output=True,text=True)
  if r.returncode:raise RuntimeError('safe Run projection failed')
  rows=[json.loads(line) for line in r.stdout.splitlines() if line.startswith('{')]
 runs=[]
 for row in rows:
  r=get('/runs/'+row['id'])
  safe={k:v for k,v in r.items() if k in ['id','testId','workspaceId','status','kind','editingSessionId','createdAt','startedAt','finishedAt','reportUrl']}
  e=get('/tests/'+safe['testId']+'/editing-sessions/'+safe['editingSessionId'])['session']
  runs.append({'run':safe,'database':row,'session':{k:e[k] for k in ['id','status','pendingRunIds','reclaimPending']},'diagnostic':diagnostic(row['attemptId'])})
 retries={}
 if p['status']=='stopped':
  for s in p['stages']:
   if s['status']=='failed':retries[s['id']]=get('/plans/'+PLAN+'/stages/'+s['id']+'/retry')
 out={'observedAt':datetime.datetime.now().astimezone().isoformat(),'plan':p,'runs':runs,'retry':retries}
 with (ROOT/'m10_shop_t4t_retry3.observations.jsonl').open('a') as f:f.write(json.dumps(out,ensure_ascii=False)+'\n')
 (ROOT/'m10_shop_t4t_retry3.latest.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'observedAt':out['observedAt'],'planStatus':p['status'],'revision':p['revision'],'stages':[{k:v for k,v in s.items() if k in ['id','status','authorRunId','validationRunId']} for s in p['stages']],'runs':[{'id':x['run']['id'],'status':x['run']['status'],'slotReleased':x['database']['slotReleased'],'diagnostic':x['diagnostic']} for x in runs],'retry':retries},ensure_ascii=False))
if __name__=='__main__':observe()
