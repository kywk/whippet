#!/usr/bin/env node
// M5 Workspace 設定黑箱（隔離驗收）：需明確 WEB_URL 且 M5_ISOLATED=1，否則拒跑。
// 登入→草稿未存編輯→開設定→GET 初值→加站→存檔(PATCH 200)→未存保留門→reload 確認→no-op 200 且 revision 不變→舊 revision 409→未知欄位 400→finally GET 最新 revision 回復＋GET 驗證。
// 設定 PATCH 路徑與請求形狀由 UI 實際送出的請求推導；初值/最新值一律 GET /api/workspaces/:id，不猜其他路徑。
// 同源 API 只寫死 GET /api/workspaces 與 /api/workspaces/:id（形狀不符即失敗）。無 AI/Run/發佈/驗證點擊，不印 JSON 原文。
'use strict';

const path = require('node:path');

const PW_MODULE = process.env.WHIPPET_PLAYWRIGHT_MODULE || '/opt/whippet/worker/node_modules/playwright';
const WEB_URL = (process.env.WEB_URL || '').trim();
const EV_DIR = process.env.WHIPPET_EVIDENCE_DIR || '/tmp';
const OVERALL_MS = 180 * 1000;
const t0 = Date.now();
const EXAMPLE_URL = 'http://example.test';
const SYNTH_NAME = 'm5-synthetic-' + Date.now();
const UNSAVED_MARK = '// m5-unsaved-retained';

function checkOverall(step) {
  if (Date.now() - t0 > OVERALL_MS) throw new Error(`FAIL overall-timeout step=${step}`);
}

// 設定物件只接受頂層或 settings/workspace 包裝含 revision/sites/defaultTestUrl/timeoutMs；否則列出頂層鍵名後失敗，不猜。
function pickSettings(j, label) {
  const root = j && typeof j === 'object' ? j : null;
  const cand = root
    ? (root.revision !== undefined ? root
      : (root.settings && typeof root.settings === 'object' ? root.settings
        : (root.workspace && typeof root.workspace === 'object' ? root.workspace : null)))
    : null;
  if (!cand || cand.revision === undefined || !Array.isArray(cand.sites)
    || !('defaultTestUrl' in cand) || !('timeoutMs' in cand)) {
    const keys = root ? Object.keys(root).slice(0, 10).join(',') : '(empty)';
    throw new Error(`FAIL ${label} 形狀不符（要 revision/sites/defaultTestUrl/timeoutMs，見鍵: ${keys}）`);
  }
  cand.sites.forEach((s, i) => {
    if (!s || typeof s.name !== 'string' || typeof s.url !== 'string') {
      throw new Error(`FAIL ${label} sites[${i}] 缺 name/url 字串欄位`);
    }
  });
  return cand;
}

