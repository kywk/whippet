#!/usr/bin/env python3
"""Wave2 owned environment. No environment, credential, journal or free-log reads."""
import hashlib,json,pathlib,shutil,subprocess,sys,time,datetime
R=pathlib.Path(__file__).resolve().parents[2]
W=pathlib.Path('/private/tmp/whippet-m10z-20261115-wave2')
OLD=pathlib.Path('/private/tmp/whippet-m10z-20261114')
D='/usr/local/bin/docker'; MANAGER='whippet-m10z-20261114-manager-v2'
MANAGER_SHA='ca35e23ed76500f3fa10493f374943abeb269bb7f4f15df22bb27ab30e6521d4'
BASE_WORKER='sha256:4591e145a297601a88d2c524655c1e82396a75275dc46e1d989d86ceb8a6cc01'
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def cmd(a):
 p=subprocess.run(a,cwd=R,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True)
 if p.returncode:raise RuntimeError('COMMAND_FAILED_'+pathlib.Path(a[0]).name)
 return p.stdout.strip()
def write(n,d):
 with (W/n).open('x') as f:json.dump(d,f,indent=2,ensure_ascii=False);f.write('\n')
def drained():
 q="SELECT json_build_object('active',count(*) FILTER(WHERE status IN('queued','dispatched','running','collecting','cancelling')),'occupied',count(*) FILTER(WHERE NOT slot_released),'unreclaimed',count(*) FILTER(WHERE attempt_id IS NOT NULL AND NOT slot_released)) FROM runs"
 d=json.loads(cmd([D,'exec','whippet-m10z-20261114-pg','psql','-X','-U','postgres','-tAc',q]))
 if any(d.values()) or cmd([D,'ps','-aq','--filter','label=whippet.manager.id=m10z-20261114']):raise RuntimeError('CAPACITY_NOT_DRAINED')
 return d
def package():
 if (W/'worker-package.json').exists():raise RuntimeError('PACKAGE_ALREADY_EXISTS')
 qa=json.loads((W/'odd/worker-contract-final-green.json').read_text())
 owner=json.loads((W/'owner/green.json').read_text())
 # Content is preserved in the receipts; Leader separately reviews the verdicts.
 if not qa or not owner:raise RuntimeError('GREEN_RECEIPT_MISSING')
 counts=drained();old=cmd([D,'image','inspect','--format','{{.Id}}','whippet-worker:m10z-89a741b'])
 if old!=BASE_WORKER:raise RuntimeError('OLD_WORKER_MISMATCH')
 c=W/'worker-image';c.mkdir(exist_ok=False)
 for a,b in [('runtimes/worker/dist','dist'),('runtimes/worker/skills','skills')]:shutil.copytree(R/a,c/b)
 shutil.copyfile(R/'contracts/tools/registry.json',c/'registry.json')
 (c/'Dockerfile').write_text('FROM whippet-worker:m10z-fix3\nCOPY dist/ /opt/whippet/worker/dist/\nCOPY skills/ /opt/whippet/worker/skills/\nCOPY registry.json /app/contracts/tools/registry.json\n')
 if cmd([D,'image','inspect','--format','{{.Id}}','whippet-worker:m10z-fix3'])!=BASE_WORKER:raise RuntimeError('BASE_IMAGE_MISMATCH')
 tag='whippet-worker:m10z-w2-20261115';cmd([D,'build','--network','none','-t',tag,str(c)])
 image=cmd([D,'image','inspect','--format','{{.Id}}',tag]);drained();cmd([D,'tag',image,'whippet-worker:m10z-89a741b'])
 files={str(p.relative_to(R)):digest(p) for p in [R/'runtimes/worker/src/author/engine.ts',R/'runtimes/worker/src/author/loop.ts',R/'runtimes/worker/src/author/m10z-wave2.test.ts']}
 write('worker-package.json',{'status':'PASS','sourceCommit':cmd(['git','rev-parse','HEAD']),'dirtyManifest':cmd(['git','status','--porcelain']).splitlines(),'sourceFiles':files,'oldImage':old,'image':image,'baseImage':BASE_WORKER,'managerRequestedTag':'whippet-worker:m10z-89a741b','countsBefore':counts,'registrySha256':digest(R/'contracts/tools/registry.json'),'skills':{str(p.relative_to(R)):digest(p) for p in (R/'runtimes/worker/skills').rglob('*') if p.is_file()},'dist':{str(p.relative_to(c)):digest(p) for p in (c/'dist').rglob('*') if p.is_file()},'noOldDeploymentsChanged':True})
 print(json.dumps({'package':'PASS','image':image}))
