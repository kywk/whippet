"""Synthetic offline checks: no network, Docker, DB or historical writes."""
import contextlib,copy,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,Mock
import m10_shop_t4t_retry4_submit as S
import m10_shop_t4t_retry4_observe as O

class Retry4Test(unittest.TestCase):
 def snapshot(self,new=False):
  return {'runId':'00000000-0000-4000-8000-000000000001','primaryModule':True,'version1':True,'maxOutputTokensPresent':new,'maxOutputTokens':16384 if new else None,'effectiveMaxOutputTokens':16384 if new else 8192,'maxModelRequests':8,'maxToolCalls':12,'maxDurationMs':180000,'manifestSha256':S.MODULE_HASH if new else 'a'*64,'authorPayloadSha256':'b'*64}
 def test_default_preview_is_offline(self):
  with patch.object(S,'preflight',side_effect=AssertionError('network forbidden')),patch.object(O,'observe_once',side_effect=AssertionError('network forbidden')),patch('sys.argv',['script']),contextlib.redirect_stdout(io.StringIO()):
   S.main();O.main()
  with patch('sys.argv',['script','--submit']),patch.object(S,'preflight') as preflight:
   with self.assertRaises(RuntimeError):S.main()
   preflight.assert_not_called()
 def test_precise_old_new_snapshot(self):
  self.assertTrue(S.valid_snapshot(self.snapshot(),False));self.assertTrue(S.valid_snapshot(self.snapshot(True),True))
  for new in (False,True):
   for key,value in [('primaryModule',False),('maxModelRequests',True),('maxDurationMs',1),('authorPayloadSha256','SENSITIVE_SENTINEL')]:
    s=self.snapshot(new);s[key]=value;self.assertFalse(S.valid_snapshot(s,new))
  for key,value in [('maxOutputTokens',None),('maxOutputTokens',8192),('maxOutputTokens',True),('maxOutputTokensPresent',False),('manifestSha256','c'*64)]:
   s=self.snapshot(True);s[key]=value;self.assertFalse(S.valid_snapshot(s,True))
 def test_source_proof_detects_drift(self):
  old=self.snapshot();new=self.snapshot(True);changed=copy.deepcopy(old);changed['authorPayloadSha256']='c'*64
  with patch.object(S,'snapshot',side_effect=[changed,new]):
   proof=S.snapshot_proof({'sourceSnapshotBefore':old},new['runId'])
  self.assertFalse(proof['sourcePayloadUnchanged']);self.assertTrue(proof['newSnapshotValid'])
 def test_existing_intent_blocks_before_post(self):
  with tempfile.TemporaryDirectory() as d,patch.object(S,'ROOT',Path(d)),patch.object(S.urllib.request,'build_opener') as opener:
   S.save('.intent.json',{'reserved':True})
   with self.assertRaises(FileExistsError):S.submit({'url':'http://invalid.test','request':{}})
   opener.assert_not_called()
 def test_uncertain_post_keeps_intent_one_request(self):
  with tempfile.TemporaryDirectory() as d,patch.object(S,'ROOT',Path(d)),patch.object(S.urllib.request,'build_opener') as opener:
   opener.return_value.open.side_effect=RuntimeError('SENSITIVE_SENTINEL')
   with self.assertRaisesRegex(RuntimeError,'NEVER resend') as caught:S.submit({'url':'http://invalid.test','request':{}})
   self.assertNotIn('SENSITIVE_SENTINEL',str(caught.exception));opener.return_value.open.assert_called_once()
   self.assertTrue((Path(d)/(S.PREFIX+'.intent.json')).exists())
   out=S.load(Path(d)/(S.PREFIX+'.outcome.json'));self.assertFalse(out['automaticResend'])
 def test_success_requires_snapshot_proof(self):
  run=self.snapshot(True)['runId'];plan={'id':S.PLAN,'revision':11,'status':'running','stages':[{'id':'search','status':'authoring','authorRunId':run}]}
  with tempfile.TemporaryDirectory() as d,patch.object(S,'ROOT',Path(d)),patch.object(S.urllib.request,'build_opener') as opener,patch.object(S,'snapshot_proof',return_value={'sourcePayloadUnchanged':False,'newSnapshotValid':True}):
   opener.return_value.open.return_value.__enter__.return_value=io.StringIO(json.dumps({'plan':plan}))
   with self.assertRaises(RuntimeError):S.submit({'url':'http://invalid.test','request':{}})
   opener.return_value.open.assert_called_once()
   self.assertTrue((Path(d)/(S.PREFIX+'.outcome.json')).exists());self.assertTrue((Path(d)/(S.PREFIX+'.snapshot-proof.json')).exists())
 def test_no_redirect_and_reader_reused(self):
  self.assertIsNone(S.NoRedirect().redirect_request(None,None,None,None,None,None))
  from m10_shop_t4t_observe import diagnostic
  self.assertIs(O.diagnostic,diagnostic)
 def test_snapshot_query_is_bounded_projection(self):
  with patch.object(S,'sql',return_value=[self.snapshot()]) as query:
   S.snapshot(self.snapshot()['runId'])
  text=query.call_args.args[0]
  self.assertIn("encode(sha256(convert_to(author_payload::text,'UTF8')),'hex')",text)
  self.assertIn('BETWEEN 1 AND 16384',text);self.assertNotIn("'messages'",text)
  with patch.object(S,'sql') as query:
   with self.assertRaises(ValueError):S.snapshot("' OR true --")
   query.assert_not_called()
if __name__=='__main__':unittest.main()
