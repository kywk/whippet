"""Exact Run, read-only SQL projection. Never returns raw event text or payload."""
import datetime,json,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parent
RUN='7fc9f5b0-c906-4e54-851c-916065bf2745'
registry=json.loads((ROOT.parent.parent/'contracts/tools/registry.json').read_text())
names=[t['name'] for t in registry['tools']]
if not names or not all(re.fullmatch('[a-z][a-z0-9_]*',n) for n in names):raise ValueError('unsafe registry names')
# Exact event producer grammar; unknown tool names/content stay count-only.
pattern='^author:(model):([1-9]|1[0-2]):(started|succeeded|failed|heartbeat)$'
toolpattern='^author:(tool):([1-9]|1[0-9]|20):('+'|'.join(names)+'):(started|succeeded|failed|heartbeat)$'
sql=f"""BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH events AS (
 SELECT row_number() OVER (ORDER BY created_at,event_id) AS seq,
 CASE WHEN kind='log' THEN regexp_match(message,'{pattern}') END AS model,
 CASE WHEN kind='log' THEN regexp_match(message,'{toolpattern}') END AS tool
 FROM run_events WHERE run_id='{RUN}'
), safe AS (
 SELECT seq,CASE WHEN model IS NOT NULL THEN 'model' ELSE 'tool' END AS event_kind,
 CASE WHEN model IS NOT NULL THEN model[2]::int ELSE tool[2]::int END AS ordinal,
 CASE WHEN tool IS NOT NULL THEN tool[3] END AS tool_name,
 CASE WHEN model IS NOT NULL THEN model[3] ELSE tool[4] END AS status
 FROM events WHERE model IS NOT NULL OR tool IS NOT NULL
)
SELECT json_build_object('events',COALESCE((SELECT json_agg(row_to_json(s) ORDER BY seq) FROM safe s),'[]'::json),
 'unknownEventCount',(SELECT count(*) FROM events WHERE model IS NULL AND tool IS NULL),
 'counts',COALESCE((SELECT json_agg(row_to_json(c)) FROM (SELECT event_kind,tool_name,status,count(*) AS count FROM safe GROUP BY event_kind,tool_name,status ORDER BY event_kind,tool_name,status)c),'[]'::json));
SELECT json_build_object(
 'maxModelRequests',CASE WHEN jsonb_typeof(author_payload->'budget'->'maxModelRequests')='number' AND author_payload->'budget'->>'maxModelRequests' ~ '^[0-9]{{1,9}}$' THEN (author_payload->'budget'->>'maxModelRequests')::bigint END,
 'maxToolCalls',CASE WHEN jsonb_typeof(author_payload->'budget'->'maxToolCalls')='number' AND author_payload->'budget'->>'maxToolCalls' ~ '^[0-9]{{1,9}}$' THEN (author_payload->'budget'->>'maxToolCalls')::bigint END,
 'maxDurationMs',CASE WHEN jsonb_typeof(author_payload->'budget'->'maxDurationMs')='number' AND author_payload->'budget'->>'maxDurationMs' ~ '^[0-9]{{1,9}}$' THEN (author_payload->'budget'->>'maxDurationMs')::bigint END)
FROM runs WHERE id='{RUN}';
COMMIT;"""
r=subprocess.run(['docker','exec','whippet-m10-shop-postgres','psql','-X','-U','whippet','-d','whippet_shop','-At','-v','ON_ERROR_STOP=1','-c',sql],capture_output=True,text=True)
if r.returncode:raise RuntimeError('safe projection query failed; no raw output emitted')
rows=[json.loads(l) for l in r.stdout.splitlines() if l.startswith('{')]
if len(rows)!=2:raise RuntimeError('unexpected projection shape')
out={'runId':RUN,'observedAt':datetime.datetime.now().astimezone().isoformat(),'registryVersion':registry['version'],'eventEvidence':rows[0],'budget':rows[1],'fixedErrorCodes':{'availability':'not_present_in_fixed_author_event_grammar','values':[]},'limitations':['Tool succeeded is not self-test passed','Unknown/unmatched events only counted; no content returned','Event sequence is row_number by created_at,event_id, not raw event_id','No model configuration, arguments, messages or raw payload returned']}
with (ROOT/'m10_shop_t4t_retry1.safe-events.json').open('x') as f:json.dump(out,f,ensure_ascii=False,indent=2)
print(json.dumps(out,ensure_ascii=False))
