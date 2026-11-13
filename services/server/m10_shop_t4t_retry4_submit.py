"""Retry4 one-shot entry. Default is offline preview; PM authorization is required."""
import argparse,datetime,hashlib,json,os,re,subprocess,urllib.error,urllib.request,uuid
from pathlib import Path
from m10_shop_t4t_observe import BASE,PLAN,TEST,SESSION,unique
ROOT=Path(__file__).resolve().parent
PREFIX='m10_shop_t4t_retry4'
SHARED=Path('/private/tmp/whippet-m10-output-budget/shared')
RECEIPT=Path('/private/tmp/whippet-m10-shop-environment/output-budget-switch.json')
SHARED_HASH='0ecb3159d717d12985b1d4e48c361360b1f1de44faaaaa7d1be1003c413f21b7'
MODULE_HASH='9da0afe4bd44fcb62f241e941ef7a34bd0e44e4944155f0652502c644adf5b6a'
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
 return s['primaryModule'] is True and s['version1'] is True and all(type(s[k]) is int and s[k]==v for k,v in [('maxModelRequests',8),('maxToolCalls',12),('maxDurationMs',180000)]) and (s['maxOutputTokensPresent'] is True and type(s['maxOutputTokens']) is int and s['maxOutputTokens']==16384 and s['manifestSha256']==MODULE_HASH if new else s['maxOutputTokensPresent'] is False and s['effectiveMaxOutputTokens']==8192) and bool(re.fullmatch('[a-f0-9]{64}',s['authorPayloadSha256']))
def verify_shared():
 require(digest(SHARED/'SHA256SUMS')==SHARED_HASH)
 names=[]
 for line in (SHARED/'SHA256SUMS').read_text().splitlines():
  h,name=line.split(None,1);name=name.strip();p=Path(name)
  require(not p.is_absolute() and '..' not in p.parts and digest(SHARED/p)==h);names.append(name)
 require(len(names)==22 and digest(SHARED/'skills/module-authoring/manifest.json')==MODULE_HASH)
 return {'manifestSha256':SHARED_HASH,'filesVerified':len(names),'moduleManifestSha256':MODULE_HASH}
def deployment():
 receipt=load(RECEIPT)
 require(receipt['pending'] is False and receipt['settingsPreserved'] is True and receipt['databaseWebUntouched'] is True and receipt['sharedManifestSHA256']==SHARED_HASH)
 shared=verify_shared();actual={}
 for role in ['server','manager']:
  values=call(['docker','inspect','--format','{{json .Id}} {{json .Image}} {{json .State.Running}}','whippet-m10-shop-'+role]).split()
  cid,img,running=[json.loads(x) for x in values]
  require(cid==receipt['newIds'][role] and img==receipt['images'][role] and running is True)
  # Project only the two known public binds, never Config.Env/full inspect.
  template='{{range .Mounts}}{{if or (eq .Destination "/opt/whippet/worker/skills") (eq .Destination "/app/contracts/tools/registry.json")}}{{json .Source}} {{json .Destination}} {{json .RW}}{{println}}{{end}}{{end}}'
  mounts=[json.loads('['+','.join(line.split())+']') for line in call(['docker','inspect','--format',template,'whippet-m10-shop-'+role]).splitlines() if line.strip()]
  require(sorted(mounts)==sorted([[str(SHARED/'skills'),'/opt/whippet/worker/skills',False],[str(SHARED/'contracts/tools/registry.json'),'/app/contracts/tools/registry.json',False]]))
  actual[role]={'id':cid,'image':img,'running':running,'sharedBindsVerified':True}
 repairPath=RECEIPT.with_name('output-budget-network-repair.json');repair=load(repairPath)
 require(repair['pending'] is False and repair['containerAndIPPreserved'] is True and repair['containerId']==receipt['newIds']['server'] and repair['network']=='whippet-m10-shop' and repair['alias']=='whippet-m10-server')
 network=json.loads(call(['docker','inspect','--format','{"aliases":{{json (index .NetworkSettings.Networks "whippet-m10-shop").Aliases}},"ip":{{json (index .NetworkSettings.Networks "whippet-m10-shop").IPAddress}}}','whippet-m10-shop-server']))
 require('whippet-m10-server' in network['aliases'])
 worker=receipt['images']['worker'];require(bool(re.fullmatch('sha256:[a-f0-9]{64}',worker)))
 require(call(['docker','image','inspect','--format','{{.Id}}',worker])==worker)
 return {'receipt':receipt,'receiptSha256':digest(RECEIPT),'networkRepairReceipt':repair,'networkRepairReceiptSha256':digest(repairPath),'serverNetwork':network,'actual':actual,'shared':shared,'workerConfiguredImageEvidence':'PM switch receipt; actual Worker image checked during observation'}
