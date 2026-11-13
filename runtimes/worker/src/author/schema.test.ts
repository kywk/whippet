import test from 'node:test';
import assert from 'node:assert/strict';
import { loadToolRegistry, validateToolArguments } from './registry.js';
import { assertSchema, matchesSchema } from './schema.js';
const registry = loadToolRegistry();
const validate = (name: string, value: unknown) => validateToolArguments(registry.tools.find(t => t.name === name)!, value);
const stage = () => ({ id: 'first', title: '搜尋', action: 'reuse', moduleVersionId: '11111111-1111-1111-1111-111111111111', args: {} });
test('10.1 schemas reject unsupported constructs, invalid types and UTF8 overflow', () => {
  assert.equal(registry.version, '10.1');
  assert.throws(() => assertSchema({ type: 'object', anything: true }));
  assert.throws(() => assertSchema({ type: 'any' }));
  validate('catalog_search', { query: '搜尋', limit: 20, cursor: null });
  for (const limit of [0,21,1.5,'1',null]) assert.throws(() => validate('catalog_search', {query:'',limit,cursor:null}));
  assert.throws(() => validate('catalog_search', {query:'中'.repeat(342),limit:1,cursor:null}));
  assert.throws(() => validate('catalog_get', {moduleVersionId:'opaque'}));
  assert.throws(() => validate('catalog_search', {query:'',limit:1,cursor:null,toString:'bypass'}));
});
test('Plan enforces union, bounds, required fields and safe JSON literals', () => {
  validate('propose_plan', {stages:[stage()]});
  for (const bad of [{...stage(), action:'inline'}, {...stage(), extra:1}, {...stage(),args:{page:{kind:'literal',value:1}}}, {...stage(),args:JSON.parse('{"__proto__":{"kind":"literal","value":1}}')}, {...stage(),args:{x:{kind:'literal',value:NaN}}}]) assert.throws(() => validate('propose_plan',{stages:[bad]}));
  assert.throws(() => validate('propose_plan',{stages:Array.from({length:33},stage)}));
  assert.throws(() => validate('propose_plan',{stages:[{...stage(),args:{x:{kind:'binding',stageId:'first',path:Array(17).fill('x')}}}]}));
  assert.throws(() => validate('propose_plan',{stages:[{...stage(),args:{x:{kind:'literal',value:'x'.repeat(16384)}}}]}));
  assert.equal(matchesSchema({'x-maxDepth':1}, {x:1}),true);
  assert.equal(matchesSchema({'x-maxDepth':1}, {x:{}}),false);
  assert.equal(matchesSchema({oneOf:[{type:'number'},{type:'integer'}]},1),false);
});
test('Module schema enforces full metadata and raw UTF8 limits', () => {
  const module = {slug:'search',moduleKind:'step',exportName:'search',signature:'',inputs:'',returns:'',preconditions:'',postconditions:'',harness:''};
  validate('update_module_candidate',{script:'',module});
  assert.throws(() => validate('update_module_candidate',{script:'',module:{...module,slug:'../x'}}));
  assert.throws(() => validate('update_module_candidate',{script:'',module:{...module,harness:'中'.repeat(699051)}}));
  assert.throws(() => validate('update_module_candidate',{script:'',module:{...module,unknown:''}}));
});
