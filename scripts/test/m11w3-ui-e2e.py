#!/usr/bin/env python3
"""Real Web → external MCP Agent → Web validation QA handoff.

The PM boots an isolated Whippet stack and a Chromium CDP browser already
authenticated through the Web UI. This process never reads a key, cookie,
environment file, API response, raw conversation, or browser log. It does not
intercept product requests. A separate Codex Agent owns MCP claim and submit.

The ready/done files contain only the literal word ``true``. Keep this process
running while the Agent works; ``agent_done`` merely starts UI observation.
"""

from __future__ import annotations

import argparse
import os
import re
import stat
import sys
import time
from enum import Enum
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import Page, sync_playwright


class Stage(str, Enum):
    INPUT = "INPUT"
    BROWSER = "BROWSER"
    LOGIN = "LOGIN"
    WORKSPACE = "WORKSPACE"
    ENGINE = "ENGINE"
    TEST = "TEST"
    CONVERSATION = "CONVERSATION"
    HANDOFF = "HANDOFF"
    DRAFT = "DRAFT"
    VALIDATION = "VALIDATION"


class QaFailure(Exception):
    def __init__(self, stage: Stage):
        self.stage = stage


def origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    return parts.scheme, parts.hostname or "", parts.port


def same_web_origin(candidate: str, expected: str) -> bool:
    candidate_scheme, candidate_host, candidate_port = origin(candidate)
    expected_scheme, expected_host, expected_port = origin(expected)
    loopback = {"127.0.0.1", "localhost", "::1"}
    return (
        candidate_scheme == expected_scheme
        and candidate_port == expected_port
        and (
            candidate_host == expected_host
            or candidate_host in loopback and expected_host in loopback
        )
    )


def safe_local_url(raw: str) -> bool:
    try:
        parts = urlsplit(raw)
        return (
            parts.scheme in ("http", "https")
            and parts.hostname in ("127.0.0.1", "localhost", "::1")
            and parts.port is not None
            and not parts.username
            and not parts.password
            and not parts.query
            and not parts.fragment
        )
    except ValueError:
        return False


def signal_is_true(path: Path) -> bool:
    try:
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 8:
            raise QaFailure(Stage.HANDOFF)
        return path.read_text(encoding="ascii").strip() == "true"
    except FileNotFoundError:
        return False
    except (UnicodeError, OSError):
        raise QaFailure(Stage.HANDOFF) from None