def preflight():
 require(not (ROOT/(PREFIX+'.intent.json')).exists() and not (ROOT/(PREFIX+'.outcome.json')).exists())
 prep=load(ROOT/(PREFIX+'.preparation.json'));old=load(ROOT/'m10_shop_t4t_retry3.intent.json');final=load(ROOT/'m10_shop_t4t_retry3.final.json')
 for name,h in prep['historicalSourcesSha256'].items():require(digest(ROOT/name)==h)
 request=prep['requestDraft'];require(request['content']==old['request']['content'] and request['confirmed'] is True and [request[k] for k in ['planRevision','moduleRevision','moduleContextRevision']]==[10,1,4])
 require(prep['url']==BASE+'/plans/'+PLAN+'/stages/search/retry')
 dep=deployment();c=counts();require(type(c['heartbeatAgeSeconds']) in (float,int) and 0<=c['heartbeatAgeSeconds']<=20 and all(c[k]==0 for k in ['active','unreclaimed','unresolvedValidation','activePlans']))
 w=get('/workspaces/'+old['scope']['id']);scope={k:w[k] for k in old['scope']};require(scope==old['scope'] and [s['url'] for s in w['sites']]==old['targetOrigins'])
 p=get('/tests/'+TEST+'/plan?editingSessionId='+SESSION)['plan'];require(p==final['plan'])
 retry=get('/plans/'+PLAN+'/stages/search/retry')['retry'];require(retry==final['retry']['search']['retry'] and retry['eligible'] is True and retry['source']['reclaimed'] is True)
 source=retry['source'];s=get('/tests/'+source['moduleTestId']+'/editing-sessions/'+source['editingSessionId'])['session'];require(s['pendingRunIds']==[] and s['reclaimPending'] is False)
 before=snapshot(source['authorRunId']);require(valid_snapshot(before,False))
 return {'createdAt':now(),'url':prep['url'],'request':request,'retryGet':retry,'runCounts':c,'scope':scope,'targetOrigins':old['targetOrigins'],'deployment':dep,'sourceSnapshotBefore':before,'classification':'single PM-authorized retry4; only Module maxOutputTokens increased; identical retry3 content'}
def snapshot_proof(intent,run):
 before=intent['sourceSnapshotBefore'];old=snapshot(before['runId']);new=snapshot(run)
 return {'observedAt':now(),'sourceBefore':before,'sourceAfter':old,'newSnapshot':new,'sourcePayloadUnchanged':old==before,'newSnapshotValid':valid_snapshot(new,True)}
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
  print(json.dumps({'status':'offline_preview_only','expectedCAS':[10,1,4],'receipt':str(RECEIPT),'requires':'explicit PM deployment-complete and single retry authorization; then --pm-deployment-complete --submit'}));return
 require(args.pm_deployment_complete)
 submit(preflight())
if __name__=='__main__':
 try:main()
 except Exception:
  print('STOP: safe check failed or POST outcome uncertain; retain evidence, never resend.');raise SystemExit(1)
