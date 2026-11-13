#!/usr/bin/env python3
"""t4r owned; default is offline preview. Execute ONLY after PM upgrade notice."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent
BASE = 'http://127.0.0.1:19287/api'
WORKSPACE = 'f7918b78-2171-47cf-b000-407ca05f86d3'
SEED = '21457a77-f2f7-4f84-a24f-f63f0ce53497'
STATE = ROOT / 'm10_shop_t4t_recovery.result.json'
SLUGS = {s: 'shop-t4r-20261114-' + s for s in ('search', 'order', 'verify')}


def proposal():
    old = json.loads((ROOT / 'm10_shop_usecase_plan.result.json').read_text())
    content = old['messageRequest']['content']
    content += '''\n本輪覆蓋與精確要求：保留舊 Plan，不修訂或確認舊 Plan。三個 create 使用下列新 slug：'''
    content += json.dumps(SLUGS, ensure_ascii=False)
    content += '''。hidden productId 絕不 fill、不用 evaluate 改 DOM：定位相符商品的表單，僅以 toHaveValue 核對既有 hidden input[name=productId] 等於當次 productId；只 fill input[name=quantity] 為 2。
每個 create 的 module.description 必須各自保存完整獨立 harness 前置，不得寫「同 search」省略：import {loginAs} from 'whippet/login'; await page.goto('http://host.docker.internal:19387/login'); await loginAs(page,'7da20730-874d-41ff-aea0-7a5650f37c12','input[name=username]','input[name=password]','button[type=submit]'); await expect(page).toHaveURL('http://host.docker.internal:19387/products'); await expect(page.getByTestId('account-state')).toHaveText('Authenticated synthetic customer')。
search harness 登入後測搜尋；order harness 登入後自行搜尋取得當次商品，再呼叫 order 模組建立訂單；verify harness 登入後自行搜尋並用表單建立當次新 UUID 訂單，再呼叫 verify。harness 僅 import 自己 Module，不 import login seed 或其他 Module；Module 主體不互相 import。組合時四 Stage 沿用同一 page session。請把路由、selectors、hidden 規則與完整登入前置保存在各自 description。只提出 draft Plan，不確認、不排程、不發布，不調整 skills 或預算。'''
    # Remove the old ambiguous order instruction from the inherited request.
    content = content.replace('下單表單含 hidden input[name=productId]、input[name=quantity]',
                              '下單表單含僅核對 value 的 hidden input[name=productId]、可填寫的 input[name=quantity]')
    return {'base': BASE, 'owner': 't4r', 'workspaceId': WORKSPACE,
            'seedVersionId': SEED, 'slugs': SLUGS, 'content': content}


def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'HTTP {exc.code}; stop, no automatic retry') from None
    except Exception:
        raise RuntimeError('Request outcome uncertain; inspect saved intent, never resubmit automatically') from None


def save(state):
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(STATE)


def submit():
    state = proposal()
    # Exclusive reservation BEFORE any POST; any partial failure requires PM review.
    with STATE.open('x') as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    state['pendingOperation'] = 'create-usecase'
    save(state)
    test = request(f'/workspaces/{WORKSPACE}/tests', {
        'kind': 'usecase',
        'name': 't4r 20261114 shop four-stage review',
        'description': 'Fresh post-019 planner proposal; PM review before confirm'})
    state['testId'] = test['id']
    state['pendingOperation'] = 'open-session'
    save(state)
    session = request(f"/tests/{test['id']}/editing-session", {})['session']
    state['editingSessionId'] = session['id']
    save(state)
    draft = request(f"/tests/{test['id']}/draft")
    body = {'editingSessionId': session['id'], 'revision': draft['revision'],
            'content': state['content']}
    state['messageRequest'] = body
    state['pendingOperation'] = 'planner-submission-once'
    save(state)
    result = request(f"/tests/{test['id']}/messages", body)
    state['plannerRunId'] = result['run']['id']
    state['pendingOperation'] = None
    state['stopReason'] = 'Await planner completion and PM review; no confirm capability'
    save(state)
    print(json.dumps({'testId': test['id'], 'plannerRunId': state['plannerRunId']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['preview', 'submit'], nargs='?', default='preview')
    parser.add_argument('--pm-upgrade-complete', action='store_true',
                        help='Only after actual PM notice; this flag is not evidence of upgrade')
    args = parser.parse_args()
    if args.command == 'preview':
        print(json.dumps(proposal(), ensure_ascii=False, indent=2))
    elif not args.pm_upgrade_complete:
        parser.error('PM upgrade completion notice required; no API request sent')
    else:
        submit()
