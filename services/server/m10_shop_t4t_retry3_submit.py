"""PM-authorized one-shot retry3; exclusive durable intent prevents resending."""
import datetime,hashlib,json,os,subprocess,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parent
BASE='http://127.0.0.1:19287/api'
def require(ok):
 if not ok:raise RuntimeError('preflight mismatch; stopped without retry')
def get(path):
 with urllib.request.urlopen(BASE+path,timeout=30) as r:return json.load(r)
def save(name,data):
 with (ROOT/name).open('x') as f:
  json.dump(data,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
def main():
 require(not (ROOT/'m10_shop_t4t_retry3.intent.json').exists() and not (ROOT/'m10_shop_t4t_retry3.outcome.json').exists())
 prep=json.loads((ROOT/'m10_shop_t4t_retry3.preparation.json').read_text())
 for name,digest in prep['historicalSourcesSha256'].items():require(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest)
 old=json.loads((ROOT/'m10_shop_t4t_retry2.intent.json').read_text());final=json.loads((ROOT/'m10_shop_t4t_retry2.final.json').read_text())
 receiptPath=Path('/private/tmp/whippet-m10-shop-environment/diag-v3-switch.json');receipt=json.loads(receiptPath.read_text())
 require(receipt['pending'] is False and receipt['managerSettingsPreserved'] is True and receipt['serverDatabaseWebUntouched'] is True)
 result=subprocess.run(['docker','inspect','--format','{{json .Id}} {{json .Image}} {{json .State.Running}}','whippet-m10-shop-manager'],capture_output=True,text=True)
 require(result.returncode==0)
 cid,image,running=[json.loads(v) for v in result.stdout.split()]
 require(cid==receipt['newManagerId'] and image==receipt['images']['manager'] and running is True)
 sql="""BEGIN TRANSACTION READ ONLY; SELECT json_build_object('heartbeatAgeSeconds',(SELECT extract(epoch from now()-last_seen_at) FROM managers),'active',(SELECT count(*) FROM runs WHERE status NOT IN ('succeeded','failed','cancelled','timed_out','interrupted')),'unreclaimed',(SELECT count(*) FROM runs WHERE NOT slot_released),'unresolvedValidation',(SELECT count(*) FROM module_validation_requests WHERE NOT resolved)); COMMIT;"""
 r=subprocess.run(['docker','exec','whippet-m10-shop-postgres','psql','-X','-U','whippet','-d','whippet_shop','-At','-v','ON_ERROR_STOP=1','-c',sql],capture_output=True,text=True)
 require(r.returncode==0);counts=[json.loads(l) for l in r.stdout.splitlines() if l.startswith('{')][0]
 require(type(counts['heartbeatAgeSeconds']) in (int,float) and 0<=counts['heartbeatAgeSeconds']<=20 and all(counts[k]==0 for k in ['active','unreclaimed','unresolvedValidation']))
 scope=get('/workspaces/'+old['scope']['id']);safeScope={k:scope[k] for k in old['scope']};require(safeScope==old['scope'])
 require([s['url'] for s in scope['sites']]==old['targetOrigins'])
 plan=get('/tests/'+final['plan']['testId']+'/plan?editingSessionId='+final['plan']['editingSessionId'])['plan'];require(plan==final['plan'])
 retry=get('/plans/'+prep['planId']+'/stages/search/retry')['retry'];require(retry==final['retry']['search']['retry'])
 require(retry['eligible'] is True and retry['source']['reclaimed'] is True)
 session=get('/tests/'+retry['source']['moduleTestId']+'/editing-sessions/'+retry['source']['editingSessionId'])['session'];require(session['pendingRunIds']==[] and session['reclaimPending'] is False)
 request=prep['requestDraft'];require(request['content']==old['request']['content'] and (request['planRevision'],request['moduleRevision'],request['moduleContextRevision'])==(8,1,3))
 require(prep['url']==BASE+'/plans/'+prep['planId']+'/stages/search/retry')
 intent={'createdAt':datetime.datetime.now().astimezone().isoformat(),'url':prep['url'],'request':request,'retryGet':retry,'runCounts':counts,'scope':safeScope,'targetOrigins':old['targetOrigins'],'deploymentReceipt':receipt,'manager':{'id':cid,'image':image,'running':running},'classification':'retry3 controlled diagnostic-v3 experiment; identical retry2 content; single POST authorized by PM t4s'}
 save('m10_shop_t4t_retry3.intent.json',intent)
 req=urllib.request.Request(prep['url'],data=json.dumps(request).encode(),headers={'Content-Type':'application/json'},method='POST')
 try:
  with urllib.request.urlopen(req,timeout=60) as response:out=json.load(response)
 except Exception:
  print('POST outcome uncertain or rejected; intent retained; DO NOT resend.');return
 save('m10_shop_t4t_retry3.outcome.json',out)
 p=out['plan'];print(json.dumps({'status':p['status'],'revision':p['revision'],'stages':[{k:s[k] for k in ['id','status','authorRunId','validationRunId'] if k in s} for s in p['stages']]}))
if __name__=='__main__':main()
