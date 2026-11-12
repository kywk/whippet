#!/usr/bin/env python3
"""PM-only read-only verification; output contains no message bodies or credentials.

Run after m9-history-live.cjs. This joins immutable input absence, exact tool
success events and the final assistant answer; public answer matching alone
is insufficient. Only the selected synthetic conversation is read.
"""
import subprocess,json,pathlib,hashlib,argparse,uuid
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--evidence-dir',required=True)
parser.add_argument('--database-container',default='whippet-m8b-postgres')
args=parser.parse_args()
def valid_id(value):
    if str(uuid.UUID(value)) != value: raise ValueError('Invalid identifier')
    return value
p=pathlib.Path(args.evidence_dir)
c=json.loads((p/'m9-history-checkpoint.json').read_text());rid=valid_id(c['runs']['final']);marker=c['marker']
# Only immutable noncredential input snapshots are read, kept in memory, and reduced to booleans.
def sql(q):
 r=subprocess.run(['docker','exec',args.database_container,'psql','-U','postgres','-Atc',q],capture_output=True,text=True,check=True)
 return r.stdout.strip()
raw=sql("SELECT json_build_object('status',status,'attemptId',attempt_id,'script',script_snapshot,'settings',workspace_settings,'context',workspace_context,'author',author_payload)::text FROM runs WHERE id='"+rid+"'")
r=json.loads(raw);valid_id(r['attemptId']);a=r['author'];inputs=json.dumps({k:r[k] for k in ['script','settings','context','author']},ensure_ascii=False)
events=sql("SELECT message FROM run_events WHERE run_id='"+rid+"' AND attempt_id='"+r['attemptId']+"' AND kind='log' AND message ~ '^author:tool:([1-9]|1[0-2]):read_conversation_history:succeeded$' ORDER BY created_at").splitlines()
conv=valid_id(a['conversationId']);cut=a['history']['maxSequence']
messages=json.loads(sql("SELECT coalesce(json_agg(json_build_object('sequence',sequence::text,'role',role,'content',content,'runId',run_id) ORDER BY sequence),'[]'::json)::text FROM messages WHERE conversation_id='"+conv+"'"))
old=[m for m in messages if marker in m['content'] and m['role']=='user']
answers=[m for m in messages if m['role']=='assistant' and m['runId']==rid]
result={'runId':rid,'attemptId':r['attemptId'],'status':r['status'],'markerHash':hashlib.sha256(marker.encode()).hexdigest(),'markerAbsentFromAllDefaultInputs':marker not in inputs,'markerInOlderHistoryWithinCutoff':len(old)==1 and int(old[0]['sequence'])<=int(cut),'recentMessages':len(a.get('messages',[])),'cutoff':cut,'historySuccessEvents':events,'answerMatch':any(marker in m['content'] for m in answers)}
result['pass']=result['status']=='succeeded' and result['markerAbsentFromAllDefaultInputs'] and result['markerInOlderHistoryWithinCutoff'] and len(events)>=2 and result['answerMatch']
(p/'pm-verification.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))

raise SystemExit(0 if result['pass'] else 1)
