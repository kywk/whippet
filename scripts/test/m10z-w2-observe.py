#!/usr/bin/env python3
"""Read only, structured metadata from this QA's public schema and exact Docker label."""
import datetime
import json
import pathlib
import subprocess
import time

OUT = pathlib.Path('/private/tmp/whippet-m10z-20261115-wave2')
PG = 'whippet-m10z-20261114-pg'
MANAGER = 'm10z-20261114'

def capture(argv):
    p = subprocess.run(argv,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
    if p.returncode: raise RuntimeError('metadata_unavailable')
    return p.stdout.decode().strip()

def sql(q):
    text = capture(['/usr/local/bin/docker','exec',PG,'psql','-X','-U','postgres','-tAc',q])
    return json.loads(text)

def once():
    runs = sql("""SELECT COALESCE(json_agg(json_build_object(
      'id',id,'testId',test_id,'workspaceId',workspace_id,'sessionId',editing_session_id,
      'kind',kind,'status',status,'attemptId',attempt_id,'slotReleased',slot_released,
      'createdAt',created_at,'startedAt',started_at,'finishedAt',finished_at,
      'scriptOrigin',script_origin,'scriptHash',script_hash,'bundleHash',bundle_hash,
      'skillId',author_payload->'skillId','skillVersion',author_payload->'skillVersion',
      'model',author_payload->'model','budget',author_payload->'budget',
      'registryVersion',author_payload->'toolRegistryVersion',
      'registrySha256',author_payload->'toolRegistrySha256','skills',author_payload->'skills'
      ) ORDER BY queue_seq),'[]'::json) FROM runs""")
    counts = sql("""SELECT json_build_object(
      'active',count(*) FILTER(WHERE status IN('queued','dispatched','running','collecting','cancelling')),
      'occupied',count(*) FILTER(WHERE NOT slot_released),
      'unreclaimed',count(*) FILTER(WHERE attempt_id IS NOT NULL AND NOT slot_released)) FROM runs""")
    rows = capture(['/usr/local/bin/docker','ps','-a','--filter','label=whippet.manager.id='+MANAGER,
                    '--format','{{json .}}'])
    containers = []
    for line in rows.splitlines():
        row = json.loads(line)
        try:
            image = capture(['/usr/local/bin/docker','inspect','--format','{{.Image}}',row['ID']])
            containers.append({'id':row['ID'],'image':image,'state':row['State']})
        except RuntimeError:
            containers.append({'id':row['ID'],'imageStatus':'NOT_OBSERVED','stateAtList':row['State']})
    result = {'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'runs':runs,'counts':counts,'exactManagerLabel':MANAGER,'containers':containers,
        'containerCount':len(containers)}
    (OUT / 'observations.jsonl').open('a').write(json.dumps(result)+'\n')
    (OUT / 'observation-latest.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'runCount':len(runs),'counts':counts,'containerCount':len(containers)}),flush=True)

if __name__ == '__main__':
    import sys
    while True:
        try:
            once()
        except RuntimeError:
            result = {'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'observationStatus':'UNAVAILABLE'}
            (OUT / 'observations.jsonl').open('a').write(json.dumps(result)+'\n')
            (OUT / 'observation-latest.json').write_text(json.dumps(result)+'\n')
            print(json.dumps(result),flush=True)
        if '--watch' not in sys.argv: break
        time.sleep(5)
