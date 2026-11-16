#!/usr/bin/env python3
"""M11 final UI-only handoff. Run only after PM declares W7 pushed and READY.

Commands, in order: r5-setup, b-summary, b-publish, c-confirm, c-summary,
c-publish. Agent input signals are regular files containing exactly ``true``:
b-validation-done, b-agent-done, c-plan-ready, c-validation-done, c-agent-done. After real UI review, QA
adds b-reviewed, c-plan-reviewed, and c-batch-reviewed, respectively.
Harness output signals use the same format and live in ROOT/ui-t66. Persisted
write intents are never automatically retried. All product interaction is DOM.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import time
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

from playwright.sync_api import sync_playwright

ROOT = Path('/private/tmp/whippet-m11-final-t52-r5')
WEB = 'http://127.0.0.1:19787'
CDP = 'http://127.0.0.1:19790'
WORKSPACE = 'M11 Final MCP E2E'
NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$')


class Stop(Exception):
    def __init__(self, reason):
        self.reason = reason


def require(value, reason):
    if not value:
        raise Stop(reason)


def read_signal(path):
    try:
        st = path.lstat()
        require(stat.S_ISREG(st.st_mode) and st.st_size <= 8, 'SIGNAL_INVALID')
        return path.read_bytes().strip() == b'true'
    except FileNotFoundError:
        return False


def emit_signal(path):
    if path.exists():
        require(read_signal(path), 'SIGNAL_INVALID')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(b'true\n')
        f.flush()
        os.fsync(f.fileno())


def save(root, data):
    tmp = root / 'checkpoint.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w', encoding='ascii') as f:
        json.dump(data, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, root / 'checkpoint.json')
    fd = os.open(root, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def checkpoint(root):
    path = root / 'checkpoint.json'
    try:
        require(stat.S_ISREG(path.lstat().st_mode), 'CHECKPOINT_INVALID')
        data = json.loads(path.read_text(encoding='ascii'))
        require(isinstance(data, dict) and data.get('version') == 1, 'CHECKPOINT_INVALID')
        return data
    except FileNotFoundError:
        return {'version': 1}


def intent(root, state, key):
    require(not state.get(key), 'WRITE_OUTCOME_UNKNOWN')
    state[key] = 'PENDING'
    save(root, state)


def done(root, state, key):
    state[key] = 'DONE'
    save(root, state)


def page_for(browser, create):
    pages = [p for c in browser.contexts for p in c.pages
             if p.url.split('?', 1)[0].rstrip('/') == WEB
             and p.evaluate("window.name === 'm11-main-qa-t66'")]
    require(len(pages) == 1, 'BROWSER_PAGE')
    page = pages[0]
    require(not page.locator('.mock-banner, .mock-note').count(), 'MOCK')
    require(not page.get_by_role('heading', name='Whippet').count(), 'LOGIN')
    return page


def workspace(page):
    combo = page.get_by_role('combobox', name='Workspace')
    combo.select_option(label=WORKSPACE)
    require(combo.locator('option:checked').inner_text().strip() == WORKSPACE, 'WORKSPACE')


def select_test(page, name):
    require(bool(NAME.fullmatch(name or '')), 'INPUT')
    # Use the in-app list refresh: a full page reload loses the in-memory UI login.
    workspace(page)
    page.get_by_role('button', name='重新載入測試列表').click()
    items = page.locator('.test-item').filter(has=page.locator('.test-name > span:first-child', has_text=re.compile('^' + re.escape(name) + '$')))
    items.first.wait_for(timeout=20000)
    require(items.count() == 1, 'TEST_NOT_UNIQUE')
    items.click()
    page.get_by_role('tab', name='對話編輯').click()
    page.locator('#side-panel-script').wait_for(state='attached', timeout=20000)


def script_info(page):
    page.get_by_role('tab', name='腳本').click()
    panel = page.locator('#side-panel-script')
    revision_text = panel.locator('.meta-list div').filter(has=page.locator('dt', has_text='revision')).locator('dd').inner_text()
    match = re.match(r'\s*(\d+)\s*·\s*已儲存', revision_text)
    require(bool(match), 'DRAFT_UNSAVED')
    source = panel.locator('.meta-list div').filter(has=page.locator('dt', has_text='來源')).locator('dd').inner_text().strip()
    return int(match.group(1)), source


def report(page, run_id):
    # Match the exact formal validation row and open its real UI report link.
    require(str(uuid.UUID(run_id)) == run_id, 'INPUT')
    page.get_by_role('tab', name='紀錄與畫面').click()
    row = page.locator(f'tr[data-run-id="{run_id}"]')
    if row.count() == 0:
        page.locator('#side-panel-runs').get_by_role('button', name='重新整理紀錄').click()
    row.wait_for(timeout=20000)
    require(row.locator('.status-badge.success').count() == 1, 'VALIDATION')
    require(row.get_by_text(re.compile(r'^草稿驗證 · r\d+$')).count() == 1, 'VALIDATION')
    link = row.get_by_role('link', name='開啟報告')
    require(link.count() == 1, 'REPORT')
    href = link.get_attribute('href') or ''
    require(f'/runs/{run_id}/artifacts/report.html' in href, 'REPORT')
    with page.expect_popup(timeout=15000) as popup:
        link.click()
    view = popup.value
    try:
        view.wait_for_load_state('domcontentloaded', timeout=20000)
        view.locator('#root').wait_for(timeout=20000)
        require(view.title() == 'Playwright Test Report', 'REPORT')
    finally:
        view.close()


def validation_panel(page, revision, run_id):
    page.get_by_role('tab', name='驗證與發佈').click()
    panel = page.locator('#side-panel-publish')
    refresh = panel.get_by_role('button', name='重新整理狀態')
    if refresh.is_enabled():
        refresh.click()
    condition = panel.locator('.conditions li.ok').filter(has_text=f'revision {revision} 驗證通過')
    condition.wait_for(timeout=20000)
    require(panel.locator('.conditions li.ok').filter(has_text='報告已保存').count() == 1, 'REPORT')
    link = panel.get_by_role('link', name='查看草稿驗證報告')
    require(link.count() == 1 and f'/runs/{run_id}/artifacts/report.html' in (link.get_attribute('href') or ''), 'REPORT')
    report(page, run_id)
    page.get_by_role('tab', name='驗證與發佈').click()
    return panel


def publish_result(page):
    page.get_by_role('tab', name='概覽').wait_for(timeout=30000)
    page.locator('.chip.ok', has_text='已發佈').wait_for(timeout=30000)


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('step', choices=['r5-setup', 'b-summary', 'b-publish', 'b-reopen-red', 'b-repair-summary', 'b-repair-publish', 'c-confirm', 'c-summary', 'c-publish', 'c-repair-confirm', 'c-repair-summary', 'c-repair-publish', 'c-setup-confirm', 'c-setup-summary', 'c-setup-publish', 'c-plan7-confirm', 'c-plan7-summary', 'c-plan7-publish'])
    parser.add_argument('--test-name')
    parser.add_argument('--validation-run-id')
    parser.add_argument('--plan-revision', type=int)
    parser.add_argument('--module-version-id')
    args = parser.parse_args()
    st = ROOT.lstat()
    require(stat.S_ISDIR(st.st_mode) and not ROOT.is_symlink(), 'ROOT')
    root = ROOT / 'ui-t66'
    root.mkdir(mode=0o700, exist_ok=True)
    require(stat.S_ISDIR(root.lstat().st_mode) and not root.is_symlink(), 'ROOT')
    lock = os.open(root / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state = checkpoint(root)
    signal_map = {'b-summary': 'b-validation-done', 'b-publish': 'b-agent-done', 'b-reopen-red': 'abi-deploy-ready', 'b-repair-summary': 'b-repair-green', 'b-repair-publish': 'b-repair-agent-done', 'c-confirm': 'c-plan-ready', 'c-summary': 'c-validation-done', 'c-publish': 'c-agent-done', 'c-repair-confirm': 'c-repair-plan-ready', 'c-repair-summary': 'c-repair-validation-done', 'c-repair-publish': 'c-repair-agent-done', 'c-setup-confirm': 'c-setup-plan-ready', 'c-setup-summary': 'c-setup-validation-done', 'c-setup-publish': 'c-setup-agent-done', 'c-plan7-confirm': 'c-plan7-ready', 'c-plan7-summary': 'c-plan7-validation-done', 'c-plan7-publish': 'c-plan7-agent-done'}
    if args.step in signal_map:
        require(read_signal(root / signal_map[args.step]), 'WAIT_AGENT')
    review = {'b-publish': 'b-reviewed', 'b-repair-publish': 'b-repair-reviewed', 'c-confirm': 'c-plan-reviewed', 'c-publish': 'c-batch-reviewed', 'c-repair-confirm': 'c-repair-plan-reviewed', 'c-repair-publish': 'c-repair-batch-reviewed', 'c-setup-confirm': 'c-setup-plan-reviewed', 'c-setup-publish': 'c-setup-batch-reviewed', 'c-plan7-confirm': 'c-plan7-reviewed', 'c-plan7-publish': 'c-plan7-batch-reviewed'}
    if args.step in review:
        require(read_signal(root / review[args.step]), 'WAIT_REVIEW')
    previous = {'b-summary': 'r5_setup', 'b-publish': 'r5_setup', 'b-reopen-red': 'b_publish', 'b-repair-summary': 'b_red', 'b-repair-publish': 'b_repair_summary', 'c-confirm': 'b_publish', 'c-summary': 'c_confirm', 'c-publish': 'c_summary', 'c-repair-confirm': 'b_repair_publish', 'c-repair-summary': 'c_repair_confirm', 'c-repair-publish': 'c_repair_summary', 'c-setup-confirm': 'c_repair_confirm', 'c-setup-summary': 'c_setup_confirm', 'c-setup-publish': 'c_setup_summary', 'c-plan7-confirm': 'c_repair_confirm', 'c-plan7-summary': 'c_plan7_confirm', 'c-plan7-publish': 'c_plan7_summary'}
    if args.step in previous:
        require(state.get(previous[args.step]) == 'DONE', 'WAIT_PREVIOUS')
    if args.step in ('b-summary', 'b-publish', 'b-repair-summary', 'b-repair-publish', 'c-summary', 'c-publish', 'c-repair-summary', 'c-repair-publish', 'c-setup-summary', 'c-setup-publish', 'c-plan7-summary', 'c-plan7-publish'):
        require(bool(args.validation_run_id), 'INPUT')
        require(str(uuid.UUID(args.validation_run_id)) == args.validation_run_id, 'INPUT')
    if args.step.startswith('b-') or args.step.startswith('c-'):
        require(bool(NAME.fullmatch(args.test_name or '')), 'INPUT')
        kind = args.step[0]
        old = state.get(kind + '_name')
        require(old is None or old == args.test_name, 'TEST_MISMATCH')
        if old is None:
            state[kind + '_name'] = args.test_name
            save(root, state)
    completed = {'b-publish': ('b_publish', 'b-published', 'B_PUBLISHED'), 'c-confirm': ('c_confirm', 'c-confirmed', 'C_CONFIRMED'), 'c-summary': ('c_summary', 'c-summary-ready', 'C_SUMMARY_READY'), 'c-publish': ('c_publish', 'c-published', 'C_PUBLISHED'), 'b-repair-publish': ('b_repair_publish', 'b-repair-published', 'B_REPAIR_PUBLISHED'), 'c-repair-confirm': ('c_repair_confirm', 'c-repair-confirmed', 'C_REPAIR_CONFIRMED'), 'c-repair-summary': ('c_repair_summary', 'c-repair-summary-ready', 'C_REPAIR_SUMMARY_READY'), 'c-repair-publish': ('c_repair_publish', 'c-repair-published', 'C_REPAIR_PUBLISHED'), 'c-setup-confirm': ('c_setup_confirm', 'c-setup-confirmed', 'C_SETUP_CONFIRMED'), 'c-setup-summary': ('c_setup_summary', 'c-setup-summary-ready', 'C_SETUP_SUMMARY_READY'), 'c-setup-publish': ('c_setup_publish', 'c-setup-published', 'C_SETUP_PUBLISHED'), 'c-plan7-confirm': ('c_plan7_confirm', 'c-plan7-confirmed', 'C_PLAN7_CONFIRMED'), 'c-plan7-summary': ('c_plan7_summary', 'c-plan7-summary-ready', 'C_PLAN7_SUMMARY_READY'), 'c-plan7-publish': ('c_plan7_publish', 'c-plan7-published', 'C_PLAN7_PUBLISHED')}
    if args.step in completed:
        key, signal, result = completed[args.step]
        if state.get(key) == 'DONE':
            emit_signal(root / signal)
            print('STATE=' + result)
            return
    if args.step == 'c-publish':
        require(state.get('c_validation_run_id') == args.validation_run_id, 'VALIDATION_MISMATCH')
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(CDP)
        page = page_for(browser, False)
        if args.step == 'r5-setup':
            if state.get('r5_setup') == 'DONE':
                emit_signal(root / 'r5-ready')
                print('STATE=R5_READY')
                return
            workspace(page)
            page.get_by_role('button', name='Workspace 設定').click()
            page.get_by_role('tab', name='正式設定與能力').click()
            settings = page.get_by_role('form', name='AI 撰寫引擎設定')
            settings.wait_for(timeout=15000)
            if settings.get_by_text('目前：外部 Agent').count() and state.get('engine_write') == 'PENDING':
                done(root, state, 'engine_write')
            if not settings.get_by_text('目前：外部 Agent').count():
                intent(root, state, 'engine_write')
                settings.get_by_role('radio', name='外部 Agent').check()
                settings.get_by_role('button', name='儲存引擎設定').click()
                settings.get_by_text('目前：外部 Agent').wait_for(timeout=15000)
                done(root, state, 'engine_write')
            page.get_by_role('button', name='返回測試工作台').click()
            state['a_source'] = 'R3_PASSED'
            state['r5_setup'] = 'DONE'
            save(root, state)
            emit_signal(root / 'r5-ready')
            print('STATE=R5_READY')
        elif args.step == 'b-summary':
            select_test(page, args.test_name)
            revision, source = script_info(page)
            require(source == 'AI 修改', 'DRAFT')
            panel = validation_panel(page, revision, args.validation_run_id)
            summary = panel.locator('.acceptance-summary')
            summary.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).wait_for(timeout=30000)
            state['b_summary'] = 'DONE'
            state['b_validation_run_id'] = args.validation_run_id
            save(root, state)
            emit_signal(root / 'b-summary-ready')
            print('STATE=B_SUMMARY_READY')
        elif args.step == 'b-publish':
            if state.get('b_validation_run_id'):
                require(state['b_validation_run_id'] == args.validation_run_id, 'VALIDATION_MISMATCH')
            select_test(page, args.test_name)
            revision, source = script_info(page)
            require(source == 'AI 修改', 'DRAFT')
            panel = validation_panel(page, revision, args.validation_run_id)
            summary = panel.locator('.acceptance-summary')
            require(summary.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            require(summary.get_by_text('驗收摘要已就緒', exact=False).count() == 1, 'SUMMARY')
            panel.get_by_role('checkbox', name=re.compile('我已檢視驗證報告與驗收摘要')).check()
            intent(root, state, 'b_publish')
            panel.get_by_role('button', name=f'確認發佈 revision {revision}').click()
            publish_result(page)
            done(root, state, 'b_publish')
            emit_signal(root / 'b-published')
            print('STATE=B_PUBLISHED')
        elif args.step == 'b-reopen-red':
            if state.get('b_red') == 'DONE':
                emit_signal(root / 'b-red')
                print('STATE=B_RED')
                print('REVISION=' + str(state['b_red_revision']))
                print('VALIDATION_RUN_ID=' + state['b_red_run_id'])
                return
            workspace(page)
            if state.get('b_reopen') != 'DONE':
                require(not state.get('b_reopen'), 'WRITE_OUTCOME_UNKNOWN')
                page.get_by_role('button', name='重新載入測試列表').click()
                items = page.locator('.test-item').filter(has=page.locator('.test-name > span:first-child', has_text=re.compile('^' + re.escape(args.test_name) + '$')))
                items.first.wait_for(timeout=20000)
                require(items.count() == 1, 'TEST_NOT_UNIQUE')
                items.click()
                page.get_by_role('tab', name='概覽').click()
                page.locator('.chip.ok', has_text='已發佈').wait_for(timeout=20000)
                published = page.get_by_role('textbox', name='正式版本腳本（唯讀）').input_value()
                require(bool(published), 'DRAFT')
                state['b_source_hash'] = hashlib.sha256(published.encode()).hexdigest()
                intent(root, state, 'b_reopen')
                page.get_by_role('tab', name='對話編輯').click()
                revision, _ = script_info(page)
                draft = page.locator('#draft-script').input_value()
                require(hashlib.sha256(draft.encode()).hexdigest() == state['b_source_hash'], 'DRAFT_CHANGED')
                require(bool(page.locator('#module-harness').input_value().strip()), 'HARNESS')
                state['b_red_revision'] = revision
                done(root, state, 'b_reopen')
            else:
                revision, _ = script_info(page)
                require(revision == state['b_red_revision'], 'DRAFT_CHANGED')
                require(hashlib.sha256(page.locator('#draft-script').input_value().encode()).hexdigest() == state['b_source_hash'], 'DRAFT_CHANGED')
                require(bool(page.locator('#module-harness').input_value().strip()), 'HARNESS')
            page.get_by_role('tab', name='驗證與發佈').click()
            panel = page.locator('#side-panel-publish')
            if not state.get('b_red_validation'):
                button = panel.get_by_role('button', name='驗證此 revision')
                require(button.is_enabled(), 'VALIDATION')
                intent(root, state, 'b_red_validation')
                button.click()
            # PENDING is reconciled only from this session's validation rows, never resent.
            page.get_by_role('tab', name='紀錄與畫面').click()
            deadline = time.monotonic() + 300
            run_id = state.get('b_red_run_id')
            while time.monotonic() < deadline:
                rows = page.locator('#side-panel-runs tr[data-run-id]').filter(has_text=f'草稿驗證 · r{revision}')
                if rows.count() == 1:
                    row = rows.first
                    candidate = row.get_attribute('data-run-id') or ''
                    require(str(uuid.UUID(candidate)) == candidate, 'VALIDATION')
                    require(run_id is None or run_id == candidate, 'VALIDATION_MISMATCH')
                    if run_id is None:
                        state['b_red_run_id'] = candidate
                        save(root, state)
                        run_id = candidate
                    if row.locator('.status-badge.danger').count() == 1:
                        state['b_red_validation'] = 'DONE'
                        state['b_red'] = 'DONE'
                        save(root, state)
                        emit_signal(root / 'b-red')
                        print('STATE=B_RED')
                        print('FAILURE=VALIDATION_FAILED')
                        print('REVISION=' + str(revision))
                        print('VALIDATION_RUN_ID=' + run_id)
                        return
                    require(not row.locator('.status-badge.success').count(), 'UNEXPECTED_GREEN')
                elif rows.count() > 1:
                    raise Stop('VALIDATION_NOT_UNIQUE')
                page.wait_for_timeout(2000)
            raise Stop('VALIDATION_PENDING')
        elif args.step == 'b-repair-summary':
            select_test(page, args.test_name)
            script_info(page)  # Refuse to discard unsaved local edits.
            page.get_by_role('button', name='重新載入草稿').click()
            revision, source = script_info(page)
            require(revision > state['b_red_revision'] and source == 'AI 修改', 'DRAFT')
            panel = validation_panel(page, revision, args.validation_run_id)
            panel.locator('.acceptance-summary').get_by_text('此摘要 Run 來源：外部 Agent', exact=False).wait_for(timeout=30000)
            state['b_repair_revision'] = revision
            state['b_repair_run_id'] = args.validation_run_id
            state['b_repair_summary'] = 'DONE'
            save(root, state)
            emit_signal(root / 'b-repair-summary-ready')
            print('STATE=B_REPAIR_SUMMARY_READY')
        elif args.step == 'b-repair-publish':
            require(state.get('b_repair_run_id') == args.validation_run_id, 'VALIDATION_MISMATCH')
            select_test(page, args.test_name)
            revision, source = script_info(page)
            require(revision == state['b_repair_revision'] and source == 'AI 修改', 'DRAFT')
            panel = validation_panel(page, revision, args.validation_run_id)
            summary = panel.locator('.acceptance-summary')
            require(summary.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            require(summary.get_by_text('驗收摘要已就緒', exact=False).count() == 1, 'SUMMARY')
            panel.get_by_role('checkbox', name=re.compile('我已檢視驗證報告與驗收摘要')).check()
            intent(root, state, 'b_repair_publish')
            panel.get_by_role('button', name=f'確認發佈 revision {revision}').click()
            publish_result(page)
            done(root, state, 'b_repair_publish')
            emit_signal(root / 'b-repair-published')
            print('STATE=B_REPAIR_PUBLISHED')
        elif args.step == 'c-repair-confirm':
            require(args.plan_revision is not None and args.plan_revision > 0, 'INPUT')
            require(bool(args.module_version_id) and str(uuid.UUID(args.module_version_id)) == args.module_version_id, 'INPUT')
            select_test(page, args.test_name)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            plan.locator('.identifier', has_text=f'待確認 · Plan r{args.plan_revision} ·').wait_for(timeout=20000)
            rows = plan.locator('.platform-stages > li')
            require(rows.count() == 2, 'STAGE_COUNT')
            for row in rows.all():
                require(row.locator('h4').inner_text().endswith(' · 複用'), 'STAGE_KIND')
                require(row.locator('.identifier').filter(has_text=f'固定來源版本 {args.module_version_id}').count() == 1, 'STAGE_VERSION')
            button = plan.get_by_role('button', name='確認 Plan 並開始')
            require(button.is_enabled(), 'PLAN')
            state['c_repair_plan_revision'] = args.plan_revision
            state['c_repair_module_version_id'] = args.module_version_id
            intent(root, state, 'c_repair_confirm')
            button.click()
            plan.locator('.identifier', has_text=re.compile('已確認|逐階段執行中|已組合')).wait_for(timeout=30000)
            done(root, state, 'c_repair_confirm')
            emit_signal(root / 'c-repair-confirmed')
            print('STATE=C_REPAIR_CONFIRMED')
        elif args.step == 'c-repair-summary':
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 1, 'VALIDATION')
            require(batch.get_by_text('新整批摘要：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            button = batch.get_by_role('button', name='要求整批摘要')
            require(button.is_enabled(), 'SUMMARY')
            state['c_repair_validation_run_id'] = args.validation_run_id
            intent(root, state, 'c_repair_summary')
            button.click()
            batch.locator('.identifier', has_text='摘要 Run').wait_for(timeout=30000)
            done(root, state, 'c_repair_summary')
            emit_signal(root / 'c-repair-summary-ready')
            print('STATE=C_REPAIR_SUMMARY_READY')
        elif args.step == 'c-repair-publish':
            require(state.get('c_repair_validation_run_id') == args.validation_run_id, 'VALIDATION_MISMATCH')
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 2, 'SUMMARY')
            require(batch.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            check = batch.get_by_role('checkbox', name=re.compile('我已檢視全部候選清單與整批摘要'))
            require(check.is_enabled(), 'PUBLISH_NOT_READY')
            check.check()
            intent(root, state, 'c_repair_publish')
            batch.get_by_role('button', name='確認整批發佈').click()
            publish_result(page)
            done(root, state, 'c_repair_publish')
            emit_signal(root / 'c-repair-published')
            print('STATE=C_REPAIR_PUBLISHED')
        elif args.step == 'c-plan7-confirm':
            require(args.plan_revision == 7, 'PLAN_REVISION')
            require(args.module_version_id == 'f9e84377-31d6-4b49-84b3-39c4c3a9ab49', 'STAGE_VERSION')
            select_test(page, args.test_name)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            plan.get_by_role('button', name='重新載入', exact=True).click()
            plan.locator('.identifier', has_text='待確認 · Plan r7 ·').wait_for(timeout=20000)
            rows = plan.locator('.platform-stages > li')
            require(rows.count() == 4, 'STAGE_COUNT')
            require(rows.nth(0).locator('h4').inner_text().endswith(' · 新建'), 'STAGE_KIND')
            require(rows.nth(3).locator('h4').inner_text().endswith(' · 新建'), 'STAGE_KIND')
            for i, value in ((1, 'W3-OK'), (2, 'W3-MISSING')):
                row = rows.nth(i)
                require(row.locator('h4').inner_text().endswith(' · 複用'), 'STAGE_KIND')
                require(row.locator('.identifier').filter(has_text=f'固定來源版本 {args.module_version_id}').count() == 1, 'STAGE_VERSION')
                require(value in (row.locator('.plan-json').text_content() or ''), 'STAGE_INPUT')
            binding = json.loads(rows.nth(3).locator('.plan-json').text_content() or '{}')
            for key, stage_id in (('okOrder', 'lookup-w3-ok'), ('missingOrder', 'lookup-w3-missing')):
                value = binding.get(key)
                require(isinstance(value, dict) and value.get('kind') == 'binding' and value.get('stageId') == stage_id and value.get('path') == [], 'STAGE_BINDING')
            button = plan.get_by_role('button', name='確認 Plan 並開始')
            require(button.is_enabled(), 'PLAN')
            state['c_plan7_revision'] = 7
            intent(root, state, 'c_plan7_confirm')
            button.click()
            plan.locator('.identifier', has_text=re.compile('已確認|逐階段執行中|已組合')).wait_for(timeout=30000)
            done(root, state, 'c_plan7_confirm')
            emit_signal(root / 'c-plan7-confirmed')
            print('STATE=C_PLAN7_CONFIRMED')
        elif args.step == 'c-setup-confirm':
            require(args.plan_revision is not None and args.plan_revision > 0, 'INPUT')
            require(bool(args.module_version_id) and str(uuid.UUID(args.module_version_id)) == args.module_version_id, 'INPUT')
            select_test(page, args.test_name)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            plan.locator('.identifier', has_text=f'待確認 · Plan r{args.plan_revision} ·').wait_for(timeout=20000)
            rows = plan.locator('.platform-stages > li')
            require(args.plan_revision > state['c_repair_plan_revision'], 'PLAN_REVISION')
            require(rows.count() == 3, 'STAGE_COUNT')
            require(rows.nth(0).locator('h4').inner_text().endswith(' · 新建'), 'STAGE_KIND')
            for row in rows.all()[1:]:
                require(row.locator('h4').inner_text().endswith(' · 複用'), 'STAGE_KIND')
                require(row.locator('.identifier').filter(has_text=f'固定來源版本 {args.module_version_id}').count() == 1, 'STAGE_VERSION')
            button = plan.get_by_role('button', name='確認 Plan 並開始')
            require(button.is_enabled(), 'PLAN')
            state['c_setup_plan_revision'] = args.plan_revision
            state['c_setup_module_version_id'] = args.module_version_id
            intent(root, state, 'c_setup_confirm')
            button.click()
            plan.locator('.identifier', has_text=re.compile('已確認|逐階段執行中|已組合')).wait_for(timeout=30000)
            done(root, state, 'c_setup_confirm')
            emit_signal(root / 'c-setup-confirmed')
            print('STATE=C_SETUP_CONFIRMED')
        elif args.step == 'c-setup-summary':
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 1, 'VALIDATION')
            require(batch.get_by_text('新整批摘要：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            button = batch.get_by_role('button', name='要求整批摘要')
            require(button.is_enabled(), 'SUMMARY')
            state['c_setup_validation_run_id'] = args.validation_run_id
            intent(root, state, 'c_setup_summary')
            button.click()
            batch.locator('.identifier', has_text='摘要 Run').wait_for(timeout=30000)
            done(root, state, 'c_setup_summary')
            emit_signal(root / 'c-setup-summary-ready')
            print('STATE=C_SETUP_SUMMARY_READY')
        elif args.step == 'c-setup-publish':
            require(state.get('c_setup_validation_run_id') == args.validation_run_id, 'VALIDATION_MISMATCH')
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 2, 'SUMMARY')
            require(batch.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            check = batch.get_by_role('checkbox', name=re.compile('我已檢視全部候選清單與整批摘要'))
            require(check.is_enabled(), 'PUBLISH_NOT_READY')
            check.check()
            intent(root, state, 'c_setup_publish')
            batch.get_by_role('button', name='確認整批發佈').click()
            publish_result(page)
            done(root, state, 'c_setup_publish')
            emit_signal(root / 'c-setup-published')
            print('STATE=C_SETUP_PUBLISHED')
        elif args.step == 'c-plan7-summary':
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 1, 'VALIDATION')
            require(batch.get_by_text('新整批摘要：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            button = batch.get_by_role('button', name='要求整批摘要')
            require(button.is_enabled(), 'SUMMARY')
            state['c_plan7_validation_run_id'] = args.validation_run_id
            intent(root, state, 'c_plan7_summary')
            button.click()
            batch.locator('.identifier', has_text='摘要 Run').wait_for(timeout=30000)
            done(root, state, 'c_plan7_summary')
            emit_signal(root / 'c-plan7-summary-ready')
            print('STATE=C_PLAN7_SUMMARY_READY')
        elif args.step == 'c-plan7-publish':
            require(state.get('c_plan7_validation_run_id') == args.validation_run_id, 'VALIDATION_MISMATCH')
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 2, 'SUMMARY')
            require(batch.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            check = batch.get_by_role('checkbox', name=re.compile('我已檢視全部候選清單與整批摘要'))
            require(check.is_enabled(), 'PUBLISH_NOT_READY')
            check.check()
            intent(root, state, 'c_plan7_publish')
            batch.get_by_role('button', name='確認整批發佈').click()
            publish_result(page)
            done(root, state, 'c_plan7_publish')
            emit_signal(root / 'c-plan7-published')
            print('STATE=C_PLAN7_PUBLISHED')
        elif args.step == 'c-confirm':
            select_test(page, args.test_name)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            plan.locator('.identifier', has_text='待確認 · Plan r').wait_for(timeout=20000)
            require(plan.locator('.platform-stages > li').count() > 0, 'PLAN')
            button = plan.get_by_role('button', name='確認 Plan 並開始')
            require(button.is_enabled(), 'PLAN')
            intent(root, state, 'c_confirm')
            button.click()
            plan.locator('.identifier', has_text=re.compile('已確認|逐階段執行中|已組合')).wait_for(timeout=30000)
            done(root, state, 'c_confirm')
            emit_signal(root / 'c-confirmed')
            print('STATE=C_CONFIRMED')
        elif args.step == 'c-summary':
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 1, 'VALIDATION')
            require(batch.get_by_text('新整批摘要：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            button = batch.get_by_role('button', name='要求整批摘要')
            require(button.is_enabled(), 'SUMMARY')
            state['c_validation_run_id'] = args.validation_run_id
            intent(root, state, 'c_summary')
            button.click()
            batch.locator('.identifier', has_text='摘要 Run').wait_for(timeout=30000)
            done(root, state, 'c_summary')
            emit_signal(root / 'c-summary-ready')
            print('STATE=C_SUMMARY_READY')
        elif args.step == 'c-publish':
            select_test(page, args.test_name)
            report(page, args.validation_run_id)
            page.get_by_role('tab', name='驗證與發佈').click()
            plan = page.get_by_role('region', name='Use Case Plan 與整批發佈')
            batch = plan.locator('.platform-card').filter(has=page.get_by_role('heading', name='整批驗證與摘要'))
            require(batch.locator('.status-badge.success').count() >= 2, 'SUMMARY')
            require(batch.get_by_text('此摘要 Run 來源：外部 Agent', exact=False).count() == 1, 'SUMMARY')
            check = batch.get_by_role('checkbox', name=re.compile('我已檢視全部候選清單與整批摘要'))
            require(check.is_enabled(), 'PUBLISH_NOT_READY')
            check.check()
            intent(root, state, 'c_publish')
            batch.get_by_role('button', name='確認整批發佈').click()
            publish_result(page)
            done(root, state, 'c_publish')
            emit_signal(root / 'c-published')
            print('STATE=C_PUBLISHED')


if __name__ == '__main__':
    try:
        main()
    except Stop as exc:
        print('RESULT=BLOCKED\nREASON=' + exc.reason)
        sys.exit(1)
    except (Exception, KeyboardInterrupt, SystemExit):
        print('RESULT=BLOCKED\nREASON=UNEXPECTED')
        sys.exit(1)
