const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const shim = fs.readFileSync(path.join(__dirname, 'report-storage.js'), 'utf8');
function sandbox() {
  const context = vm.createContext({});
  vm.runInContext(`globalThis.window = globalThis;
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, { configurable: true, get() {
        throw new Error('document is sandboxed and lacks allow-same-origin');
      }});
    }`, context);
  return context;
}

test('opaque sandbox supports the report property access and Storage API', () => {
  const context = sandbox();
  vm.runInContext(shim, context);
  // Playwright Settings uses localStorage[key], including assignments.
  assert.equal(vm.runInContext(`localStorage['theme'] || 'system'`, context), 'system');
  assert.equal(vm.runInContext(`localStorage['theme'] = 'dark'; localStorage.getItem('theme')`, context), 'dark');
  assert.equal(vm.runInContext(`localStorage.setItem('count', 2); localStorage['count']`, context), '2');
  assert.equal(vm.runInContext(`localStorage.length`, context), 2);
  assert.equal(vm.runInContext(`localStorage.key(0)`, context), 'theme');
  assert.equal(vm.runInContext(`localStorage.removeItem('count'); localStorage.getItem('count')`, context), null);
  assert.equal(vm.runInContext(`delete localStorage['theme']; localStorage.length`, context), 0);
  assert.equal(vm.runInContext(`sessionStorage['tab'] = 'one'; localStorage.getItem('tab')`, context), null);
  assert.equal(vm.runInContext(`sessionStorage.clear(); sessionStorage.length`, context), 0);
});

test('storage is isolated per page and existing usable storage is preserved', () => {
  const first = sandbox();
  vm.runInContext(shim, first);
  vm.runInContext(`localStorage['theme'] = 'dark'`, first);
  const second = sandbox();
  vm.runInContext(shim, second);
  assert.equal(vm.runInContext(`localStorage.getItem('theme')`, second), null);
  const native = vm.createContext({ localStorage: { marker: 'native' }, sessionStorage: {} });
  vm.runInContext('globalThis.window = globalThis', native);
  vm.runInContext(shim, native);
  assert.equal(native.localStorage.marker, 'native');
});
