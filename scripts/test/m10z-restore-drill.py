#!/usr/bin/env python3
"""Private, isolated restore acceptance; never prints configuration values."""
from pathlib import Path
import os,json,tarfile,subprocess,hashlib,time,ssl,urllib.request,http.cookiejar,argparse,re,socket
os.umask(0o077)
parser=argparse.ArgumentParser(description="Restore a private M10.Z backup into a new named volume, then verify two isolated Server boots. No Manager or model is started.")
parser.add_argument('--backup',type=Path,required=True)
parser.add_argument('--destination',type=Path,required=True)
parser.add_argument('--postgres-name',required=True)
parser.add_argument('--api-port',type=int,required=True)
parser.add_argument('--workspace-id',required=True)
parser.add_argument('--run-id',required=True)
parser.add_argument('--output',type=Path,required=True)
args=parser.parse_args()
if args.output.exists():parser.error('Output receipt must not exist')
args.output.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
if not re.fullmatch(r'whippet-[a-z0-9-]+',args.postgres_name) or not 20000<=args.api_port<=29999:parser.error('Use a new whippet-* container name and a port in 20000..29999')
for id in [args.workspace_id,args.run_id]:
 if not re.fullmatch(r'[a-f0-9-]{36}',id):parser.error('Invalid evidence ID')
backup=args.backup;dest=args.destination
for kind,name in [('container',args.postgres_name),('volume',args.postgres_name+'data')]:
 if subprocess.run(['docker',kind,'inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:parser.error('Restore container and volume must not exist')
with socket.socket() as probe:probe.bind(('127.0.0.1',args.api_port))
dest.mkdir(mode=0o700,exist_ok=False)
manifest=json.loads((backup/'manifest.json').read_text())
for filename in ['state.tar.gz','database.dump','postgres-image.tar.gz']:
 h=hashlib.sha256()
 with (backup/filename).open('rb') as f:
  while chunk:=f.read(1<<20):h.update(chunk)
 assert h.hexdigest()==manifest['files'][filename]['sha256'], 'backup_hash_mismatch'
with tarfile.open(backup/'postgres-image.tar.gz') as t:
 if 'index.json' in t.getnames():postgres_image=json.load(t.extractfile('index.json'))['manifests'][0]['digest']
 else:
  item=json.load(t.extractfile('manifest.json'))[0];postgres_image='sha256:'+hashlib.sha256(t.extractfile(item['Config']).read()).hexdigest()
subprocess.run(['docker','image','inspect',postgres_image],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
with tarfile.open(backup/'state.tar.gz') as t:t.extractall(dest,filter='data')
root=dest/Path(manifest['stateDir']).name;pg=args.postgres_name;volume=pg+'data'
subprocess.run(['docker','volume','create',volume],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['docker','run','-d','--name',pg,'-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432','--mount',f'type=volume,source={volume},target=/var/lib/postgresql/data',postgres_image],check=True,stdout=subprocess.DEVNULL)
for i in range(50):
 if subprocess.run(['docker','exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
 time.sleep(.2)
with (backup/'database.dump').open('rb') as f:subprocess.run(['docker','exec','-i',pg,'pg_restore','-U','postgres','-d','postgres','--exit-on-error'],stdin=f,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
port=subprocess.check_output(['docker','port',pg,'5432']).decode().strip().split(':')[-1]
def query(q):return subprocess.check_output(['docker','exec',pg,'psql','-X','-q','-U','postgres','-tAc',q]).decode().strip()
count=int(query('SELECT count(*) FROM runs;'));assert count==manifest['runCount']
assert query("SELECT count(*) FROM runs WHERE id='"+args.run_id+"';")=='1'
identities=all(hashlib.sha256((root/k).read_bytes()).hexdigest()==v for k,v in manifest['sourcePins'].items());assert identities
state=json.loads((root/'state.json').read_text());assert hashlib.sha256((root/'server.bin').read_bytes()).hexdigest()==state['serverSha256']
env={'PATH':os.environ['PATH'],'HOME':str(Path.home()),'DATABASE_URL':f'postgres://postgres@127.0.0.1:{port}/postgres?sslmode=disable','MANAGER_TOKEN':(root/'manager-token').read_text().strip(),'WHIPPET_SECRET_MASTER_KEY':(root/'vault-key').read_text().strip(),'TLS_CERT_FILE':str(root/'qa.crt'),'TLS_KEY_FILE':str(root/'qa.key'),'ARTIFACT_DIR':str(root/'artifacts'),'WHIPPET_TOOL_REGISTRY_PATH':str(root/'registry.json'),'WHIPPET_SKILLS_PATH':str(root/'skills'),'WHIPPET_BIND_HOST':'127.0.0.1','PORT':str(args.api_port),'WHIPPET_PUBLIC_ORIGIN':'http://127.0.0.1:'+str(args.api_port+1)}
cycles=[]
for cycle in range(2):
 p=subprocess.Popen([str(root/'server.bin')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  jar=http.cookiejar.CookieJar();o=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar),urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(root/'qa.crt'))))
  def call(method,path,data=None):
   r=urllib.request.Request('https://127.0.0.1:'+str(args.api_port)+path,data=None if data is None else json.dumps(data).encode(),method=method,headers={'Content-Type':'application/json','Origin':'http://127.0.0.1:'+str(args.api_port+1)})
   with o.open(r,timeout=3) as resp:return json.loads(resp.read())
  for i in range(60):
   try:call('GET','/readyz');break
   except Exception:time.sleep(.1)
  call('POST','/api/dev-login',{})
  w=call('GET','/api/workspaces/'+args.workspace_id);assert w['id']==args.workspace_id
  run=call('GET','/api/runs/'+args.run_id);assert run['status']=='succeeded' and run.get('reportUrl')
  artifact=call('GET','/api/runs/'+args.run_id+'/artifacts/results.json');assert artifact['stats']['expected']==1 and artifact['stats']['unexpected']==0
  cycles.append({'ready':True,'workspaceIdPreserved':True,'publishedRunAndArtifactPreserved':True})
 finally:p.terminate();p.wait(timeout=10)
result={'verdict':'PASS','blankNamedVolume':volume,'restoredRuns':count,'identityHashesMatch':identities,'serverRestarts':cycles,'modelRuns':0,'originalEnvironmentUntouched':True,'restoreDirectory':str(dest)}
args.output.write_text(json.dumps(result,indent=2));print(json.dumps(result))
