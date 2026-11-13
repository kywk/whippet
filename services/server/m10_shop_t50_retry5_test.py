"""Offline synthetic tests; no model, deployment, Docker, DB or HTTP."""
import contextlib,copy,hashlib,io,json,re,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import m10_shop_t50_retry5_submit as S
import m10_shop_t50_retry5_observe as O
class Retry5Tests(unittest.TestCase):
 def snapshot(self,new):
  return {'runId':'00000000-0000-4000-8000-000000000001','primaryModule':True,'version1':True,'maxOutputTokensPresent':True,'maxOutputTokens':16384,'effectiveMaxOutputTokens':16384,'maxModelRequests':8,'maxToolCalls':12,'maxDurationMs':180000,'manifestSha256':S.MODULE_HASH if new else S.OLD_MODULE_HASH,'authorPayloadSha256':'a'*64}
 def test_default_offline_and_explicit_gate(self):
  with patch.object(S,'preflight',side_effect=AssertionError('network forbidden')),patch('sys.argv',['script']),contextlib.redirect_stdout(io.StringIO()):S.main()
  with patch('sys.argv',['script','--submit']),patch.object(S,'preflight') as pre:
   with self.assertRaises(RuntimeError):S.main()
   pre.assert_not_called()
 def test_content_exact_two_replacements_and_hashes(self):
  prep=S.load(S.ROOT/(S.PREFIX+'.preparation.json'));old=S.load(S.ROOT/'m10_shop_t4t_retry4.intent.json')['request']['content']
  self.assertEqual(hashlib.sha256(old.encode()).hexdigest(),prep['originalContentSha256'])
  for entry in prep['exactReplacements']:
   self.assertEqual(old.count(entry['old']),1);old=old.replace(entry['old'],entry['new'])
  self.assertEqual(old,prep['requestDraft']['content']);self.assertEqual(hashlib.sha256(old.encode()).hexdigest(),prep['newContentSha256'])
  self.assertEqual(len(prep['exactReplacements']),2)
  final=S.load(S.ROOT/'m10_shop_t4t_retry4.final.json');self.assertEqual(prep['requestDraft']['planRevision'],final['plan']['revision'])
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
 def test_snapshot_proof_requires_bounded_pin_and_source_unchanged(self):
  old=self.snapshot(False);new=self.snapshot(True)
  for flags in [{},{'registryPinned':False,'boundedTools':True},{'registryPinned':True,'boundedTools':False}]:
   with patch.object(S,'snapshot',side_effect=[old,new]),patch.object(S,'bounded_snapshot',return_value=flags):self.assertFalse(S.snapshot_proof({'sourceSnapshotBefore':old},new['runId'])['newSnapshotValid'])
  changed=copy.deepcopy(old);changed['authorPayloadSha256']='b'*64
  with patch.object(S,'snapshot',side_effect=[changed,new]),patch.object(S,'bounded_snapshot',return_value={'registryPinned':True,'boundedTools':True}):self.assertFalse(S.snapshot_proof({'sourceSnapshotBefore':old},new['runId'])['sourcePayloadUnchanged'])
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
 def test_manager_repair_deployment_keeps_guards(self):
  original,repair=self.repair_fixture()
  def load(path):return original if path==S.RECEIPT else repair
  with patch.object(S,'load',side_effect=load),patch.object(S,'digest',side_effect=lambda p:'f'*64 if p==S.RECEIPT else '9'*64),patch.object(S,'verify_shared',return_value={'verified':True}):
   with patch.object(S,'call',side_effect=self.mock_deployment(original,repair)):
    d=S.deployment();self.assertEqual(d['receipt'],original);self.assertEqual(d['managerRepairReceipt'],repair);self.assertEqual(d['receiptSha256'],'f'*64);self.assertEqual(d['managerRepairReceiptSha256'],'9'*64)
   for role in ['server','manager']:
    with patch.object(S,'call',side_effect=self.mock_deployment(original,repair,stopped=role)):
     with self.assertRaises(RuntimeError):S.deployment()
   for role in ['server','manager','postgres','web']:
    with patch.object(S,'call',side_effect=self.mock_deployment(original,repair,drift=role)):
     with self.assertRaises(RuntimeError):S.deployment()
if __name__=='__main__':unittest.main()
