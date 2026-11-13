"""Read-only retry6 observation; reuses the validated <=4KiB NOFOLLOW reader."""
import argparse,json,re,time,uuid
from m10_shop_t4t_observe import diagnostic,TERMINAL
import m10_shop_t50_retry6_submit as common
ROOT=common.ROOT
PREFIX=common.PREFIX

def events(run):
 run=str(uuid.UUID(run));registry=common.load(ROOT.parent.parent/'contracts/tools/registry.json')
 names=[t['name'] for t in registry['tools']]
 common.require(names and all(re.fullmatch('[a-z][a-z0-9_]*',n) for n in names))
 model='^author:(model):([1-9]|1[0-2]):(started|succeeded|failed|heartbeat)$'
 observation='^author:observe:([1-8]):(started|fetchInvoked|headersReceived|bodyParsed|responseAccepted|failed|timeoutProviderWait|timeoutBodyWait|cancelled|timeoutToolWait|toolCancelled|timeoutOther|feedbackFrameAccepted|feedbackQueued|feedbackIncludedAtFetch|toolsIncludedAtFetch|functionCallObserved)$'
 tool='^author:(tool):([1-9]|1[0-9]|20):('+'|'.join(names)+'):(started|succeeded|failed|heartbeat)$'
 q=f"""WITH events AS (
 SELECT row_number() OVER (ORDER BY created_at,event_id) AS seq,created_at,
 CASE WHEN kind='log' THEN regexp_match(message,'{model}') END AS model,
 CASE WHEN kind='log' THEN regexp_match(message,'{tool}') END AS tool,
 CASE WHEN kind='log' THEN regexp_match(message,'{observation}') END AS observation
 FROM run_events WHERE run_id='{run}'
 ), safe AS (
 SELECT seq,created_at,CASE WHEN model IS NOT NULL THEN 'model' WHEN tool IS NOT NULL THEN 'tool' ELSE 'observation' END AS event_kind,
 CASE WHEN model IS NOT NULL THEN model[2]::int WHEN tool IS NOT NULL THEN tool[2]::int ELSE observation[1]::int END AS ordinal,
 CASE WHEN tool IS NOT NULL THEN tool[3] END AS tool_name,
 CASE WHEN model IS NOT NULL THEN model[3] WHEN tool IS NOT NULL THEN tool[4] ELSE observation[2] END AS status
 FROM events WHERE model IS NOT NULL OR tool IS NOT NULL OR observation IS NOT NULL)
 SELECT json_build_object('events',COALESCE((SELECT json_agg(row_to_json(s) ORDER BY seq) FROM safe s),'[]'::json),
 'unknownEventCount',(SELECT count(*) FROM events WHERE model IS NULL AND tool IS NULL AND observation IS NULL))"""
 return {'registryVersion':registry['version'],'evidence':common.sql(q)[0],'limitations':['Only fixed producer grammar; unmatched events counted, never returned','Tool succeeded is not self-test passed']}

def worker_image(run,expected):
 ids=common.call(['docker','ps','-aq','--filter','label=whippet.run.id='+str(uuid.UUID(run))]).splitlines()
 seen=[]
 for cid in ids:
  common.require(bool(re.fullmatch('[a-f0-9]{12,64}',cid)))
  image=common.call(['docker','inspect','--format','{{.Image}}',cid])
  common.require(image==expected);seen.append({'containerId':cid,'image':image})
 return {'status':'verified' if seen else 'not_observed_container_may_be_removed','containers':seen}

