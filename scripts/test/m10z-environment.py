#!/usr/bin/env python3
"""M10.Z owned environment only; never inspect environment, keys or free logs."""
import hashlib
import json
import pathlib
import secrets
import socket
import subprocess
import time
import urllib.request
import os
import shutil
import ssl
import base64
import threading
import uuid
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

REPO = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path('/private/tmp/whippet-m10z-20261114')
PREFIX = 'whippet-m10z-20261114'

def command(args, cwd=REPO):
    if args[0] == 'docker': args = ['/usr/local/bin/docker',*args[1:]]
    p = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode:
        text = (p.stdout+p.stderr).decode(errors='replace').lower()
        write('last-command-failure.json',{'program':args[0],'exit':p.returncode,
            'signals':{k:k in text for k in ['pull access denied','not found','invalid reference',
                'failed to resolve','network is unreachable','permission denied','dockerfile','checksum']}})
        raise RuntimeError('command_failed:' + args[0])
    return p.stdout

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(name, value):
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / name
    p.write_text(json.dumps(value, indent=2, sort_keys=True) + '\n')

def inventory():
    tracked = command(['git', 'ls-files', '-z']).decode().split('\0')
    files = {f: digest(REPO / f) for f in tracked if f and (REPO / f).is_file()}
    head = command(['git', 'rev-parse', 'HEAD']).decode().strip()
    branch = command(['git', 'branch', '--show-current']).decode().strip()
    remote = command(['git', 'ls-remote', 'origin', 'refs/heads/feat/mcp']).decode().split()[0]
    containers = []
    names = ['whippet-m10-shop-server', 'whippet-m10-shop-manager', 'whippet-m10-shop-web']
    for name in names:
        data = json.loads(command(['docker', 'inspect', '--format',
            '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}}}', name]))
        data['name'] = name
        containers.append(data)
    ports = {}
    for port in [19287, 19587, 19787, 19887, 19889, 19891]:
        with socket.socket() as s:
            s.settimeout(1)
            ports[str(port)] = s.connect_ex(('127.0.0.1', port)) == 0
    registry = REPO / 'contracts/tools/registry.json'
    skills = {str(p.relative_to(REPO)): digest(p) for p in
              sorted((REPO / 'runtimes/worker/skills').rglob('*')) if p.is_file()}
    write('source-manifest.json', {'head': head, 'branch': branch, 'remoteHead': remote,
        'dirtyPaths': command(['git', 'status', '--porcelain']).decode().splitlines(),
        'trackedFiles': files, 'registrySha256': digest(registry), 'skills': skills,
        'historicalContainers': containers, 'listeningPorts': ports,
        'leader': {'herdrTerminal': 't6g', 'parent': None,
                   'noDaemon': 'NOT_VERIFIED', 'effectiveModel': 'NOT_VERIFIED',
                   'toolTransport': 'app-server-daemon'}})
    print(json.dumps({'inventory': 'PASS', 'head': head, 'remoteMatches': head == remote,
                      'protectedPorts': {k: ports[k] for k in ['19287','19587','19787']}}))

