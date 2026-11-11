// Opaque-origin reports cannot use browser storage. Settings live in this page only.
(() => {
  const memoryStorage = () => {
    const values = new Map();
    const api = {
      get length() { return values.size; },
      key(index) { return Array.from(values.keys())[Number(index) >>> 0] ?? null; },
      getItem(key) { return values.get(String(key)) ?? null; },
      setItem(key, value) { values.set(String(key), String(value)); },
      removeItem(key) { values.delete(String(key)); },
      clear() { values.clear(); },
    };
    return new Proxy(api, {
      get(target, key, receiver) {
        return Reflect.has(target, key) ? Reflect.get(target, key, receiver) : values.get(String(key));
      },
      set(_target, key, value) { values.set(String(key), String(value)); return true; },
      deleteProperty(_target, key) { values.delete(String(key)); return true; },
    });
  };
  for (const name of ['localStorage', 'sessionStorage']) {
    try { void window[name]; } catch {
      Object.defineProperty(window, name, { configurable: true, value: memoryStorage() });
    }
  }
})();
