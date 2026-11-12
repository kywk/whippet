#!/usr/bin/env node
/*
 * M8 blackbox artifacts QA — read-only public GET verification.
 * Owner: scripts/test/m8-artifacts-blackbox.cjs
 * Evidence: /private/tmp/whippet-m8-artifacts-evidence (override via --out / OUT_DIR)
 *
 * Scope (blackbox):
 * - Only public UI/API GETs: /api/runs/{id}, /api/runs/{id}/artifacts,
 *   /api/runs/{id}/artifacts/report.html, results.json, data/*.png
 * - No journal/DB/source reads, no new Run, no data mutation (no POST/PUT/DELETE).
 * - No install/deploy/Git, no secrets (.env.ai / true secrets) — output only
 *   filenames/locations/stats, never sensitive values or full report text.
 * - Base URL: host -> http://localhost:18087 ; inside container -> http://host.docker.internal:18087
 *   Override: --base-url URL or BASE_URL env. Auto-fallback localhost<->host.docker.internal.
 * - Browser: uses existing @playwright/test + Chromium from
 *   /opt/whippet/worker/node_modules/@playwright/test (whippet-worker:m8b-wave).
 *   No install. If Playwright missing -> BLOCKED (not PASS).
 * - Unzip: prefers existing yauzl (no install). If yauzl absent, uses Node built-in
 *   zlib real inflate (not compressed-bytes scan). Method is reported.
 *   Never passes by scanning compressed bytes.
 *
 * Targets (read-only):
 * - formal Run 29f05216-0540-4909-a58e-0840efffd3a2 (kind=run)
 * - validation b4129af8-3b4d-480d-aa10-33d228a27747 (kind=validation)
 * Checks per target:
 *  (1) artifacts list contains report.html + results.json + >=1 data/*.png
 *  (2) report.html fetched (html, size>0), true-browser render shows Passed 1
 *      (body innerText matches /Passed\s*1/i, /Failed\s*0/i recommended)
 *  (3) PNG artifact decodable/readable (PNG sig + IHDR w/h>0 + IEND; plus browser load naturalWidth>0)
 *  (4) results.json stats expected===1 && unexpected===0
 *  (5) HTML embedded ZIP (<template id="playwrightReportBase64">data:application/zip;base64,…)
 *      really decompressed; non-image entries checked for synthetic sentinels:
 *      "m8-synthetic-password-sentinel", "synthetic-session" must be absent (count 0).
 *      Only entry names/sizes/counts are reported, never values or full text.
 *  (6) provider is explicit fixture, not real AI: run workspaceContext targets/defaultTestUrl
 *      point to synthetic fixture (host.docker.internal:18187) and kind matches expectation.
 *
 * Exit: 0 all PASS, 1 FAIL, 2 BLOCKED (env/deps, not PASS).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const FORMAL_ID = '29f05216-0540-4909-a58e-0840efffd3a2';
const VALIDATION_ID = 'b4129af8-3b4d-480d-aa10-33d228a27747';
const SENTINELS = ['m8-synthetic-password-sentinel', 'synthetic-session'];
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.avif', '.woff', '.woff2', '.ttf', '.eot']);

function parseArgs(argv) {
  const out = { baseUrl: null, outDir: null, timeoutMs: 30000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base-url' && argv[i + 1]) out.baseUrl = argv[++i];
    else if (a.startsWith('--base-url=')) out.baseUrl = a.slice('--base-url='.length);
    else if (a === '--out' && argv[i + 1]) out.outDir = argv[++i];
    else if (a.startsWith('--out=')) out.outDir = a.slice('--out='.length);
    else if (a === '--timeout' && argv[i + 1]) out.timeoutMs = Number(argv[++i]) || 30000;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/test/m8-artifacts-blackbox.cjs [--base-url URL] [--out DIR] [--timeout MS]');
      console.log('Defaults: base http://localhost:18087 (container fallback host.docker.internal:18087), out /private/tmp/whippet-m8-artifacts-evidence');
      process.exit(0);
    }
  }
  return out;
}

function defaultBaseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.WHIPPET_BASE_URL) return process.env.WHIPPET_BASE_URL;
  try {
    if (fs.existsSync('/.dockerenv')) return 'http://host.docker.internal:18087';
  } catch (_) {}
  return 'http://localhost:18087';
}

function defaultOutDir() {
  if (process.env.OUT_DIR) return process.env.OUT_DIR;
  return '/private/tmp/whippet-m8-artifacts-evidence';
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fetchBuffer(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { reject(e); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', timeout: timeoutMs, headers: { Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new URL(res.headers.location, u).toString();
        res.resume();
        fetchBuffer(next, timeoutMs).then(resolve, reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout GET ' + urlStr)));
    req.on('error', reject);
    req.end();
  });
}

async function getJson(base, p, timeoutMs) {
  const r = await fetchBuffer(base.replace(/\/+$/, '') + p, timeoutMs);
  if (r.status !== 200) throw new Error(`GET ${p} -> HTTP ${r.status}`);
  return { json: JSON.parse(r.body.toString('utf8')), headers: r.headers, size: r.body.length };
}

function tryRequireYauzl() {
  const candidates = ['yauzl', '/opt/whippet/worker/node_modules/yauzl'];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const m = require(c);
      return { mod: m, from: c };
    } catch (_) {}
  }
  return null;
}

// Real ZIP inflate fallback using only Node built-ins (stored + deflate).
// Used ONLY when yauzl is absent; still real decompression, never a compressed-bytes scan.
function unzipWithBuiltin(zipBuf) {
  // Minimal central-directory parse -> entries with local header offsets.
  if (zipBuf.length < 22) throw new Error('zip too small');
  let eocd = -1;
  const scanStart = Math.max(0, zipBuf.length - 22 - 65536);
  for (let i = zipBuf.length - 22; i >= scanStart; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('EOCD not found');
  const count = zipBuf.readUInt16LE(eocd + 10);
  const cdSize = zipBuf.readUInt32LE(eocd + 12);
  const cdOff = zipBuf.readUInt32LE(eocd + 16);
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (zipBuf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = zipBuf.readUInt16LE(p + 10);
    const compSize = zipBuf.readUInt32LE(p + 20);
    const uncompSize = zipBuf.readUInt32LE(p + 24);
    const nameLen = zipBuf.readUInt16LE(p + 28);
    const extraLen = zipBuf.readUInt16LE(p + 30);
    const commentLen = zipBuf.readUInt16LE(p + 32);
    const localOff = zipBuf.readUInt32LE(p + 42);
    const name = zipBuf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ fileName: name, method, compSize, uncompSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  void cdSize;
  const files = [];
  for (const e of entries) {
    if (e.fileName.endsWith('/')) continue;
    const lp = e.localOff;
    if (zipBuf.readUInt32LE(lp) !== 0x04034b50) throw new Error('bad local header for ' + e.fileName);
    const nameLen = zipBuf.readUInt16LE(lp + 26);
    const extraLen = zipBuf.readUInt16LE(lp + 28);
    const dataOff = lp + 30 + nameLen + extraLen;
    const comp = zipBuf.slice(dataOff, dataOff + e.compSize);
    let data;
    if (e.method === 0) data = comp;
    else if (e.method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`unsupported method ${e.method} for ${e.fileName}`);
    files.push({ fileName: e.fileName, compSize: e.compSize, uncompSize: data.length, data });
  }
  return files;
}

function unzipWithYauzl(yauzlMod, zipBuf) {
  return new Promise((resolve, reject) => {
    yauzlMod.fromBuffer(zipBuf, { lazyEntries: true }, (err, zipfile) => {
      if (err) { reject(err); return; }
      const files = [];
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zipfile.readEntry(); return; }
        zipfile.openReadStream(entry, (e2, rs) => {
          if (e2) { reject(e2); return; }
          const chunks = [];
          rs.on('data', (c) => chunks.push(c));
          rs.on('end', () => {
            files.push({
              fileName: entry.fileName,
              compSize: entry.compressedSize,
              uncompSize: Buffer.concat(chunks).length,
              data: Buffer.concat(chunks),
            });
            zipfile.readEntry();
          });
          rs.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(files));
      zipfile.on('error', reject);
    });
  });
}

function checkPng(buf) {
  // Returns {ok, width, height, size, reason}
  if (!Buffer.isBuffer(buf) || buf.length < 33) return { ok: false, reason: 'too-small' };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.slice(0, 8).equals(sig)) return { ok: false, reason: 'bad-signature' };
  // IHDR must be first chunk
  const ihdrLen = buf.readUInt32BE(8);
  const ihdrType = buf.slice(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR' || ihdrLen !== 13) return { ok: false, reason: 'bad-ihdr' };
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384)) return { ok: false, reason: 'bad-dimensions' };
  // IEND must exist at end: last 12 bytes = len(0) + "IEND" + crc
  if (buf.length >= 12) {
    const tailType = buf.slice(buf.length - 8, buf.length - 4).toString('ascii');
    const tailLen = buf.readUInt32BE(buf.length - 12);
    if (!(tailType === 'IEND' && tailLen === 0)) return { ok: false, reason: 'missing-iend' };
  } else {
    return { ok: false, reason: 'missing-iend' };
  }
  return { ok: true, width: w, height: h, size: buf.length };
}

function tryRequirePlaywright() {
  const candidates = [
    '@playwright/test',
    '/opt/whippet/worker/node_modules/@playwright/test',
    'playwright-core',
    '/opt/whippet/worker/node_modules/playwright-core',
  ];
  for (const c of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require
      const m = require(c);
      if (m && (m.chromium || (m.default && m.default.chromium))) return { mod: m, from: c };
      if (m && m.chromium) return { mod: m, from: c };
    } catch (_) {}
  }
  // ESM fallback paths are handled by dynamic import in caller if needed.
  return null;
}

async function browserCheckReport(reportUrl, pngUrls, timeoutMs) {
  const pw = tryRequirePlaywright();
  if (!pw) {
    return { status: 'BLOCKED', reason: 'playwright-missing', detail: 'need whippet-worker:m8b-wave (@playwright/test + Chromium). Docker: docker run --rm --add-host=host.docker.internal:host-gateway -v $PWD:/work -w /work whippet-worker:m8b-wave node scripts/test/m8-artifacts-blackbox.cjs --base-url http://host.docker.internal:18087' };
  }
  const chromium = pw.mod.chromium || (pw.mod.default && pw.mod.default.chromium);
  if (!chromium) return { status: 'BLOCKED', reason: 'chromium-export-missing', from: pw.from };
  let browser = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 20000) });
    // Report is JS-rendered from embedded ZIP; must read after render.
    await page.waitForFunction(
      () => document.body && document.body.innerText && /Passed/i.test(document.body.innerText),
      { timeout: Math.min(timeoutMs, 20000) }
    ).catch(() => {});
    const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
    const passed1 = /Passed\s*1/i.test(bodyText) || /1\s*Passed/i.test(bodyText);
    const failed0 = /Failed\s*0/i.test(bodyText);
    const all1 = /All\s*1/i.test(bodyText);
    // PNG readability in real browser (first PNG only, to keep it light).
    let pngBrowser = null;
    if (pngUrls.length > 0) {
      try {
        const pngPage = await ctx.newPage();
        const resp = await pngPage.goto(pngUrls[0], { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 15000) });
        const ok = resp ? resp.ok() : false;
        const natural = await Promise.race([
          pngPage.evaluate(() => {
            const imgs = Array.from(document.images || []);
            if (imgs.length > 0 && imgs[0].naturalWidth > 0) return { w: imgs[0].naturalWidth, h: imgs[0].naturalHeight };
            return { w: -1, h: -1 };
          }).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ]);
        pngBrowser = { urlCount: pngUrls.length, httpOk: ok, naturalWidth: natural ? natural.w : null, naturalHeight: natural ? natural.h : null };
        await pngPage.close().catch(() => {});
      } catch (e) {
        pngBrowser = { error: String(e && e.message ? e.message : e).slice(0, 200) };
      }
    }
    await ctx.close().catch(() => {});
    return {
      status: passed1 ? 'PASS' : 'FAIL',
      from: pw.from,
      bodyChars: bodyText.length,
      matched: { passed1, failed0, all1 },
      // Keep snippet tiny and non-sensitive (counts only, no report text dump).
      snippetPresent: { hasPassedWord: /Passed/i.test(bodyText), hasFailedWord: /Failed/i.test(bodyText) },
      pngBrowser,
    };
  } catch (e) {
    return { status: 'BLOCKED', reason: 'browser-error', detail: String((e && e.message) || e).slice(0, 300) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function verifyOne(base, id, expectKind, outDir, timeoutMs) {
  const result = { id, expectKind, checks: {}, files: {}, stats: {}, status: 'PASS' };
  const fail = (name, detail) => {
    result.checks[name] = { status: 'FAIL', detail };
    result.status = 'FAIL';
  };
  const block = (name, detail) => {
    result.checks[name] = { status: 'BLOCKED', detail };
    if (result.status === 'PASS') result.status = 'BLOCKED';
  };
  const pass = (name, detail) => {
    result.checks[name] = { status: 'PASS', detail };
  };

  // 0) GET run (public)
  let run;
  try {
    const { json } = await getJson(base, `/api/runs/${encodeURIComponent(id)}`, timeoutMs);
    run = json;
    result.files.run = { endpoint: `/api/runs/${id}`, kind: json.kind || null, status: json.status || null, reportUrl: json.reportUrl || null };
    if (expectKind && json.kind !== expectKind) fail('run-kind', `expected kind=${expectKind} got=${json.kind || '?'}`);
    else pass('run-kind', `kind=${json.kind || '?'}`);
    // provider is explicit fixture, not real AI: workspace targets/defaultTestUrl must be synthetic fixture 18187
    try {
      const ws = json.workspaceContext && json.workspaceContext.config ? json.workspaceContext.config : null;
      const targets = ws && Array.isArray(ws.targets) ? ws.targets.map((t) => t.origin).join(',') : '';
      const defUrl = (ws && ws.defaultTestUrl) || (json.workspaceSettings && json.workspaceSettings.defaultTestUrl) || '';
      const name = (ws && ws.name) || '';
      const isFixture = /18187/.test(targets + ' ' + defUrl) && /synthetic/i.test(name + ' ' + (ws ? (ws.purpose || '') + ' ' + (ws.backgroundSummary || '') : ''));
      result.stats.fixture = { name: name || '?', defaultTestUrlHost: (() => { try { return new URL(defUrl).host; } catch (_) { return '?'; } })(), targetsContain18187: /18187/.test(targets) };
      if (isFixture) pass('provider-fixture', 'synthetic fixture 18187');
      else fail('provider-fixture', 'not synthetic fixture (expected M8 wave synthetic / 18187)');
    } catch (e) {
      fail('provider-fixture', 'parse-error');
    }
  } catch (e) {
    fail('run-get', String((e && e.message) || e).slice(0, 200));
    return result;
  }

  // 1) GET artifacts list (public)
  let items = [];
  try {
    const { json } = await getJson(base, `/api/runs/${encodeURIComponent(id)}/artifacts`, timeoutMs);
    items = Array.isArray(json.items) ? json.items : [];
    result.files.artifacts = { endpoint: `/api/runs/${id}/artifacts`, count: items.length, names: items.map((x) => x.name) };
    const hasReport = items.some((x) => x.name === 'report.html');
    const hasResults = items.some((x) => x.name === 'results.json');
    const pngs = items.filter((x) => /^data\/.+\.png$/.test(x.name));
    result.stats.artifacts = { hasReport, hasResults, pngCount: pngs.length };
    if (hasReport && hasResults && pngs.length >= 1) pass('artifacts-list', `report.html+results.json+png*${pngs.length}`);
    else fail('artifacts-list', `missing: report=${hasReport} results=${hasResults} png=${pngs.length}`);
  } catch (e) {
    fail('artifacts-list', String((e && e.message) || e).slice(0, 200));
    return result;
  }

  const idDir = path.join(outDir, id);
  ensureDir(idDir);

  const byName = (n) => items.find((x) => x.name === n);
  const reportItem = byName('report.html');
  const resultsItem = byName('results.json');
  const pngItems = items.filter((x) => /^data\/.+\.png$/.test(x.name));

  // 2) GET report.html + results.json + PNGs (public, save to evidence)
  let reportBuf = null;
  try {
    const u = base.replace(/\/+$/, '') + reportItem.url;
    const r = await fetchBuffer(u, timeoutMs);
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    reportBuf = r.body;
    const loc = path.join(idDir, 'report.html');
    fs.writeFileSync(loc, reportBuf);
    result.files.report = { url: reportItem.url, location: loc, size: reportBuf.length, contentType: String(r.headers['content-type'] || '') };
    if (reportBuf.length > 10000 && /text\/html/i.test(String(r.headers['content-type'] || ''))) pass('report-get', `size=${reportBuf.length}`);
    else fail('report-get', `size=${reportBuf.length} ct=${String(r.headers['content-type'] || '?').slice(0, 40)}`);
  } catch (e) {
    fail('report-get', String((e && e.message) || e).slice(0, 200));
  }

  let resultsJson = null;
  try {
    const u = base.replace(/\/+$/, '') + resultsItem.url;
    const r = await fetchBuffer(u, timeoutMs);
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    resultsJson = JSON.parse(r.body.toString('utf8'));
    const loc = path.join(idDir, 'results.json');
    fs.writeFileSync(loc, r.body);
    const st = resultsJson.stats || {};
    result.files.results = { url: resultsItem.url, location: loc, size: r.body.length };
    result.stats.results = { expected: st.expected ?? null, unexpected: st.unexpected ?? null, flaky: st.flaky ?? null, skipped: st.skipped ?? null };
    if (st.expected === 1 && st.unexpected === 0) pass('results-stats', 'expected=1 unexpected=0');
    else fail('results-stats', `expected=${st.expected ?? '?'} unexpected=${st.unexpected ?? '?'}`);
  } catch (e) {
    fail('results-stats', String((e && e.message) || e).slice(0, 200));
  }

  const pngUrls = [];
  const pngFileStats = [];
  for (const p of pngItems) {
    try {
      const u = base.replace(/\/+$/, '') + p.url;
      pngUrls.push(u);
      const r = await fetchBuffer(u, timeoutMs);
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const safe = p.name.replace(/^data\//, '');
      const loc = path.join(idDir, safe);
      ensureDir(path.dirname(loc));
      fs.writeFileSync(loc, r.body);
      const chk = checkPng(r.body);
      pngFileStats.push({ name: p.name, location: loc, size: r.body.length, ok: chk.ok, width: chk.width || null, height: chk.height || null, reason: chk.reason || null });
    } catch (e) {
      pngFileStats.push({ name: p.name, ok: false, reason: String((e && e.message) || e).slice(0, 120) });
    }
  }
  result.files.pngs = pngFileStats;
  if (pngFileStats.length >= 1 && pngFileStats.every((x) => x.ok)) {
    const first = pngFileStats[0];
    pass('png-decodable', `${pngFileStats.length} png ok ${first.width}x${first.height} size=${first.size}`);
  } else {
    fail('png-decodable', pngFileStats.map((x) => `${x.name}:${x.ok ? 'ok' : ('bad-' + (x.reason || '?'))}`).join(',').slice(0, 300));
  }

  // 3) True-browser render (Chromium): Passed 1
  if (reportBuf && reportItem) {
    const reportUrl = base.replace(/\/+$/, '') + reportItem.url;
    const bc = await browserCheckReport(reportUrl, pngUrls.slice(0, 1), timeoutMs);
    result.checks['report-browser-passed1'] = bc.status === 'PASS'
      ? { status: 'PASS', detail: `Passed1 Failed0=${bc.matched.failed0} All1=${bc.matched.all1} via=${bc.from}` }
      : bc.status === 'BLOCKED'
        ? { status: 'BLOCKED', detail: `${bc.reason || '?'} ${bc.detail || bc.from || ''}`.slice(0, 300) }
        : { status: 'FAIL', detail: `no Passed1 (matched=${JSON.stringify(bc.matched || {}).slice(0, 120)}) via=${bc.from || '?'}` };
    if (bc.pngBrowser) result.stats.pngBrowser = { httpOk: bc.pngBrowser.httpOk ?? null, w: bc.pngBrowser.naturalWidth ?? null, h: bc.pngBrowser.naturalHeight ?? null };
    if (result.checks['report-browser-passed1'].status === 'FAIL') result.status = 'FAIL';
    else if (result.checks['report-browser-passed1'].status === 'BLOCKED' && result.status === 'PASS') result.status = 'BLOCKED';
  } else {
    block('report-browser-passed1', 'no report.html to render');
  }

  // 4) HTML embedded ZIP: real decompress + non-image sentinel check (counts only)
  try {
    if (!reportBuf) throw new Error('no report.html');
    const html = reportBuf.toString('utf8');
    const m = html.match(/<template id="playwrightReportBase64">data:application\/zip;base64,([A-Za-z0-9+/=]+)<\/template>/);
    if (!m) throw new Error('embedded zip template not found');
    const zipBuf = Buffer.from(m[1], 'base64');
    const zipLoc = path.join(idDir, 'embedded-report.zip');
    fs.writeFileSync(zipLoc, zipBuf);
    result.files.embeddedZip = { location: zipLoc, size: zipBuf.length };
    const y = tryRequireYauzl();
    let files;
    let method;
    if (y) {
      files = await unzipWithYauzl(y.mod, zipBuf);
      method = 'yauzl:' + y.from;
    } else {
      files = unzipWithBuiltin(zipBuf);
      method = 'builtin-zlib-inflate (yauzl absent, real decompression)';
    }
    result.stats.unzip = { method, entries: files.length, names: files.map((f) => f.fileName), totalUncompressed: files.reduce((a, f) => a + f.uncompSize, 0) };
    // Non-image entries only for leak check; images/fonts skipped (but counted).
    const nonImage = files.filter((f) => !IMAGE_EXT.has(path.extname(f.fileName).toLowerCase()));
    let leak = false;
    const perFile = [];
    for (const f of nonImage) {
      const txt = f.data.toString('utf8'); // ZIP JSON entries are UTF-8; binary-safe enough for substring counts
      const counts = {};
      for (const s of SENTINELS) {
        // Case-sensitive exact sentinel; report counts only.
        counts[s] = txt.split(s).length - 1;
        if (counts[s] > 0) leak = true;
      }
      perFile.push({ name: f.fileName, size: f.uncompSize, counts });
      // Save decompressed non-image to evidence (filenames only in console).
      const loc = path.join(idDir, 'unzipped', f.fileName);
      ensureDir(path.dirname(loc));
      fs.writeFileSync(loc, f.data);
    }
    result.stats.leakCheck = { nonImageCount: nonImage.length, skippedImageCount: files.length - nonImage.length, perFile };
    if (!leak) pass('sentinel-no-leak', `${method} nonImage=${nonImage.length} sentinelCounts=0`);
    else fail('sentinel-no-leak', `LEAK in ${perFile.filter((x) => Object.values(x.counts).some((c) => c > 0)).map((x) => x.name).join(',').slice(0, 200)}`);
  } catch (e) {
    fail('sentinel-no-leak', String((e && e.message) || e).slice(0, 250));
  }

  if (Object.values(result.checks).some((c) => c.status === 'FAIL')) result.status = 'FAIL';
  else if (Object.values(result.checks).some((c) => c.status === 'BLOCKED')) result.status = 'BLOCKED';
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  let base = args.baseUrl || defaultBaseUrl();
  let outDir = args.outDir || defaultOutDir();
  const timeoutMs = args.timeoutMs;
  // Evidence dir fallback for container (/private/tmp absent).
  try { ensureDir(outDir); } catch (_) {
    outDir = '/tmp/whippet-m8-artifacts-evidence';
    ensureDir(outDir);
  }
  const tried = [base];
  // Auto-fallback localhost <-> host.docker.internal on connection failure.
  async function probe(b) {
    try {
      const r = await fetchBuffer(b.replace(/\/+$/, '') + `/api/runs/${FORMAL_ID}`, 8000);
      return r.status === 200;
    } catch (_) { return false; }
  }
  if (!(await probe(base))) {
    const alt = base.includes('localhost') ? base.replace('localhost', 'host.docker.internal') : base.replace('host.docker.internal', 'localhost');
    if (alt !== base && (await probe(alt))) {
      base = alt;
      tried.push(alt);
    }
  }
  console.log(`[m8-blackbox] base=${base} out=${outDir} (tried: ${tried.join(' -> ')})`);
  console.log(`[m8-blackbox] model=opencode-go/muse-spark-1.3-contributor#xhigh provider=fixture(not-real-AI) read-only GET only`);

  const formal = await verifyOne(base, FORMAL_ID, 'run', outDir, timeoutMs);
  const validation = await verifyOne(base, VALIDATION_ID, 'validation', outDir, timeoutMs);

  for (const r of [formal, validation]) {
    const label = r.id === FORMAL_ID ? 'formal' : 'validation';
    console.log(`--- ${label} ${r.id} => ${r.status} ---`);
    console.log(`artifacts: ${(r.files.artifacts && r.files.artifacts.names ? r.files.artifacts.names.join(',') : '?').slice(0, 300)}`);
    if (r.files.report) console.log(`report: ${r.files.report.location} size=${r.files.report.size}`);
    if (r.files.results) console.log(`results: ${r.files.results.location} size=${r.files.results.size} expected=${r.stats.results ? r.stats.results.expected : '?'} unexpected=${r.stats.results ? r.stats.results.unexpected : '?'}`);
    if (r.files.pngs) for (const p of r.files.pngs) console.log(`png: ${p.location || p.name} size=${p.size || '?'} ${p.ok ? (`${p.width}x${p.height}`) : ('BAD-' + (p.reason || '?'))}`);
    if (r.files.embeddedZip) console.log(`embeddedZip: ${r.files.embeddedZip.location} size=${r.files.embeddedZip.size} method=${r.stats.unzip ? r.stats.unzip.method : '?'} entries=${r.stats.unzip ? r.stats.unzip.entries : '?'}`);
    if (r.stats.leakCheck) console.log(`leakCheck: nonImage=${r.stats.leakCheck.nonImageCount} skippedImage=${r.stats.leakCheck.skippedImageCount}`);
    for (const [k, v] of Object.entries(r.checks)) console.log(`check ${k}: ${v.status}${v.detail ? (' ' + String(v.detail).slice(0, 220)) : ''}`);
  }

  const summary = {
    base, outDir,
    formal: formal.status,
    validation: validation.status,
    // filenames/locations/stats only
    files: {
      formalReport: formal.files.report ? formal.files.report.location : null,
      formalResults: formal.files.results ? formal.files.results.location : null,
      validationReport: validation.files.report ? validation.files.report.location : null,
      validationResults: validation.files.results ? validation.files.results.location : null,
    },
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`[m8-blackbox] summary: formal=${formal.status} validation=${validation.status} evidence=${outDir}/summary.json`);

  if (formal.status === 'FAIL' || validation.status === 'FAIL') process.exit(1);
  if (formal.status === 'BLOCKED' || validation.status === 'BLOCKED') process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  console.error('[m8-blackbox] FATAL ' + String((e && e.stack) || e).slice(0, 500));
  process.exit(2);
});
