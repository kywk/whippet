"""Offline synthetic tests; no model, deployment, Docker, DB or HTTP."""
import contextlib,copy,hashlib,io,json,re,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import m10_shop_t50_retry7_submit as S
import m10_shop_t50_retry7_observe as O
class Retry7Tests(unittest.TestCase):
 def snapshot(self,new):
  return {'runId':'00000000-0000-4000-8000-000000000001','primaryModule':True,'version1':True,'maxOutputTokensPresent':True,'maxOutputTokens':16384,'effectiveMaxOutputTokens':16384,'maxModelRequests':8,'maxToolCalls':12,'maxDurationMs':180000,'manifestSha256':S.MODULE_HASH if new else S.OLD_MODULE_HASH,'authorPayloadSha256':'a'*64}
 def test_default_offline_and_explicit_gate(self):
  with patch.object(S,'preflight',side_effect=AssertionError('network forbidden')),patch('sys.argv',['script']),contextlib.redirect_stdout(io.StringIO()):S.main()
  with patch('sys.argv',['script','--submit']),patch.object(S,'preflight') as pre:
   with self.assertRaises(RuntimeError):S.main()
   pre.assert_not_called()
 def test_content_exact_candidate_and_hashes(self):
  prep=S.load(S.ROOT/(S.PREFIX+'.preparation.json'));candidate=S.load(prep['candidatePath'])
  self.assertEqual(S.digest(prep['candidatePath']),prep['candidateFileSha256'])
  provided={'script':candidate['script'],'harness':candidate['module']['harness'],'metadata':{k:v for k,v in candidate['module'].items() if k!='harness'}}
  self.assertEqual(provided,prep['providedCandidate']);self.assertIn(json.dumps(provided,ensure_ascii=False,indent=2),prep['requestDraft']['content'])
  self.assertEqual(hashlib.sha256(prep['requestDraft']['content'].encode()).hexdigest(),prep['newContentSha256'])
  self.assertEqual(hashlib.sha256(provided['script'].encode()).hexdigest(),prep['bodySha256']);self.assertEqual(hashlib.sha256(provided['harness'].encode()).hexdigest(),prep['harnessSha256'])
  self.assertEqual([prep['requestDraft'][k] for k in ['planRevision','moduleRevision','moduleContextRevision']],[16,1,7])
  for n,h in prep['historicalSourcesSha256'].items():self.assertEqual(S.digest(S.ROOT/n),h)
 def test_old_new_pin_and_fixed_budget(self):
  for new in (False,True):
   self.assertTrue(S.valid_snapshot(self.snapshot(new),new))
   for key,value in [('maxOutputTokens',8192),('maxModelRequests',True),('maxDurationMs',900000),('manifestSha256','b'*64),('maxOutputTokensPresent',False)]:
    s=self.snapshot(new);s[key]=value;self.assertFalse(S.valid_snapshot(s,new))
 def test_no_resend_after_intent_or_uncertainty(self):
  with tempfile.TemporaryDirectory() as d,patch.object(S,'ROOT',Path(d)),patch.object(S.urllib.request,'build_opener') as op:
   op.return_value.open.side_effect=RuntimeError('SENSITIVE_SENTINEL')
   intent={'url':'http://invalid.test','request':{}}
   with self.assertRaisesRegex(RuntimeError,'NEVER resend') as caught:S.submit(intent)
   self.assertNotIn('SENSITIVE_SENTINEL',str(caught.exception));op.return_value.open.assert_called_once()
   with self.assertRaises(FileExistsError):S.submit(intent)
   op.return_value.open.assert_called_once()
   self.assertFalse(S.load(Path(d)/(S.PREFIX+'.outcome.json'))['automaticResend'])
 @patch.object(S,'provided_content_proof',return_value=True)
 def test_snapshot_proof_requires_bounded_pin_and_source_unchanged(self,_provided):
  old=self.snapshot(False);new=self.snapshot(True)
  for flags in [{},{'registryPinned':False,'boundedTools':True},{'registryPinned':True,'boundedTools':False}]:
   with patch.object(S,'snapshot',side_effect=[old,new]),patch.object(S,'bounded_snapshot',return_value=flags):self.assertFalse(S.snapshot_proof({'sourceSnapshotBefore':old,'request':{'content':'synthetic'}},new['runId'])['newSnapshotValid'])
  changed=copy.deepcopy(old);changed['authorPayloadSha256']='b'*64
  with patch.object(S,'snapshot',side_effect=[changed,new]),patch.object(S,'bounded_snapshot',return_value={'registryPinned':True,'boundedTools':True}):self.assertFalse(S.snapshot_proof({'sourceSnapshotBefore':old,'request':{'content':'synthetic'}},new['runId'])['sourcePayloadUnchanged'])
 def test_bounded_query_and_no_redirect(self):
  with patch.object(S,'sql',return_value=[{}]) as q:S.bounded_snapshot(self.snapshot(True)['runId'])
  sql=q.call_args.args[0];self.assertIn("='10.3'",sql);self.assertIn('NOT',sql);self.assertNotIn('messages',sql)
  with patch.object(S,'sql') as q:
   with self.assertRaises(ValueError):S.bounded_snapshot("' OR true --")
   q.assert_not_called()
  self.assertIsNone(S.NoRedirect().redirect_request(None,None,None,None,None,None))
 def test_observation_fixed_grammar_and_offline_default(self):
  with patch.object(O,'observe_once',side_effect=AssertionError('network forbidden')),patch('sys.argv',['observer']),contextlib.redirect_stdout(io.StringIO()):O.main()
  with patch.object(S,'sql',return_value=[{}]) as q:O.events(self.snapshot(True)['runId'])
  sql=q.call_args.args[0];grammar=re.search(r"regexp_match\(message,'(\^author:observe:[^']+)'\)",sql).group(1)
  self.assertIsNotNone(re.fullmatch(grammar,'author:observe:8:timeoutBodyWait'))
  for bad in ['author:observe:9:timeoutBodyWait','author:observe:1:SECRET','author:observe:1:started extra','author:observe:1:started\n']:self.assertIsNone(re.fullmatch(grammar,bad))
  self.assertIn('created_at',sql);self.assertIn("WHERE run_id='"+self.snapshot(True)['runId']+"'",sql)
 def repair_fixture(self):
  original={'pending':False,'settingsPreserved':True,'databaseWebUntouched':True,'sharedManifestSHA256':S.SHARED_HASH,'newIds':{'server':'a'*64,'manager':'b'*64},'images':{'server':'sha256:'+'c'*64,'manager':'sha256:'+'d'*64,'worker':'sha256:'+'e'*64}}
  repair={'pending':False,'originalReceiptSha256':'f'*64,'oldManagerId':'b'*64,'newManagerId':'1'*64,'managerImage':'sha256:'+'2'*64,'settingsPreserved':True,'serverWorkerDatabaseWebUntouched':True,'sharedManifestSHA256':S.SHARED_HASH,'images':{'server':original['images']['server'],'worker':original['images']['worker']},'unchangedIds':{'server':'a'*64,'postgres':'3'*64,'web':'4'*64}}
  return original,repair
 def test_manager_repair_chain(self):
  original,repair=self.repair_fixture();before=copy.deepcopy(original)
  self.assertEqual(S.validate_manager_repair(original,'f'*64,repair),{'id':'1'*64,'image':'sha256:'+'2'*64});self.assertEqual(original,before)
  changes=[('pending',True),('pending',0),('settingsPreserved',False),('serverWorkerDatabaseWebUntouched',False),('originalReceiptSha256','0'*64),('oldManagerId','0'*64),('newManagerId','b'*64),('newManagerId','short'),('managerImage','bad'),('sharedManifestSHA256','0'*64),('images',{'server':'sha256:'+'0'*64,'worker':original['images']['worker']}),('images',{'server':original['images']['server'],'worker':'sha256:'+'0'*64}),('unchangedIds',{'server':'0'*64,'postgres':'3'*64,'web':'4'*64}),('unknown',True)]
  for key,value in changes:
   with self.subTest(key=key,value=value):
    bad=copy.deepcopy(repair);bad[key]=value
    with self.assertRaises(RuntimeError):S.validate_manager_repair(original,'f'*64,bad)
  for key in repair:
   bad=copy.deepcopy(repair);del bad[key]
   with self.assertRaises(RuntimeError):S.validate_manager_repair(original,'f'*64,bad)
 def mock_deployment(self,original,repair,stopped=None,drift=None):
  mounts='\n'.join(json.dumps(str(S.SHARED/path))+' '+json.dumps(dest)+' false' for path,dest in [('skills','/opt/whippet/worker/skills'),('contracts/tools/registry.json','/app/contracts/tools/registry.json')])
  def call(args):
   if args[:3]==['docker','image','inspect']:return original['images']['worker']
   role=args[-1].removeprefix('whippet-m10-shop-');template=args[3]
   if template=='{{.Id}}':return '0'*64 if drift==role else repair['unchangedIds'][role]
   if '.Mounts' in template:return mounts
   if 'aliases' in template:return json.dumps({'aliases':['whippet-m10-server'],'ip':'synthetic'})
   cid=repair['newManagerId'] if role=='manager' else original['newIds'][role]
   img=repair['managerImage'] if role=='manager' else original['images'][role]
   if drift==role:cid='0'*64
   return ' '.join(json.dumps(v) for v in [cid,img,role!=stopped])
  return call
 def sanitize_fixture(self,parent):
  repair=copy.deepcopy(parent);repair.pop('originalReceiptSha256');repair.update(parentRepairReceiptSha256='9'*64,oldManagerId=parent['newManagerId'],newManagerId='5'*64,managerImage='sha256:'+'6'*64)
  return repair
 def test_sanitize_repair_chain(self):
  original,parent=self.repair_fixture();repair=self.sanitize_fixture(parent)
  self.assertEqual(S.validate_sanitize_repair(parent,'9'*64,repair),{'id':'5'*64,'image':'sha256:'+'6'*64})
  for key,value in [('pending',True),('parentRepairReceiptSha256','0'*64),('oldManagerId',original['newIds']['manager']),('sharedManifestSHA256','0'*64),('unknown',True),('unchangedIds',{'server':'a'*64,'postgres':'0'*64,'web':'4'*64}),('images',{'server':'sha256:'+'c'*64,'worker':'sha256:'+'0'*64})]:
   bad=copy.deepcopy(repair);bad[key]=value
   with self.assertRaises(RuntimeError):S.validate_sanitize_repair(parent,'9'*64,bad)
 def test_manager_repair_deployment_keeps_guards(self):
  original,parent=self.repair_fixture();repair=self.sanitize_fixture(parent)
  def load(path):return original if path==S.RECEIPT else parent if path==S.MANAGER_REPAIR else repair
  def digest(path):return 'f'*64 if path==S.RECEIPT else '9'*64 if path==S.MANAGER_REPAIR else '8'*64
  with patch.object(S,'load',side_effect=load),patch.object(S,'digest',side_effect=digest),patch.object(S,'verify_shared',return_value={'verified':True}):
   with patch.object(S,'call',side_effect=self.mock_deployment(original,repair)):
    d=S.deployment();self.assertEqual(d['receipt'],original);self.assertEqual(d['managerRepairReceipt'],parent);self.assertEqual(d['sanitizeRepairReceipt'],repair);self.assertEqual(d['receiptSha256'],'f'*64);self.assertEqual(d['managerRepairReceiptSha256'],'9'*64);self.assertEqual(d['sanitizeRepairReceiptSha256'],'8'*64)
   for role in ['server','manager']:
    with patch.object(S,'call',side_effect=self.mock_deployment(original,repair,stopped=role)):
     with self.assertRaises(RuntimeError):S.deployment()
   for role in ['server','manager','postgres','web']:
    with patch.object(S,'call',side_effect=self.mock_deployment(original,repair,drift=role)):
     with self.assertRaises(RuntimeError):S.deployment()
   parent['originalReceiptSha256']='0'*64
   with patch.object(S,'call') as call:
    with self.assertRaises(RuntimeError):S.deployment()
    call.assert_not_called()
 def test_provided_content_and_candidate_query_guards(self):
  run=self.snapshot(True)['runId']
  with patch.object(S,'sql',return_value=[{'providedContentPinned':False}]) as q:self.assertFalse(S.provided_content_proof(run,'a'*64))
  self.assertIn("->-1->>'content'",q.call_args.args[0])
  with patch.object(S,'sql',return_value=[{'candidateCount':0}]) as q:S.candidate_proof(run)
  sql=q.call_args.args[0];self.assertIn('d.test_id=c.test_id AND d.revision=c.revision',sql);self.assertIn("WHERE c.source_run_id='"+run+"'",sql);self.assertIn("d.module-'harness'",sql)
  for value in ["' OR true --",'bad']:
   with patch.object(S,'sql') as q:
    with self.assertRaises(ValueError):S.candidate_proof(value)
    q.assert_not_called()
 def test_observer_tracks_downstream_until_reclaimed(self):
  ids=['00000000-0000-4000-8000-00000000000'+str(n) for n in range(1,5)]
  search,validation,order,old=ids
  for terminal in [False,True]:
   plan={'id':S.PLAN,'status':'stopped' if terminal else 'running','revision':16,'stages':[{'id':'search','status':'ready','authorRunId':search,'validationRunId':validation},{'id':'order','status':'failed' if terminal else 'authoring','authorRunId':order},{'id':'verify','status':'pending'}]}
   rows=[{'id':i,'testId':i,'editingSessionId':i,'kind':'validation' if i==validation else 'author','status':('failed' if terminal else 'running') if i==order else 'succeeded','slotReleased':terminal or i!=order,'attemptId':i} for i in ids[:3]]
   intent={'_retry7RunId':search,'sourceSnapshotBefore':{'runId':old},'deployment':{'receipt':{'images':{'worker':'sha256:'+'a'*64}}}}
   def get(path):return {'plan':plan} if '/plan?' in path else {'session':{'id':'session','status':'active','pendingRunIds':[],'reclaimPending':False}}
   def sql(q):return rows if "'testId',test_id" in q else [{'requestCount':0,'unresolvedCount':0,'validationRunIds':[]}]
   with tempfile.TemporaryDirectory() as temp,patch.object(S,'ROOT',Path(temp)),patch.object(O,'ROOT',Path(temp)),patch.object(S,'get',side_effect=get),patch.object(S,'sql',side_effect=sql),patch.object(S,'snapshot',side_effect=lambda r:{'runId':r}),patch.object(S,'valid_snapshot',return_value=True),patch.object(S,'candidate_proof',return_value={'candidateCount':1,'bodyHashMatches':True,'harnessHashMatches':True,'metadataMatches':True}) as proof,patch.object(S,'counts',return_value={'active':0 if terminal else 1,'unreclaimed':0 if terminal else 1,'unresolvedValidation':0,'activePlans':0 if terminal else 1}),patch.object(O,'worker_image',return_value={'containers':[]}),patch.object(O,'diagnostic',return_value={}),patch.object(O,'events',return_value={}),contextlib.redirect_stdout(io.StringIO()):
    self.assertEqual(O.observe_once(intent),terminal);proof.assert_called_once_with(search)
    latest=S.load(Path(temp)/(S.PREFIX+'.latest.json'));self.assertEqual(len(latest['runs']),3)
    self.assertEqual((Path(temp)/(S.PREFIX+'.final.json')).exists(),terminal)
if __name__=='__main__':unittest.main()