def start_pg():
    # Refuse duplicate side effects; the evidence directory is not a reset signal.
    if (OUT / 'postgres.json').exists():
        raise RuntimeError('postgres_receipt_exists')
    name = PREFIX + '-pg'
    command(['docker', 'run', '-d', '--name', name, '--label', 'whippet.qa=m10z-20261114',
        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1::5432', 'postgres:16'])
    ready = False
    for _ in range(80):
        p = subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],
                           stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if p.returncode == 0:
            ready = True
            break
        time.sleep(.25)
    binding = json.loads(command(['docker','inspect','--format',
                                 '{{json .NetworkSettings.Ports}}',name]))
    port = int(binding['5432/tcp'][0]['HostPort'])
    write('postgres.json', {'name': name, 'port': port, 'ready': ready,
        'dsn': f'postgres://postgres@127.0.0.1:{port}/postgres?sslmode=disable',
        'image': command(['docker','inspect','--format','{{.Image}}',name]).decode().strip()})
    print(json.dumps({'postgres': 'PASS' if ready else 'FAIL', 'port': port, 'name': name}))

def images():
    context = OUT / 'images'
    if not context.exists():
        context.mkdir()
        shutil.copytree(REPO / 'runtimes/worker/dist', context / 'dist')
        shutil.copytree(REPO / 'runtimes/worker/skills', context / 'skills')
        shutil.copyfile(REPO / 'contracts/tools/registry.json', context / 'registry.json')
        shutil.copyfile(OUT / 'odd/build/whippet-manager-linux-arm64', context / 'manager')
    base = command(['docker','image','inspect','--format','{{.Id}}','whippet-worker:m11-final']).decode().strip()
    lock = command(['docker','run','--rm','--network','none','--entrypoint','sha256sum',base,
                    '/opt/whippet/worker/package-lock.json']).decode().split()[0]
    if lock != digest(REPO / 'runtimes/worker/package-lock.json'):
        raise RuntimeError('dependency_lock_mismatch')
    (context / 'Worker.Dockerfile').write_text('FROM whippet-worker:m11-final\nCOPY dist/ /opt/whippet/worker/dist/\nCOPY skills/ /opt/whippet/worker/skills/\nCOPY registry.json /app/contracts/tools/registry.json\n')
    (context / 'Manager.Dockerfile').write_text('FROM whippet-manager:m10-qa\nCOPY --chmod=755 manager /usr/local/bin/whippet-manager\nCOPY registry.json /app/contracts/tools/registry.json\n')
    result = {}
    for kind in ['Worker','Manager']:
        tag = f'whippet-{kind.lower()}:m10z-89a741b'
        command(['docker','build','--network','none','-t',tag,'-f',str(context / (kind+'.Dockerfile')),str(context)])
        result[kind.lower()] = {'tag':tag,'image':command(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()}
    result['managerBinarySha256'] = digest(context / 'manager')
    result['serverBinarySha256'] = digest(OUT / 'odd/build/whippet-server-darwin-arm64')
    result['workerDist'] = {str(p.relative_to(context)):digest(p) for p in (context / 'dist').rglob('*') if p.is_file()}
    result['dependencyLockSha256'] = lock
    result['baseImage'] = base
    write('images.json',result)
    print(json.dumps({'images':'PASS',**{k:v['image'] for k,v in result.items() if isinstance(v,dict) and 'image' in v}}))

def serve():
    if (OUT / 'environment.json').exists():
        raise RuntimeError('environment_receipt_exists')
    for port in [19887,19888,19889]:
        with socket.socket() as s:
            s.bind(('127.0.0.1',port))
    work = OUT / 'work'
    work.mkdir(exist_ok=True)
    cert,key = OUT / 'qa.crt',OUT / 'qa.key'
    command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','3','-subj','/CN=localhost',
             '-addext','subjectAltName=IP:127.0.0.1,DNS:localhost,DNS:host.docker.internal',
             '-keyout',str(key),'-out',str(cert)])
    os.chmod(key,0o600)
    pg = json.loads((OUT / 'postgres.json').read_text())
    token = secrets.token_urlsafe(48)
    clean = {'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(pathlib.Path.home())}
    procs = []
    def start(argv,env,cwd=REPO):
        p = subprocess.Popen(argv,cwd=cwd,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        procs.append(p)
        return p
    server = start([str(OUT / 'odd/build/whippet-server-darwin-arm64')],{**clean,
        'DATABASE_URL':pg['dsn'],'MANAGER_TOKEN':token,'PORT':'19889','WHIPPET_BIND_HOST':'127.0.0.1',
        'TLS_CERT_FILE':str(cert),'TLS_KEY_FILE':str(key),'ARTIFACT_DIR':str(OUT / 'artifacts'),
        'WHIPPET_SECRET_MASTER_KEY':base64.b64encode(secrets.token_bytes(32)).decode(),
        'WHIPPET_TOOL_REGISTRY_PATH':str(REPO / 'contracts/tools/registry.json'),
        'WHIPPET_SKILLS_PATH':str(REPO / 'runtimes/worker/skills')})
    tls = ssl.create_default_context(cafile=str(cert))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=tls))
    def wait(url):
        for _ in range(100):
            try:
                with opener.open(url,timeout=2) as response:
                    if response.status == 200: return
            except Exception: time.sleep(.2)
        raise RuntimeError('http_not_ready')
    wait('https://127.0.0.1:19889/readyz')
    manager_id = 'm10z-20261114'
    socket_path = command(['docker','context','inspect','--format','{{.Endpoints.docker.Host}}']).decode().strip().removeprefix('unix://')
    model_file = REPO / 'deploy/.env.ai'
    if not model_file.is_file(): raise RuntimeError('model_secret_file_unavailable')
    # Docker consumes the existing authorized secret file; this harness never opens it.
    manager_container = PREFIX+'-manager-v2'
    args = ['docker','run','-d','--name',manager_container,'--label','whippet.qa=m10z-20261114',
        '--env-file',str(model_file),'-e','MANAGER_TOKEN='+token,'-e','SERVER_URL=https://host.docker.internal:19889',
        '-e','WHIPPET_M109_DIAGNOSTICS=1',
        '-e','SERVER_CA_FILE='+str(cert),'-e','MANAGER_ID='+manager_id,'-e','MAX_WORKERS=1',
        '-e','WORKER_IMAGE=whippet-worker:m10z-89a741b','-e','WORK_DIR='+str(work),
        '-v',socket_path+':/var/run/docker.sock','-v',str(work)+':'+str(work),
        '-v',str(cert)+':'+str(cert)+':ro','whippet-manager:m10z-89a741b']
    command(args)
    spec = importlib.util.spec_from_file_location('target', REPO/'scripts/test/m11w3-ui-target.py')
    target_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(target_module)
    credentials = {name:(secrets.token_urlsafe(32),secrets.token_urlsafe(32)) for name in ['A','B']}
    login_counts = {'A':0,'B':0}
    class Target(BaseHTTPRequestHandler):
        def log_message(self,*_): pass
        def do_GET(self):
            body = target_module.PAGE
            content_type = 'text/html; charset=utf-8'
            if self.path == '/login':
                body = b'<h1>QA Login</h1><form method="post" action="/login"><label>Username<input id="username" name="username"></label><label>Password<input id="password" name="password" type="password"></label><button id="submit">Sign in</button></form>'
            elif self.path == '/qa-metadata':
                body = json.dumps({'successCounts':login_counts}).encode()
                content_type = 'application/json'
            self.send_response(200);self.send_header('Content-Type',content_type);self.end_headers();self.wfile.write(body)
        def do_POST(self):
            length = int(self.headers.get('Content-Length','0'))
            if length>8192: self.send_error(400);return
            form = parse_qs(self.rfile.read(length).decode())
            role = next((n for n,(u,p) in credentials.items() if form.get('username')==[u] and form.get('password')==[p]),None)
            if role: login_counts[role]+=1
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers()
            self.wfile.write(('<h1>Authenticated '+role+'</h1>' if role else '<h1>Denied</h1>').encode())
    target_server = ThreadingHTTPServer(('0.0.0.0',19888),Target)
    threading.Thread(target=target_server.serve_forever,daemon=True).start()
    start(['node','node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','19887'],
          {**clean,'WHIPPET_API_PROXY_TARGET':'https://127.0.0.1:19889','NODE_EXTRA_CA_CERTS':str(cert)},REPO / 'apps/web')
    wait('http://127.0.0.1:19887')
    wait('http://127.0.0.1:19888')
    def post(path,body,method='POST'):
        request = urllib.request.Request('https://127.0.0.1:19889'+path,data=json.dumps(body).encode(),
                method=method,headers={'Content-Type':'application/json'})
        with opener.open(request,timeout=10) as response: return json.load(response)
    prior = OUT / 'business-fixture.json'
    workspace = {'id':json.loads(prior.read_text())['workspaceId']} if prior.exists() else post('/api/workspaces',{'name':'M10.Z isolated business acceptance'})
    config = {'name':'M10.Z isolated business acceptance','purpose':'builtin order business assertions',
        'backgroundSummary':'QA fixture: W3-OK order completed, TWD320; missing order not found.',
        'targets':[{'name':'Order lookup','purpose':'order business assertions','origin':'http://host.docker.internal:19888'}],
        'dependencies':[],'excludedOrigins':[],'exclusions':'','loginRoles':[],
        'defaultTestUrl':'http://host.docker.internal:19888','timeoutMs':60000}
    encoded = json.dumps(config,separators=(',',':')).replace("'","''")
    sql = f"UPDATE workspaces SET canonical_config='{encoded}'::jsonb,lifecycle='active',scope_status='confirmed',authorization_revision=authorization_revision+1 WHERE id='{workspace['id']}'::uuid;"
    command(['docker','exec',pg['name'],'psql','-X','-q','-U','postgres','-v','ON_ERROR_STOP=1','-c',sql])
    login_fixtures = {}
    for name in ['A','B']:
        ws = post('/api/workspaces',{'name':'M10.Z login '+name})
        role = str(uuid.uuid4())
        cfg = {**config,'name':'M10.Z login '+name,'loginRoles':[{'roleId':role,'name':'Synthetic member '+name,
            'loginMethod':'form','loginOrigin':'http://host.docker.internal:19888'}]}
        encoded = json.dumps(cfg,separators=(',',':')).replace("'","''")
        sql = f"UPDATE workspaces SET canonical_config='{encoded}'::jsonb,lifecycle='active',scope_status='confirmed',authorization_revision=authorization_revision+1 WHERE id='{ws['id']}'::uuid; INSERT INTO workspace_roles(id,workspace_id) VALUES('{role}'::uuid,'{ws['id']}'::uuid);"
        command(['docker','exec',pg['name'],'psql','-X','-q','-U','postgres','-v','ON_ERROR_STOP=1','-c',sql])
        u,p = credentials[name]
        post(f"/api/workspaces/{ws['id']}/roles/{role}/credentials",{'expectedSecretVersion':0,'username':u,'password':p},'PUT')
        login_fixtures[name] = {'workspaceId':ws['id'],'roleId':role,'credentialsConfigured':True,
            'loginUrl':'http://host.docker.internal:19888/login','expectedHeading':'Authenticated '+name}
    write('login-fixtures.json',login_fixtures)
    write('environment.json',{'prefix':PREFIX,'managerId':manager_id,'managerContainer':manager_container,
        'web':'http://127.0.0.1:19887','api':'https://127.0.0.1:19889','ca':str(cert),
        'target':'http://host.docker.internal:19888','postgres':pg['name'],'postgresPort':pg['port'],
        'serverPid':server.pid,'pids':[p.pid for p in procs],'maxWorkers':1,
        'modelSecretInjection':'Docker --env-file; not opened by harness','mcpEnabled':False})
    write('business-fixture.json',{'workspaceId':workspace['id'],'target':'http://host.docker.internal:19888',
        'scopeConfirmed':True,'fixtureSetup':'synthetic Workspace canonical settings via isolated DB',
        'businessExpected':{'orderId':'W3-OK','total':320,'currency':'TWD','found':True,'status':'completed'},
        'missingExpected':{'orderId':'MISSING','found':False}})
    print(json.dumps({'environment':'PASS','web':'http://127.0.0.1:19887'}),flush=True)
    while all(p.poll() is None for p in procs): time.sleep(1)
    print(json.dumps({'environment':'FAIL','reason':'owned_process_exited'}),flush=True)