def diagnostics():
 a=json.loads((W/'admission.json').read_text())
 if a.get('leader')!='t6g' or a.get('installManagerDiagnostics') is not True or a.get('modelRuns') is not False:raise RuntimeError('INSTALL_NOT_ADMITTED')
 if (W/'manager-diagnostic-intent.json').exists():raise RuntimeError('INTENT_EXISTS_NO_REAPPLY')
 counts=drained();expected=json.loads((OLD/'manager-live-diag.json').read_text())
 actual=cmd([D,'exec',MANAGER,'sha256sum','/usr/local/bin/whippet-manager']).split()[0]
 cid=cmd([D,'inspect','--format','{{.Id}}',MANAGER])
 if actual!=MANAGER_SHA or cid!=expected['containerId']:raise RuntimeError('OWNED_MANAGER_MISMATCH')
 binary=OLD/'fix/build/manager-live-diag'
 if digest(binary)!=MANAGER_SHA:raise RuntimeError('BINARY_MISMATCH')
 c=W/'manager-diagnostic-image';c.mkdir(exist_ok=False);shutil.copyfile(binary,c/'manager-real')
 wrapper=c/'manager';wrapper.write_text('#!/bin/sh\nexport WHIPPET_M109_DIAGNOSTICS=1\nexec /usr/local/bin/whippet-manager.w2-real "$@"\n')
 (c/'Dockerfile').write_text('FROM whippet-manager:m10z-live-diag\nCOPY --chmod=755 manager-real /usr/local/bin/whippet-manager.w2-real\nCOPY --chmod=755 manager /usr/local/bin/whippet-manager\n')
 base=cmd([D,'image','inspect','--format','{{.Id}}','whippet-manager:m10z-live-diag'])
 if base!=expected['rebuildImage']:raise RuntimeError('MANAGER_BASE_MISMATCH')
 tag='whippet-manager:m10z-w2-diag';cmd([D,'build','--network','none','-t',tag,str(c)])
 image=cmd([D,'image','inspect','--format','{{.Id}}',tag])
 receipt={'container':MANAGER,'containerId':cid,'containerBaseImage':expected['containerBaseImage'],'binarySha256':MANAGER_SHA,'wrapperSha256':digest(wrapper),'rebuildImage':image,'countsBefore':counts,'flagEnabledByPinnedWrapper':True,'configEnvOrTokenRead':False,'journalPreserved':True,'method':'same owned container, replace executable with fixed-flag shim, existing private configuration unchanged'}
 write('manager-diagnostic-intent.json',receipt)
 cmd([D,'cp',str(binary),MANAGER+':/usr/local/bin/whippet-manager.w2-real'])
 cmd([D,'cp',str(wrapper),MANAGER+':/usr/local/bin/whippet-manager.w2-next'])
 cmd([D,'exec',MANAGER,'chmod','755','/usr/local/bin/whippet-manager.w2-real','/usr/local/bin/whippet-manager.w2-next'])
 cmd([D,'exec',MANAGER,'cp','-n','/usr/local/bin/whippet-manager','/usr/local/bin/whippet-manager.w2-before-wrapper'])
 cmd([D,'exec',MANAGER,'mv','/usr/local/bin/whippet-manager.w2-next','/usr/local/bin/whippet-manager'])
 cmd([D,'restart','--time','10',MANAGER])
 real=cmd([D,'exec',MANAGER,'sha256sum','/usr/local/bin/whippet-manager.w2-real']).split()[0]
 wrap=cmd([D,'exec',MANAGER,'sha256sum','/usr/local/bin/whippet-manager']).split()[0]
 running=cmd([D,'inspect','--format','{{.State.Running}}',MANAGER])=='true'
 if real!=MANAGER_SHA or wrap!=receipt['wrapperSha256'] or not running:raise RuntimeError('INSTALL_VERIFICATION_FAILED')
 write('manager-diagnostic.json',{**receipt,'status':'PASS','binaryVerified':True,'wrapperVerified':True,'running':True})
 print(json.dumps({'diagnosticInstall':'PASS','binarySha256':real,'wrapperSha256':wrap}))
if __name__=='__main__':
 try:{'package-worker':package,'enable-diagnostics':diagnostics}[sys.argv[1]]()
 except Exception as e:
  print(json.dumps({'status':'STOP','reason':str(e) if isinstance(e,RuntimeError) else type(e).__name__}));sys.exit(2)