def observe_once(intent):
 plan=common.get('/tests/'+common.TEST+'/plan?editingSessionId='+common.SESSION)['plan'];common.require(plan['id']==common.PLAN)
 common.require(next(s for s in plan['stages'] if s['id']=='search')['authorRunId']==intent['_retry6RunId'])
 ids=set()
 for stage in plan['stages']:
  for key in ['authorRunId','validationRunId']:
   if stage.get(key):ids.add(str(uuid.UUID(stage[key])))
 if plan.get('validationRunId'):ids.add(str(uuid.UUID(plan['validationRunId'])))
 common.require(ids)
 q="SELECT json_build_object('id',id,'testId',test_id,'editingSessionId',editing_session_id,'kind',kind,'status',status,'slotReleased',slot_released,'attemptId',attempt_id) FROM runs WHERE id IN ("+','.join("'"+i+"'" for i in sorted(ids))+") ORDER BY id"
 rows=common.sql(q);common.require(len(rows)==len(ids));runs=[]
 for row in rows:
  session=common.get('/tests/'+row['testId']+'/editing-sessions/'+row['editingSessionId'])['session']
  entry={'run':row,'session':{k:session[k] for k in ['id','status','pendingRunIds','reclaimPending']},'workerImage':worker_image(row['id'],intent['deployment']['receipt']['images']['worker'])}
  if row['kind']=='author':
   entry['diagnostic']=diagnostic(row['attemptId']);entry['snapshot']=common.snapshot(row['id'])
   common.require(common.valid_snapshot(entry['snapshot'],True));entry['safeEvents']=events(row['id'])
   if row['id']==intent['_retry6RunId']:entry['providedCandidateProof']=common.candidate_proof(row['id'])
   entry['formalValidation']=common.sql("SELECT json_build_object('requestCount',count(*),'unresolvedCount',count(*) FILTER (WHERE NOT resolved),'validationRunIds',COALESCE(json_agg(validation_run_id) FILTER (WHERE validation_run_id IS NOT NULL),'[]'::json)) FROM module_validation_requests WHERE source_run_id='"+str(uuid.UUID(row['id']))+"'")[0]
  runs.append(entry)
 original=intent['sourceSnapshotBefore'];after=common.snapshot(original['runId']);common.require(after==original)
 c=common.counts()
 done=plan['status'] in ('stopped','composed') and all(x['run']['status'] in TERMINAL and x['run']['slotReleased'] is True and x['session']['pendingRunIds']==[] and x['session']['reclaimPending'] is False for x in runs) and all(c[k]==0 for k in ['active','unreclaimed','unresolvedValidation','activePlans'])
 out={'observedAt':common.now(),'plan':common.plan_projection(plan),'runs':runs,'drainCounts':c,'sourceSnapshotAfter':after,'sourcePayloadUnchanged':True,'completeAndReclaimed':done}
 with (ROOT/(PREFIX+'.observations.jsonl')).open('a') as f:f.write(json.dumps(out,ensure_ascii=False)+'\n')
 (ROOT/(PREFIX+'.latest.json')).write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
 if done:
  # Preserve image observations even if Docker removed the Worker at finalization.
  evidence={}
  for line in (ROOT/(PREFIX+'.observations.jsonl')).read_text().splitlines():
   for row in json.loads(line)['runs']:
    for item in row['workerImage']['containers']:evidence[item['containerId']]=item
  out['observedWorkerImages']=list(evidence.values())
  common.save('.final.json',out)
 print(json.dumps({'observedAt':out['observedAt'],'plan':out['plan'],'runs':[{'id':r['run']['id'],'status':r['run']['status'],'slotReleased':r['run']['slotReleased'],'diagnostic':r.get('diagnostic'),'formalValidation':r.get('formalValidation')} for r in runs],'completeAndReclaimed':done},ensure_ascii=False),flush=True)
 return done

def main():
 p=argparse.ArgumentParser();p.add_argument('--observe',action='store_true');p.add_argument('--once',action='store_true');args=p.parse_args()
 if not args.observe:
  print('Offline preview: --observe [--once] requires PM-authorized retry6 intent/outcome; GET/READ ONLY only.');return
 common.require(not (ROOT/(PREFIX+'.final.json')).exists())
 intent=common.load(ROOT/(PREFIX+'.intent.json'));outcome=common.load(ROOT/(PREFIX+'.outcome.json'))
 common.require('plan' in outcome and outcome['plan']['id']==common.PLAN)
 expected=next(x for x in outcome['plan']['stages'] if x['id']=='search')['authorRunId']
 intent['_retry6RunId']=expected
 proof=common.snapshot_proof(intent,expected)
 common.require(proof['sourcePayloadUnchanged'] and proof['newSnapshotValid'] and proof['providedContentPinned'])
 while True:
  if observe_once(intent) or args.once:return
  time.sleep(20)
if __name__=='__main__':
 try:main()
 except Exception:
  print('STOP: safe observation/proof check failed; no mutation or retry performed.',flush=True);raise SystemExit(1)
