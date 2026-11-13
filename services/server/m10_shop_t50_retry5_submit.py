"""Retry5 one-shot entry. Default is offline preview; PM authorization is required."""
import argparse,datetime,hashlib,json,os,re,subprocess,urllib.error,urllib.request,uuid
from pathlib import Path
from m10_shop_t4t_observe import BASE,PLAN,TEST,SESSION,unique
ROOT=Path(__file__).resolve().parent
PREFIX='m10_shop_t50_retry5'
SHARED=Path('/private/tmp/whippet-m10-bounded-release/shared')
RECEIPT=Path('/private/tmp/whippet-m10-shop-environment/bounded-switch.json')
MANAGER_REPAIR=RECEIPT.with_name('bounded-manager-repair.json')
SHARED_HASH='789f704c90680db237b6699a3366ce97a6553bbc0a832dcd69ddfc08aa70610d'
MODULE_HASH='e5a28599fb735e3d70d3157155a160ae0ba8e1e19fe3f050a7cf8d4167c66e3a'
OLD_MODULE_HASH='9da0afe4bd44fcb62f241e941ef7a34bd0e44e4944155f0652502c644adf5b6a'
REGISTRY_HASH='365cf9224caf424ac229872533bce66fa6de6787fa421499537c75052b2a2154'
def require(ok):
 if not ok:raise RuntimeError('safe preflight/proof mismatch; stopped; never resend')