def refresh_worker(batch='fix1'):
    counts = json.loads(command(['docker','exec',PREFIX+'-pg','psql','-X','-U','postgres','-tAc',
        "SELECT json_build_object('active',count(*) FILTER(WHERE status IN('queued','dispatched','running','collecting','cancelling')),'occupied',count(*) FILTER(WHERE NOT slot_released)) FROM runs"]))
    if counts != {'active':0,'occupied':0}: raise RuntimeError('capacity_not_drained')
    if command(['docker','ps','-aq','--filter','label=whippet.manager.id=m10z-20261114']).strip():
        raise RuntimeError('worker_container_exists')
    context = OUT / ('images-'+batch)
    context.mkdir(exist_ok=False)
    for source,target in [('runtimes/worker/dist','dist'),('runtimes/worker/skills','skills')]:
        shutil.copytree(REPO/source,context/target)
    shutil.copyfile(REPO/'contracts/tools/registry.json',context/'registry.json')
    (context/'Dockerfile').write_text('FROM whippet-worker:m11-final\nCOPY dist/ /opt/whippet/worker/dist/\nCOPY skills/ /opt/whippet/worker/skills/\nCOPY registry.json /app/contracts/tools/registry.json\n')
    old = command(['docker','image','inspect','--format','{{.Id}}','whippet-worker:m10z-89a741b']).decode().strip()
    tag = 'whippet-worker:m10z-'+batch
    command(['docker','build','--network','none','-t',tag,str(context)])
    new = command(['docker','image','inspect','--format','{{.Id}}',tag]).decode().strip()
    command(['docker','tag',new,'whippet-worker:m10z-89a741b'])
    dirty = command(['git','status','--porcelain']).decode().splitlines()
    tracked = command(['git','ls-files','-z']).decode().split('\0')
    write('worker-'+batch+'.json',{'oldImage':old,'newImage':new,'managerRequestedTag':'whippet-worker:m10z-89a741b',
        'commands':['python3 scripts/test/m10z-environment.py refresh-worker'+('' if batch=='fix1' else '-'+batch.removeprefix('fix'))],
        'sourceCommit':command(['git','rev-parse','HEAD']).decode().strip(),'dirtyManifest':dirty,
        'trackedFiles':{f:digest(REPO/f) for f in tracked if f and (REPO/f).is_file()},
        'skills':{str(p.relative_to(REPO)):digest(p) for p in (REPO/'runtimes/worker/skills').rglob('*') if p.is_file()},
        'registrySha256':digest(REPO/'contracts/tools/registry.json'),'preSwitchCounts':counts,
        'deploymentScope':'only new M10.Z Worker tag; Manager/server/DB and all historical deployments retained'})
    print(json.dumps({'batch':batch,'status':'PASS','oldImage':old,'newImage':new}))

