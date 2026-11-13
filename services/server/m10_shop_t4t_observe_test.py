"""Offline synthetic sidecar compatibility; no API/DB/real diagnostic reads."""
import copy,json,os,runpy,stat,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
M=runpy.run_path(str(Path(__file__).with_name('m10_shop_t4t_observe.py')))
class DiagnosticTest(unittest.TestCase):
 def fixture(self,version=1):
  w=dict(selfTestPassedCount=0,selfTestFailedCount=1,checkpointCreated=False,checkpointPresentAtFinalize=False,checkpointRetainedAfterSecretGuard=False,terminalClass='LIMIT')
  if version>=2:w['lastSelfTestFailureClass']='UNKNOWN'
  if version==3:w['modelRequestFailureStage']='UNKNOWN'
  return dict(schemaVersion=version,workerObserved=True,worker=w,manager=dict(workerResultPresent=True,workerResultValid=True,workerStatus='failed',authorArtifactPresent=False,authorParserChecked=False,authorParserAccepted=False,uploadAttempted=False,uploadAccepted=False,disposition='WORKER_FAILED'))
 def read(self,data):
  return self.read_raw(json.dumps(data).encode())
 def read_raw(self,raw):
  with patch('os.open',return_value=7),patch('os.close'),patch('os.fstat',return_value=SimpleNamespace(st_mode=stat.S_IFREG,st_size=len(raw))),patch('os.read',return_value=raw):
   return M['diagnostic']('00000000-0000-4000-8000-000000000001')
 def test_v1_unknown_without_rewriting_value(self):
  d=self.fixture();out=self.read(d)
  self.assertEqual(out['status'],'validated');self.assertEqual(out['value'],d)
  self.assertEqual(out['lastSelfTestFailureClass'],'UNKNOWN')
 def test_v2_enum_and_independent_terminal(self):
  for value in ['INVALID_SPEC','GUARD','TIMEOUT','CANCELLED','TEST_FAILED','UNKNOWN']:
   d=self.fixture(2);d['worker']['lastSelfTestFailureClass']=value
   out=self.read(d);self.assertEqual(out['status'],'validated')
   self.assertEqual(out['lastSelfTestFailureClass'],value)
   self.assertEqual(out['value']['worker']['terminalClass'],'LIMIT')
 def test_invalid_response_only_terminal(self):
  d=self.fixture(2);d['worker']['terminalClass']='INVALID_RESPONSE'
  out=self.read(d)
  self.assertEqual(out['status'],'validated')
  self.assertEqual(out['value']['worker']['terminalClass'],'INVALID_RESPONSE')
  self.assertEqual(out['lastSelfTestFailureClass'],'UNKNOWN')
  d['worker']['lastSelfTestFailureClass']='INVALID_RESPONSE'
  self.assertEqual(self.read(d),{'status':'UNKNOWN','reason':'unsafe_or_invalid'})
 def test_unobserved_unknown(self):
  d=self.fixture(2);d['workerObserved']=False
  self.assertEqual(self.read(d)['lastSelfTestFailureClass'],'UNKNOWN')
 def test_invalid_schema_rejected_without_content(self):
  base=self.fixture(2);cases=[]
  for path,value in [('schemaVersion',4),('schemaVersion',True),('workerObserved',1)]:
   d=copy.deepcopy(base);d[path]=value;cases.append(d)
  for key,value in [('lastSelfTestFailureClass',None),('lastSelfTestFailureClass',42),('lastSelfTestFailureClass','SENSITIVE_SENTINEL'),('schemaVersion',2),('selfTestFailedCount',True),('rawError','SENSITIVE_SENTINEL')]:
   d=copy.deepcopy(base);d['worker'][key]=value;cases.append(d)
  d=copy.deepcopy(base);del d['worker']['lastSelfTestFailureClass'];cases.append(d)
  d=copy.deepcopy(base);d['schemaVersion']=1;cases.append(d)
  for d in cases:
   self.assertEqual(self.read(d),{'status':'UNKNOWN','reason':'unsafe_or_invalid'})
 def test_v3_stages_and_versioned_projection(self):
  stages=['UNKNOWN','FETCH_REJECTED','HTTP_NON_OK','BODY_JSON_REJECTED','RESPONSE_GUARD_REJECTED','INCOMPLETE_MAX_OUTPUT_TOKENS','INCOMPLETE_CONTENT_FILTER','INCOMPLETE_UNKNOWN','ENVELOPE_INVALID']
  for version in (1,2,3):
   for observed in (True,False):
    for stage in stages:
     d=self.fixture(version);d['workerObserved']=observed
     if version==3:d['worker']['modelRequestFailureStage']=stage
     out=self.read(d)
     self.assertEqual(out['status'],'validated');self.assertEqual(out['value'],d)
     self.assertEqual(len(out['value']['worker']),version+5)
     self.assertEqual(out['modelRequestFailureStage'],stage if version==3 and observed else 'UNKNOWN')
 def test_v3_malicious_values_and_mixed_versions(self):
  cases=[]
  for value in [None,True,1,3.0,[],{},'fetch_rejected','FETCH_REJECTED SENSITIVE_SENTINEL','SENSITIVE_SENTINEL']:
   d=self.fixture(3);d['worker']['modelRequestFailureStage']=value;cases.append(d)
  for version in (1,2):
   d=self.fixture(3);d['schemaVersion']=version;cases.append(d)
  for key in ('lastSelfTestFailureClass','modelRequestFailureStage'):
   d=self.fixture(3);del d['worker'][key];cases.append(d)
  for section,key,value in [('worker','schemaVersion',3),('worker','rawError','SENSITIVE_SENTINEL'),('worker','terminalClass',[]),('manager','workerStatus',True),('manager','disposition',{}),('worker','checkpointCreated',1),('worker','selfTestPassedCount',13),('worker','selfTestFailedCount',-1)]:
   d=self.fixture(3);d[section][key]=value;cases.append(d)
  for section in ('worker','manager'):
   for value in (None,[],True):
    d=self.fixture(3);d[section]=value;cases.append(d)
  for value in (True,3.0,'3'):
   d=self.fixture(3);d['schemaVersion']=value;cases.append(d)
  cases.extend([None,[],True])
  for d in cases:
   with self.subTest(data=d):
    out=self.read(d)
    self.assertEqual(out,{'status':'UNKNOWN','reason':'unsafe_or_invalid'})
    self.assertNotIn('SENSITIVE_SENTINEL',json.dumps(out))
 def test_nested_duplicates_trailing_and_size_boundary(self):
  raw=json.dumps(self.fixture(3)).encode()
  self.assertEqual(self.read_raw(raw+b' '*(4096-len(raw)))['status'],'validated')
  invalids=[raw+b' '*(4097-len(raw)),raw+b'SENSITIVE_SENTINEL']
  for token in [b'"schemaVersion": 3',b'"modelRequestFailureStage": "UNKNOWN"',b'"workerStatus": "failed"']:
   invalids.append(raw.replace(token,token+b','+token))
  for invalid in invalids:
   self.assertEqual(self.read_raw(invalid),{'status':'UNKNOWN','reason':'unsafe_or_invalid'})
 def test_nofollow_each_path_and_close(self):
  raw=json.dumps(self.fixture(3)).encode()
  with patch('os.open',side_effect=[10,11,12,13,14]) as opened,patch('os.close') as closed,patch('os.fstat',return_value=SimpleNamespace(st_mode=stat.S_IFREG,st_size=len(raw))),patch('os.read',return_value=raw) as read:
   self.assertEqual(M['diagnostic']('00000000-0000-4000-8000-000000000001')['status'],'validated')
   self.assertEqual(len(opened.call_args_list),5)
   for index,call in enumerate(opened.call_args_list):
    self.assertTrue(call.args[1]&os.O_NOFOLLOW)
    if index<4:self.assertTrue(call.args[1]&os.O_DIRECTORY)
    if index:self.assertEqual(call.kwargs['dir_fd'],9+index)
   read.assert_called_once_with(14,4097)
   self.assertEqual([call.args[0] for call in closed.call_args_list],[14,13,12,11,10])
 def test_duplicate_and_size_rejected(self):
  raw=json.dumps(self.fixture()).encode()
  for invalid in [raw.replace(b'"schemaVersion": 1',b'"schemaVersion": 1, "schemaVersion": 1'),raw+b' '*4096]:
   with self.assertRaises(ValueError):M['decode_diagnostic'](invalid)
if __name__=='__main__':unittest.main()