def write_ready(path: Path) -> None:
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("x", encoding="ascii") as stream:
        stream.write("true\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


def connected_page(browser: object, web_url: str) -> Page:
    matches = [
        page
        for context in browser.contexts  # type: ignore[attr-defined]
        for page in context.pages
        if same_web_origin(page.url, web_url)
    ]
    if len(matches) != 1:
        raise QaFailure(Stage.BROWSER)
    page = matches[0]
    page.wait_for_load_state("networkidle", timeout=15_000)
    if page.locator(".mock-banner, .mock-note").count():
        raise QaFailure(Stage.BROWSER)
    if page.get_by_role("heading", name="Whippet").count():
        raise QaFailure(Stage.LOGIN)
    return page


def select_external(page: Page) -> None:
    page.get_by_role("button", name="Workspace 設定").click()
    page.get_by_role("tab", name="正式設定與能力").click()
    settings = page.get_by_role("form", name="AI 撰寫引擎設定")
    settings.wait_for(timeout=15_000)
    if not settings.get_by_text("目前：外部 Agent").count():
        settings.get_by_role("radio", name="外部 Agent").check()
        settings.get_by_role("button", name="儲存引擎設定").click()
    settings.get_by_text("目前：外部 Agent").wait_for(timeout=15_000)
    page.get_by_role("button", name="返回測試工作台").click()


def current_revision(page: Page) -> int:
    page.get_by_role("tab", name="腳本").click()
    value = page.locator("#side-panel-script .meta-list div").filter(
        has=page.locator("dt", has_text="revision")
    ).locator("dd").inner_text()
    match = re.search(r"\b(\d+)\b", value)
    if not match:
        raise QaFailure(Stage.DRAFT)
    return int(match.group(1))


def submit_requirement(page: Page, target_url: str) -> int:
    page.get_by_role("navigation", name="Workspace 與測試").get_by_role(
        "button", name="新增測試"
    ).click()
    page.get_by_role("tab", name="對話編輯").wait_for(timeout=20_000)
    before = current_revision(page)
    requirement = (
        f"請替目前 Test 建立 Playwright 測試：開啟 {target_url}，在「訂單編號」輸入 "
        "W3-OK，按「查詢訂單」，確認「訂單已完成」與「NT$320」可見；"
        "接著輸入 W3-MISSING 並查詢，確認「查無訂單」可見。"
        "完成腳本後請排正式驗證，保留草稿供我檢視。"
    )
    page.get_by_role("textbox", name="測試需求或修改訊息").fill(requirement)
    page.get_by_role("button", name="送出訊息").click()
    page.locator(".turn.user .message-content").filter(has_text="W3-OK").wait_for(
        timeout=20_000
    )
    page.get_by_role("status", name=re.compile("AI 來源：外部 Agent")).wait_for(
        timeout=20_000
    )
    if page.get_by_role("textbox", name="測試需求或修改訊息").input_value():
        raise QaFailure(Stage.CONVERSATION)
    return before


def resume_submitted_requirement(page: Page) -> int:
    if page.locator(".test-item.selected").count() != 1:
        raise QaFailure(Stage.TEST)
    page.locator(".turn.user .message-content").filter(has_text="W3-OK").wait_for(
        timeout=10_000
    )
    page.get_by_role("status", name=re.compile("AI 來源：外部 Agent")).wait_for(
        timeout=10_000
    )
    if page.get_by_role("textbox", name="測試需求或修改訊息").input_value():
        raise QaFailure(Stage.CONVERSATION)
    return current_revision(page)


def await_agent_signal(path: Path, timeout_seconds: int) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if signal_is_true(path):
            print("AGENT_SIGNAL=true", flush=True)
            return
        time.sleep(2)
    raise QaFailure(Stage.HANDOFF)


def await_ai_draft(page: Page, before: int, timeout_seconds: int) -> int:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        page.get_by_role("tab", name="腳本").click()
        page.get_by_role("button", name="重新載入草稿").click()
        page.wait_for_timeout(1_000)
        revision = current_revision(page)
        source = page.locator("#side-panel-script .meta-list div").filter(
            has=page.locator("dt", has_text="來源")
        ).locator("dd")
        script_matches_task = page.locator("#side-panel-script .code-view").evaluate(
            "element => { const script = element.textContent; "
            "return script.length > 80 && script.includes('W3-OK') "
            "&& script.includes('W3-MISSING'); }"
        )
        if revision > before and source.inner_text().strip() == "AI 修改" and script_matches_task:
            print("AI_DRAFT=true", flush=True)
            return revision
        time.sleep(2)
    raise QaFailure(Stage.DRAFT)


def await_validation(page: Page, revision: int, timeout_seconds: int) -> None:
    page.get_by_role("tab", name="驗證與發佈").click()
    panel = page.locator("#side-panel-publish")
    summary = panel.locator(".validation-summary")
    submit = panel.get_by_role("button", name="驗證此 revision")
    requested = False
    deadline = time.monotonic() + timeout_seconds
    manual_grace = time.monotonic() + 20
    while time.monotonic() < deadline:
        refresh = panel.get_by_role("button", name="重新整理狀態")
        if refresh.is_enabled():
            refresh.click()
        page.wait_for_timeout(1_000)
        if summary.locator(".status-badge.success").count():
            condition = panel.locator(".conditions li.ok").filter(
                has_text=f"revision {revision} 驗證通過"
            )
            if condition.count() == 1 and summary.get_by_role(
                "link", name=re.compile("查看草稿驗證報告")
            ).count() == 1:
                print("VALIDATION=SUCCEEDED", flush=True)
                return
        if summary.locator(".status-badge.danger").count():
            raise QaFailure(Stage.VALIDATION)
        if (
            not requested
            and time.monotonic() >= manual_grace
            and summary.get_by_text("尚未驗證目前 revision").count() == 1
            and submit.is_enabled()
        ):
            submit.click()
            requested = True
        time.sleep(2)
    raise QaFailure(Stage.VALIDATION)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--web-url", required=True)
    parser.add_argument("--cdp-url", required=True)
    parser.add_argument("--target-url", required=True)
    parser.add_argument("--workspace-name", required=True)
    parser.add_argument("--signal-dir", type=Path, required=True)
    parser.add_argument("--agent-timeout", type=int, default=1_800)
    parser.add_argument("--ui-timeout", type=int, default=300)
    parser.add_argument("--resume-after-send", action="store_true")
    args = parser.parse_args()
    stage = Stage.INPUT
    try:
        if not safe_local_url(args.web_url) or not safe_local_url(args.cdp_url):
            raise QaFailure(Stage.INPUT)
        target = urlsplit(args.target_url)
        if (
            target.scheme not in ("http", "https")
            or not target.hostname
            or target.username
            or target.password
            or target.query
            or target.fragment
        ):
            raise QaFailure(Stage.INPUT)
        if not args.workspace_name.strip() or not args.signal_dir.is_dir():
            raise QaFailure(Stage.INPUT)
        ready = args.signal_dir / "ready"
        done = args.signal_dir / "agent_done"
        if ready.exists() or done.exists():
            raise QaFailure(Stage.HANDOFF)
        stage = Stage.BROWSER
        with sync_playwright() as playwright:
            browser = playwright.chromium.connect_over_cdp(args.cdp_url)
            page = connected_page(browser, args.web_url)
            if args.resume_after_send:
                stage = Stage.CONVERSATION
                before = resume_submitted_requirement(page)
            else:
                stage = Stage.WORKSPACE
                page.get_by_role("combobox", name="Workspace").select_option(
                    label=args.workspace_name
                )
                stage = Stage.ENGINE
                select_external(page)
                print("EXTERNAL_SELECTED=true", flush=True)
                stage = Stage.CONVERSATION
                before = submit_requirement(page, args.target_url)
            print("UI_SUBMITTED=true", flush=True)
            stage = Stage.HANDOFF
            write_ready(ready)
            print("STATE=READY", flush=True)
            await_agent_signal(done, args.agent_timeout)
            stage = Stage.DRAFT
            revision = await_ai_draft(page, before, args.ui_timeout)
            stage = Stage.VALIDATION
            await_validation(page, revision, args.ui_timeout)
            print("RESULT=PASS", flush=True)
            return 0
    except QaFailure as failure:
        stage = failure.stage
    except (Exception, KeyboardInterrupt):
        pass
    print(f"RESULT=FAIL\nSTAGE={stage.value}", flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