def manager_diagnostic():
    receipt = OUT/'manager-live-diag.json'
    if receipt.exists() or (OUT/'manager-live-diag-intent.json').exists():
        raise RuntimeError('manager_diagnostic_intent_exists_inspect_do_not_reapply')
    binary = OUT/'fix/build/manager-live-diag'
    if not binary.is_file(): raise RuntimeError('diagnostic_binary_not_ready')
    env = json.loads((OUT/'environment.json').read_text())
    name = env['managerContainer']
    if name != PREFIX+'-manager-v2': raise RuntimeError('owned_manager_mismatch')
    counts = json.loads(command(['docker','exec',PREFIX+'-pg','psql','-X','-U','postgres','-tAc',
        "SELECT json_build_object('active',count(*) FILTER(WHERE status IN('queued','dispatched','running','collecting','cancelling')),'occupied',count(*) FILTER(WHERE NOT slot_released)) FROM runs"]))
    if counts != {'active':0,'occupied':0}: raise RuntimeError('capacity_not_drained')
    if command(['docker','ps','-aq','--filter','label=whippet.manager.id=m10z-20261114']).strip():
        raise RuntimeError('worker_container_exists')
    old = command(['docker','exec',name,'sha256sum','/usr/local/bin/whippet-manager']).decode().split()[0]
    new = digest(binary)
    context = OUT/'manager-live-diag-image'
    context.mkdir(exist_ok=False)
    shutil.copyfile(binary,context/'manager')
    shutil.copyfile(REPO/'contracts/tools/registry.json',context/'registry.json')
    (context/'Dockerfile').write_text('FROM whippet-manager:m10-qa\nCOPY --chmod=755 manager /usr/local/bin/whippet-manager\nCOPY registry.json /app/contracts/tools/registry.json\n')
    command(['docker','build','--network','none','-t','whippet-manager:m10z-live-diag',str(context)])
    image = command(['docker','image','inspect','--format','{{.Id}}','whippet-manager:m10z-live-diag']).decode().strip()
    metadata = {'container':name,'containerId':command(['docker','inspect','--format','{{.Id}}',name]).decode().strip(),
        'containerBaseImage':command(['docker','inspect','--format','{{.Image}}',name]).decode().strip(),
        'oldBinarySha256':old,'newBinarySha256':new,'rebuildImage':image,'countsBefore':counts,
        'method':'replace only owned container executable, restart same container with existing private configuration',
        'configurationOrSecretRead':False,'sourceCommit':command(['git','rev-parse','HEAD']).decode().strip(),
        'sourceFiles':{str(p.relative_to(REPO)):digest(p) for p in (REPO/'services/manager/internal/manager').glob('*.go')}}
    write('manager-live-diag-intent.json',metadata)
    command(['docker','cp',str(binary),name+':/usr/local/bin/whippet-manager.m10z-next'])
    command(['docker','exec',name,'cp','-n','/usr/local/bin/whippet-manager','/usr/local/bin/whippet-manager.m10z-before-diag'])
    command(['docker','exec',name,'chmod','755','/usr/local/bin/whippet-manager.m10z-next'])
    command(['docker','exec',name,'mv','/usr/local/bin/whippet-manager.m10z-next','/usr/local/bin/whippet-manager'])
    command(['docker','restart','--time','10',name])
    actual = command(['docker','exec',name,'sha256sum','/usr/local/bin/whippet-manager']).decode().split()[0]
    running = command(['docker','inspect','--format','{{.State.Running}}',name]).decode().strip() == 'true'
    if actual != new or not running: raise RuntimeError('manager_diagnostic_switch_not_verified')
    write('manager-live-diag.json',{**metadata,'binaryVerified':True,'running':True,
        'runtimeImageNote':'base image ID unchanged; only writable executable changed, pinned independently by SHA'})
    print(json.dumps({'managerDiagnostic':'PASS','binarySha256':new,'rebuildImage':image}))

if __name__ == '__main__':
    import sys
    {'inventory': inventory, 'start-pg': start_pg,'images':images,'serve':serve,'refresh-worker':refresh_worker,
     'refresh-worker-2':lambda:refresh_worker('fix2'),
     'refresh-worker-3':lambda:refresh_worker('fix3'),'manager-diagnostic':manager_diagnostic}[sys.argv[1]]()
