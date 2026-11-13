"""Offline synthetic sidecar compatibility; no API/DB/real diagnostic reads."""
import copy,json,runpy,stat,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
M=runpy.run_path(str(Path(__file__).with_name('m10_shop_t4t_observe.py')))
class DiagnosticTest(unittest.TestCase):
 def fixture(self,version=1):
  w=dict(selfTestPassedCount=0,selfTestFailedCount=1,checkpointCreated=False,checkpointPresentAtFinalize=False,checkpointRetainedAfterSecretGuard=False,terminalClass='LIMIT')
  if version==2:w['lastSelfTestFailureClass']='UNKNOWN'
  return dict(schemaVersion=version,workerObserved=True,worker=w,manager=dict(workerResultPresent=True,workerResultValid=True,workerStatus='failed',authorArtifactPresent=False,authorParserChecked=False,authorParserAccepted=False,uploadAttempted=False,uploadAccepted=False,disposition='WORKER_FAILED'))
 def read(self,data):
  raw=json.dumps(data).encode()
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
  for path,value in [('schemaVersion',3),('schemaVersion',True),('workerObserved',1)]:
   d=copy.deepcopy(base);d[path]=value;cases.append(d)
  for key,value in [('lastSelfTestFailureClass',None),('lastSelfTestFailureClass',42),('lastSelfTestFailureClass','SENSITIVE_SENTINEL'),('schemaVersion',2),('selfTestFailedCount',True),('rawError','SENSITIVE_SENTINEL')]:
   d=copy.deepcopy(base);d['worker'][key]=value;cases.append(d)
  d=copy.deepcopy(base);del d['worker']['lastSelfTestFailureClass'];cases.append(d)
  d=copy.deepcopy(base);d['schemaVersion']=1;cases.append(d)
  for d in cases:
   self.assertEqual(self.read(d),{'status':'UNKNOWN','reason':'unsafe_or_invalid'})
 def test_duplicate_and_size_rejected(self):
  raw=json.dumps(self.fixture()).encode()
  for invalid in [raw.replace(b'"schemaVersion": 1',b'"schemaVersion": 1, "schemaVersion": 1'),raw+b' '*4096]:
   with self.assertRaises(ValueError):M['decode_diagnostic'](invalid)
if __name__=='__main__':unittest.main()