def now():return datetime.datetime.now().astimezone().isoformat()
def load(path):return json.loads(Path(path).read_bytes(),object_pairs_hook=unique)
def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(suffix,data):
 with (ROOT/(PREFIX+suffix)).open('x') as f:
  json.dump(data,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
def call(args):
 r=subprocess.run(args,capture_output=True,text=True)
 require(r.returncode==0)
 return r.stdout.strip()
def sql(query):
 raw=call(['docker','exec','whippet-m10-shop-postgres','psql','-X','-U','whippet','-d','whippet_shop','-At','-v','ON_ERROR_STOP=1','-c','BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; '+query+'; COMMIT;'])
 return [json.loads(line,object_pairs_hook=unique) for line in raw.splitlines() if line.startswith('{')]
def get(path):
 with urllib.request.urlopen(BASE+path,timeout=30) as r:return json.load(r,object_pairs_hook=unique)
def plan_projection(p):
 return {**{k:p[k] for k in ['id','status','revision','validationRunId'] if k in p},'stages':[{k:s[k] for k in ['id','status','authorRunId','validationRunId'] if k in s} for s in p['stages']]}
def counts():
 return sql("SELECT json_build_object('heartbeatAgeSeconds',(SELECT extract(epoch from now()-last_seen_at) FROM managers),'active',(SELECT count(*) FROM runs WHERE status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted')),'unreclaimed',(SELECT count(*) FROM runs WHERE NOT slot_released),'unresolvedValidation',(SELECT count(*) FROM module_validation_requests WHERE NOT resolved),'activePlans',(SELECT count(*) FROM plans WHERE status IN ('confirmed','running')))")[0]
def number_projection(key,low,high):
 # CASE short-circuits before casting; only fixed bounded numbers leave DB.
 return f"CASE WHEN jsonb_typeof(author_payload->'budget'->'{key}')='number' AND author_payload->'budget'->>'{key}' ~ '^[0-9]{{1,16}}$' THEN CASE WHEN (author_payload->'budget'->>'{key}')::numeric BETWEEN {low} AND {high} THEN (author_payload->'budget'->>'{key}')::bigint END END"
def snapshot(run):
 run=str(uuid.UUID(run))
 fields=["'runId',id","'primaryModule',COALESCE(author_payload->>'skillId'='module-authoring' AND author_payload->'skills'->0->>'id'='module-authoring',false)","'version1',COALESCE(author_payload->>'skillVersion'='1' AND author_payload->'skills'->0->>'version'='1',false)","'maxOutputTokensPresent',COALESCE((author_payload->'budget') ? 'maxOutputTokens',false)","'authorPayloadSha256',encode(sha256(convert_to(author_payload::text,'UTF8')),'hex')","'manifestSha256',CASE WHEN author_payload->'skills'->0->>'manifestSha256' ~ '^[a-f0-9]{64}$' THEN author_payload->'skills'->0->>'manifestSha256' END"]
 for key,low,high in [('maxOutputTokens',1,16384),('maxModelRequests',1,9007199254740991),('maxToolCalls',0,9007199254740991),('maxDurationMs',1,9007199254740991)]:fields.append("'"+key+"',"+number_projection(key,low,high))
 rows=sql('SELECT json_build_object('+','.join(fields)+") FROM runs WHERE id='"+run+"'")
 require(len(rows)==1);out=rows[0]
 out['effectiveMaxOutputTokens']=out['maxOutputTokens'] if out['maxOutputTokensPresent'] else 8192
 return out
def valid_snapshot(s,new):
 return s['primaryModule'] is True and s['version1'] is True and all(type(s[k]) is int and s[k]==v for k,v in [('maxModelRequests',8),('maxToolCalls',12),('maxDurationMs',180000),('maxOutputTokens',16384)]) and s['maxOutputTokensPresent'] is True and s['manifestSha256']==(MODULE_HASH if new else OLD_MODULE_HASH) and bool(re.fullmatch('[a-f0-9]{64}',s['authorPayloadSha256']))
def bounded_snapshot(run):
 run=str(uuid.UUID(run))
 return sql("SELECT json_build_object('registryPinned',author_payload->>'toolRegistryVersion'='10.3' AND author_payload->>'toolRegistrySha256'='"+REGISTRY_HASH+"','boundedTools',author_payload->'allowedTools' @> '[\"stage_module_candidate_part\",\"commit_module_candidate\"]'::jsonb AND NOT (author_payload->'allowedTools' ? 'update_module_candidate')) FROM runs WHERE id='"+run+"'")[0]
def verify_shared():
 require(digest(SHARED/'SHA256SUMS')==SHARED_HASH)
 names=[]
 for line in (SHARED/'SHA256SUMS').read_text().splitlines():
  h,name=line.split(None,1);name=name.strip();p=Path(name)
  require(not p.is_absolute() and '..' not in p.parts and digest(SHARED/p)==h);names.append(name)
 require(len(names)==22 and digest(SHARED/'skills/module-authoring/manifest.json')==MODULE_HASH)
 return {'manifestSha256':SHARED_HASH,'filesVerified':len(names),'moduleManifestSha256':MODULE_HASH}
def validate_manager_repair(original,original_hash,repair):
 required={'pending','originalReceiptSha256','oldManagerId','newManagerId','managerImage','settingsPreserved','serverWorkerDatabaseWebUntouched','sharedManifestSHA256','images','unchangedIds'}
 require(type(repair) is dict and set(repair)==required)
 require(repair['pending'] is False and repair['settingsPreserved'] is True and repair['serverWorkerDatabaseWebUntouched'] is True)
 require(repair['originalReceiptSha256']==original_hash and repair['oldManagerId']==original['newIds']['manager'])
 require(repair['sharedManifestSHA256']==SHARED_HASH and original['sharedManifestSHA256']==SHARED_HASH)
 require(type(repair['newManagerId']) is str and re.fullmatch('[a-f0-9]{64}',repair['newManagerId']) is not None and repair['newManagerId']!=repair['oldManagerId'])
 require(type(repair['managerImage']) is str and re.fullmatch('sha256:[a-f0-9]{64}',repair['managerImage']) is not None)
 require(type(repair['images']) is dict and set(repair['images'])=={'server','worker'} and repair['images']=={key:original['images'][key] for key in ['server','worker']})
 ids=repair['unchangedIds'];require(type(ids) is dict and set(ids)=={'server','postgres','web'} and all(type(v) is str and re.fullmatch('[a-f0-9]{64}',v) is not None for v in ids.values()))
 require(ids['server']==original['newIds']['server'])
 return {'id':repair['newManagerId'],'image':repair['managerImage']}
def deployment():
 receipt=load(RECEIPT)
 require(receipt['pending'] is False and receipt['settingsPreserved'] is True and receipt['databaseWebUntouched'] is True and receipt['sharedManifestSHA256']==SHARED_HASH)
 original_hash=digest(RECEIPT);repair=load(MANAGER_REPAIR);manager=validate_manager_repair(receipt,original_hash,repair)
 shared=verify_shared();actual={}
 for role in ['server','manager']:
  values=call(['docker','inspect','--format','{{json .Id}} {{json .Image}} {{json .State.Running}}','whippet-m10-shop-'+role]).split()
  cid,img,running=[json.loads(x) for x in values]
  require(cid==(manager['id'] if role=='manager' else receipt['newIds'][role]) and img==(manager['image'] if role=='manager' else receipt['images'][role]) and running is True)
  # Project only the two known public binds, never Config.Env/full inspect.
  template='{{range .Mounts}}{{if or (eq .Destination "/opt/whippet/worker/skills") (eq .Destination "/app/contracts/tools/registry.json")}}{{json .Source}} {{json .Destination}} {{json .RW}}{{println}}{{end}}{{end}}'
  mounts=[json.loads('['+','.join(line.split())+']') for line in call(['docker','inspect','--format',template,'whippet-m10-shop-'+role]).splitlines() if line.strip()]
  require(sorted(mounts)==sorted([[str(SHARED/'skills'),'/opt/whippet/worker/skills',False],[str(SHARED/'contracts/tools/registry.json'),'/app/contracts/tools/registry.json',False]]))
  actual[role]={'id':cid,'image':img,'running':running,'sharedBindsVerified':True}
 for role in ['postgres','web']:
  cid=call(['docker','inspect','--format','{{.Id}}','whippet-m10-shop-'+role]);require(cid==repair['unchangedIds'][role])
 network=json.loads(call(['docker','inspect','--format','{"aliases":{{json (index .NetworkSettings.Networks "whippet-m10-shop").Aliases}},"ip":{{json (index .NetworkSettings.Networks "whippet-m10-shop").IPAddress}}}','whippet-m10-shop-server']))
 require('whippet-m10-server' in network['aliases'])
 worker=receipt['images']['worker'];require(bool(re.fullmatch('sha256:[a-f0-9]{64}',worker)))
 require(call(['docker','image','inspect','--format','{{.Id}}',worker])==worker)
 return {'receipt':receipt,'receiptSha256':original_hash,'managerRepairReceipt':repair,'managerRepairReceiptSha256':digest(MANAGER_REPAIR),'serverNetwork':network,'actual':actual,'shared':shared,'workerConfiguredImageEvidence':'PM switch receipt; actual Worker image checked during observation'}
def preflight():
 require(not (ROOT/(PREFIX+'.intent.json')).exists() and not (ROOT/(PREFIX+'.outcome.json')).exists())
 prep=load(ROOT/(PREFIX+'.preparation.json'));old=load(ROOT/'m10_shop_t4t_retry4.intent.json');final=load(ROOT/'m10_shop_t4t_retry4.final.json')
 for name,h in prep['historicalSourcesSha256'].items():require(digest(ROOT/name)==h)
 request=prep['requestDraft'];content=old['request']['content']
 require(hashlib.sha256(content.encode()).hexdigest()==prep['originalContentSha256'])
 for replacement in prep['exactReplacements']:
  require(content.count(replacement['old'])==1);content=content.replace(replacement['old'],replacement['new'])
 require(request['content']==content and hashlib.sha256(content.encode()).hexdigest()==prep['newContentSha256'])
 require(request['confirmed'] is True and [request[k] for k in ['planRevision','moduleRevision','moduleContextRevision']]==[12,1,5])
 require(prep['url']==BASE+'/plans/'+PLAN+'/stages/search/retry')
 dep=deployment();c=counts();require(type(c['heartbeatAgeSeconds']) in (float,int) and 0<=c['heartbeatAgeSeconds']<=20 and all(c[k]==0 for k in ['active','unreclaimed','unresolvedValidation','activePlans']))
 w=get('/workspaces/'+old['scope']['id']);scope={k:w[k] for k in old['scope']};require(scope==old['scope'] and [s['url'] for s in w['sites']]==old['targetOrigins'])
 p=get('/tests/'+TEST+'/plan?editingSessionId='+SESSION)['plan'];require(plan_projection(p)==final['plan'])
 retry=get('/plans/'+PLAN+'/stages/search/retry')['retry'];require(retry['eligible'] is True and retry['source']['reclaimed'] is True)
 source=retry['source'];require(source['authorRunId']==prep['sourceRunId'] and source['moduleTestId']==prep['sourceRun']['testId'] and source['editingSessionId']==prep['sourceRun']['editingSessionId'])
 require(retry['planRevision']==request['planRevision'] and source['moduleRevision']==request['moduleRevision'] and source['moduleContextRevision']==request['moduleContextRevision'])
 session=get('/tests/'+source['moduleTestId']+'/editing-sessions/'+source['editingSessionId'])['session'];require(session['pendingRunIds']==[] and session['reclaimPending'] is False)
 before=snapshot(source['authorRunId']);require(valid_snapshot(before,False) and before==prep['sourceSnapshot'])
 return {'createdAt':now(),'url':prep['url'],'request':request,'retryGet':retry,'runCounts':c,'scope':scope,'targetOrigins':old['targetOrigins'],'deployment':dep,'sourceSnapshotBefore':before,'classification':'single PM-authorized retry5; bounded tools/instructions plus M109 observation and abort cleanup; budgets/model unchanged'}
def snapshot_proof(intent,run):
 before=intent['sourceSnapshotBefore'];old=snapshot(before['runId']);new=snapshot(run)
 return {'observedAt':now(),'sourceBefore':before,'sourceAfter':old,'newSnapshot':new,'sourcePayloadUnchanged':old==before,'newSnapshotValid':valid_snapshot(new,True) and bounded_snapshot(run)=={'registryPinned':True,'boundedTools':True}}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def submit(intent):
 save('.intent.json',intent)
 req=urllib.request.Request(intent['url'],data=json.dumps(intent['request']).encode(),headers={'Content-Type':'application/json'},method='POST')
 try:
  # A redirect is an uncertain result, never a second request.
  with urllib.request.build_opener(NoRedirect).open(req,timeout=60) as response:out=json.load(response,object_pairs_hook=unique)
 except Exception:
  save('.outcome.json',{'status':'unknown_or_rejected','intentRetained':True,'automaticResend':False})
  raise RuntimeError('POST outcome uncertain or rejected; inspect safely; NEVER resend') from None
 p=out['plan'];save('.outcome.json',{'plan':plan_projection(p)})
 stage=next(s for s in p['stages'] if s['id']=='search');proof=snapshot_proof(intent,stage['authorRunId']);save('.snapshot-proof.json',proof)
 require(proof['sourcePayloadUnchanged'] and proof['newSnapshotValid'])
 print(json.dumps({'plan':plan_projection(p),'snapshotProof':'PASS','automaticResend':False}))
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--pm-deployment-complete',action='store_true');parser.add_argument('--submit',action='store_true');args=parser.parse_args()
 if not args.submit:
  print(json.dumps({'status':'offline_preview_only','expectedCAS':[12,1,5],'receipt':str(RECEIPT),'requires':'explicit PM deployment-complete and single retry authorization; then --pm-deployment-complete --submit'}));return
 require(args.pm_deployment_complete)
 submit(preflight())
if __name__=='__main__':
 try:main()
 except Exception:
  print('STOP: safe check failed or POST outcome uncertain; retain evidence, never resend.');raise SystemExit(1)