async function main() {
  if (!WEB_URL) throw new Error('FAIL 缺少明確 WEB_URL（拒跑，避免改到現有環境）');
  if (process.env.M5_ISOLATED !== '1') throw new Error('FAIL 需 M5_ISOLATED=1 才允許執行（隔離部署）');

  const pw = require(PW_MODULE);
  const { chromium } = pw;
  const launchArgs = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.WHIPPET_CHROMIUM_PATH) launchArgs.executablePath = process.env.WHIPPET_CHROMIUM_PATH;
  const browser = await chromium.launch(launchArgs);

  let page = null;
  let api = null;
  let wsId = null;
  let saveUrl = null;
  let saveReqBody = null;
  let latestRev = undefined;
  let snap0 = null;

  const shot = async (name) => {
    const p = path.join(EV_DIR, name);
    await page.screenshot({ path: p, fullPage: true });
    console.log(`shot ${p}`);
  };

  async function doPatch(body, label) {
    checkOverall(label);
    const r = await api.patch(saveUrl, { data: body });
    const st = r.status();
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (st >= 200 && st < 300 && j && j.revision !== undefined) latestRev = j.revision;
    return { st };
  }

  async function getSettings(label) {
    checkOverall(label);
    const g = await api.get(`${WEB_URL}/api/workspaces/${wsId}`);
    if (g.status() !== 200) throw new Error(`FAIL ${label} http=${g.status()}`);
    let gj = null;
    try { gj = await g.json(); } catch { gj = null; }
    return pickSettings(gj, label);
  }

  try {
    const context = await browser.newContext();
    page = await context.newPage();
    api = page.request;

    checkOverall('workspaces');
    const w = await api.get(`${WEB_URL}/api/workspaces`);
    if (w.status() !== 200) throw new Error(`FAIL workspaces http=${w.status()}`);
    let wj = null;
    try { wj = await w.json(); } catch { wj = null; }
    if (!wj || !Array.isArray(wj.items) || wj.items.length < 1 || !wj.items[0].id) {
      throw new Error('FAIL workspaces 形狀不符（要 {items:[{id}]}，不猜）');
    }
    wsId = wj.items[0].id;
    console.log(`PASS workspaces items=${wj.items.length}`);

    checkOverall('settings-initial');
    const init = await getSettings('settings-initial');
    snap0 = {
      revision: init.revision,
      sites: init.sites.map((s) => ({ ...s })),
      defaultTestUrl: init.defaultTestUrl,
      timeoutMs: init.timeoutMs,
    };
    console.log(`PASS settings-initial sites=${snap0.sites.length}`);

    checkOverall('login');
    await page.goto(WEB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn.click();
    await page.getByRole('button', { name: 'Workspace 設定', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS login');

    checkOverall('unsaved-edit');
    const draftArea = page.locator('textarea#draft-script');
    try {
      await draftArea.waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      throw new Error('FAIL 缺 textarea#draft-script（不猜新 locator）');
    }
    const draftOrig = await draftArea.inputValue();
    const draftFilled = `${draftOrig}\n${UNSAVED_MARK}`;
    await draftArea.fill(draftFilled);
    console.log('PASS unsaved-edit');

    checkOverall('open-settings');
    const settingsBtn = page.getByRole('button', { name: 'Workspace 設定', exact: true });
    await settingsBtn.waitFor({ state: 'visible', timeout: 30000 });
    await settingsBtn.click();
    await page.getByRole('region', { name: 'Workspace 設定' }).waitFor({ state: 'visible', timeout: 30000 });
    await page.getByLabel('預設測試 URL（選填）', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    console.log('PASS settings-open');
    await shot('m5-settings-open.png');

    checkOverall('add-site');
    const addBtn = page.getByRole('button', { name: '新增網站', exact: true });
    await addBtn.waitFor({ state: 'visible', timeout: 30000 });
    await addBtn.click();
    const nameField = page.getByLabel('網站名稱 1', { exact: true });
    const urlField = page.getByLabel('網站 URL 1', { exact: true });
    if (await nameField.count() !== 1) throw new Error('FAIL 網站名稱 1 非唯一');
    if (await urlField.count() !== 1) throw new Error('FAIL 網站 URL 1 非唯一');
    await nameField.first().fill(SYNTH_NAME);
    await urlField.first().fill(EXAMPLE_URL);
    await page.getByLabel('預設測試 URL（選填）', { exact: true }).first().fill(EXAMPLE_URL);
    await page.getByLabel('執行逾時（毫秒）', { exact: true }).first().fill('65000');

    checkOverall('save');
    const saveBtn = page.getByRole('button', { name: '儲存 Workspace 設定', exact: true });
    await saveBtn.waitFor({ state: 'visible', timeout: 30000 });
    const respP = page.waitForResponse(
      (r) => r.request().method() === 'PATCH',
      { timeout: 30000 },
    );
    await saveBtn.click();
    const resp = await respP;
    if (resp.status() !== 200) throw new Error(`FAIL save http=${resp.status()} expected=200`);
    saveUrl = resp.request().url();
    try { saveReqBody = resp.request().postDataJSON(); } catch { saveReqBody = null; }
    if (!saveReqBody || saveReqBody.revision === undefined) {
      throw new Error('FAIL save 請求缺 revision（形狀不符，不猜）');
    }
    let saveJson = null;
    try { saveJson = await resp.json(); } catch { saveJson = null; }
    if (!saveJson || saveJson.revision === undefined) {
      throw new Error('FAIL save 回應缺 revision（形狀不符，不猜）');
    }
    latestRev = saveJson.revision;
    const revAfterSave = latestRev;
    console.log('PASS save');
    await shot('m5-settings-saved.png');

    checkOverall('unsaved-retained');
    await page.getByText('Workspace 設定已變更，本機未儲存的腳本已保留。').first().waitFor({ state: 'visible', timeout: 30000 });
    const draftNow = await page.locator('textarea#draft-script').inputValue();
    if (draftNow !== draftFilled) throw new Error('FAIL 未儲存腳本未保留');
    for (const nm of ['儲存草稿', '驗證此 revision']) {
      const b = page.getByRole('button', { name: nm, exact: true });
      if (await b.count() !== 1) throw new Error(`FAIL 按鈕非唯一: ${nm}`);
      if (!(await b.first().isDisabled())) throw new Error(`FAIL 應 disabled: ${nm}`);
    }
    const pubBtns = page.getByRole('button', { name: /^確認發佈 revision/ });
    if (await pubBtns.count() < 1) throw new Error('FAIL 缺確認發佈按鈕');
    if (!(await pubBtns.first().isDisabled())) throw new Error('FAIL 確認發佈應 disabled');
    const reloadDraftBtn = page.getByRole('button', { name: '重新載入草稿', exact: true });
    if (await reloadDraftBtn.count() !== 1) throw new Error('FAIL 重新載入草稿非唯一');
    if (!(await reloadDraftBtn.first().isEnabled())) throw new Error('FAIL 重新載入草稿應 enabled');
    console.log('PASS unsaved-retained');
    await shot('m5-unsaved-retained.png');

    checkOverall('reload-confirm');
    page.on('dialog', (d) => { d.accept().catch(() => {}); });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const loginBtn2 = page.getByRole('button', { name: '以開發管理員登入', exact: true });
    await loginBtn2.waitFor({ state: 'visible', timeout: 30000 });
    await loginBtn2.click();
    const settingsBtn2 = page.getByRole('button', { name: 'Workspace 設定', exact: true });
    await settingsBtn2.waitFor({ state: 'visible', timeout: 30000 });
    await settingsBtn2.click();
    await page.getByRole('region', { name: 'Workspace 設定' }).waitFor({ state: 'visible', timeout: 30000 });
    await page.getByLabel('預設測試 URL（選填）', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    const vName = await page.getByLabel('網站名稱 1', { exact: true }).first().inputValue();
    const vUrl = await page.getByLabel('網站 URL 1', { exact: true }).first().inputValue();
    const vDef = await page.getByLabel('預設測試 URL（選填）', { exact: true }).first().inputValue();
    const vTo = await page.getByLabel('執行逾時（毫秒）', { exact: true }).first().inputValue();
    if (vName !== SYNTH_NAME) throw new Error('FAIL reload 網站名稱不一致');
    if (vUrl !== EXAMPLE_URL) throw new Error('FAIL reload 網站 URL 不一致');
    if (vDef !== EXAMPLE_URL) throw new Error('FAIL reload 預設 URL 不一致');
    if (vTo !== '65000') throw new Error('FAIL reload 逾時不一致');
    console.log('PASS reload-confirm');
    await shot('m5-settings-reloaded.png');

    checkOverall('noop-unchanged');
    const noop = await doPatch({ ...saveReqBody, revision: latestRev }, 'noop');
    if (noop.st !== 200) throw new Error(`FAIL noop http=${noop.st} expected=200`);
    if (latestRev !== revAfterSave) throw new Error('FAIL noop 推進了 revision（依契約不應增加）');
    console.log('PASS noop-200-rev-unchanged');

    checkOverall('stale-revision');
    if (saveReqBody.revision === latestRev) {
      throw new Error('FAIL save 未推進 revision，無法做過期檢查');
    }
    const stale = await doPatch({ ...saveReqBody, revision: saveReqBody.revision }, 'stale-revision');
    if (stale.st !== 409) throw new Error(`FAIL stale-revision http=${stale.st} expected=409`);
    console.log('PASS stale-409');

    checkOverall('unknown-key');
    const unk = await doPatch({ ...saveReqBody, revision: latestRev, __m5_unknown_key__: 1 }, 'unknown-key');
    if (unk.st !== 400) throw new Error(`FAIL unknown-key http=${unk.st} expected=400`);
    console.log('PASS unknownkey-400');

    console.log('PASS all');
  } catch (e) {
    try {
      if (page) await page.screenshot({ path: path.join(EV_DIR, 'm5-settings-fail.png'), fullPage: true });
    } catch {}
    console.error(`FAIL: ${(e && e.message) || e}`);
    process.exitCode = 1;
    throw e;
  } finally {
    if (saveUrl && snap0 && api && wsId) {
      try {
        const cur = await getSettings('restore-get');
        const body = {
          revision: cur.revision,
          sites: snap0.sites.map((s) => ({ ...s })),
          defaultTestUrl: snap0.defaultTestUrl,
          timeoutMs: snap0.timeoutMs,
        };
        const r = await api.patch(saveUrl, { data: body });
        if (r.status() !== 200) throw new Error(`restore http=${r.status()}`);
        const cur2 = await getSettings('restore-verify');
        if (JSON.stringify(cur2.sites) !== JSON.stringify(snap0.sites)
          || cur2.defaultTestUrl !== snap0.defaultTestUrl
          || String(cur2.timeoutMs) !== String(snap0.timeoutMs)) {
          throw new Error('restore-verify 值不一致');
        }
        console.log('PASS restore');
      } catch (re) {
        console.error(`FAIL restore: ${(re && re.message) || re}`);
        process.exitCode = 1;
      }
    }
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`FAIL: ${(e && e.message) || e}`);
  process.exit(process.exitCode || 1);
});
