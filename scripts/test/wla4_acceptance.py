#!/usr/bin/env python3
"""Exercise the v15 Workspace login contract through the isolated ADM-4 launcher."""

import argparse
import copy
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import time
from urllib.parse import urlsplit
from uuid import uuid4


HERE = Path(__file__).resolve().parent
MODEL_ORIGIN = "https://wla-provider.invalid/v1"
LEGACY_WORKSPACE = "00000000-0000-4000-8000-000000000001"
LEGACY_ROLE = "742608f9-d94c-4862-b288-0881d01c032a"
AUTHENTICATED = "Authenticated synthetic customer"
DENIED = "tool_unavailable"
TERMINAL = {"succeeded", "failed", "timed_out", "cancelled", "interrupted"}
SENTINEL = re.compile(r"wla4-(?:secret-[a-z0-9-]+|provider-key)")
MANAGED_ENGINES = ("builtin", "vercel", "pi")
A5_ENTRIES = (*MANAGED_ENGINES, "mcp-interactive", "mcp-claim")
FINAL_FOCUS = ("a2", "a3", "a4", "a5", "a6", *A5_ENTRIES)
ACCOUNT_PURPOSES = ("建立訂單", "檢查他人的訂單不可見")


def configure(server, manager, docker, image, *, final=False):
    label = docker("image", "inspect", image, "--format", '{{index .Config.Labels "org.whippet.acceptance"}}',
                   check=True).stdout.strip()
    if label != "wla4":
        raise RuntimeError("--wla requires the derived image from scripts/test/wla4-worker.Dockerfile")
    if final:
        registry = (HERE.parents[1] / "contracts/tools/registry.json").read_bytes()
        if not any(tool["name"] == "browser_login_account" for tool in json.loads(registry)["tools"]):
            raise RuntimeError("run final from the merged checkout with the scoped login registry")
        probe = """const fs = require('node:fs'), crypto = require('node:crypto');
          const files = ['/app/contracts/tools/registry.json', '/opt/wla4/fixture.mjs'];
          for (const path of files) console.log(crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'));
          if (!fs.existsSync('/opt/whippet/worker/dist/login/verification-main.js')) process.exitCode = 1;
        """
        bundled = docker("run", "--rm", "--pull=never", "--network", "none", "--entrypoint", "node", image, "-e", probe)
        expected = [hashlib.sha256(contents).hexdigest() for contents in (registry, (HERE / "wla4-fixture.mjs").read_bytes())]
        if bundled.returncode != 0 or bundled.stdout.splitlines() != expected:
            raise RuntimeError("rebuild the final Worker and WLA model image from the merged checkout")
    # Leave room for frozen proposals, conversation turns and browser tool results.
    context_window_tokens, context_input_tokens = 131072, 65536
    context_env = {"WHIPPET_AI_CONTEXT_WINDOW_TOKENS": str(context_window_tokens),
                   "WHIPPET_AI_CONTEXT_INPUT_TOKENS": str(context_input_tokens)}
    server["WHIPPET_AI_RUNTIME_PROFILES_JSON"] = json.dumps([
        {"id": f"wla4-{engine}", "engine": engine, "provider": "openai-responses", "model": f"wla4-{engine}",
         "baseURL": MODEL_ORIGIN, "reasoningEffort": "low", "contextWindowTokens": context_window_tokens,
         "contextInputTokens": context_input_tokens}
        for engine in MANAGED_ENGINES
    ])
    # The Server checks its default model against the packaged skill before selecting a runtime profile.
    server.update(WHIPPET_AI_BASE_URL=MODEL_ORIGIN, WHIPPET_WORKSPACE_LOGIN_ENABLED="true", **context_env)
    manager.update(WHIPPET_AI_ENABLED="true", WHIPPET_AI_PROVIDER="openai-responses",
                   WHIPPET_AI_API_KEY="wla4-provider-key", OPENCODE_API_KEY="wla4-provider-key", WHIPPET_AI_BASE_URL=MODEL_ORIGIN,
                   WHIPPET_AI_MODEL="wla4-builtin", **context_env)


def prepare(stack, wave, services, root, env, token, database, image, api_url, cert, manager_env):
    docker, start, wait_http, await_ready = services
    shop = HERE.parents[1] / "deploy/fixtures/m10-shop/server.mjs"
    credentials = [[f"wla4-secret-{uuid4().hex}", f"wla4-secret-{uuid4().hex}"] for _ in range(2)]
    shop_env = {**env, **dict(zip(("FIXTURE_USERNAME", "FIXTURE_PASSWORD", "FIXTURE_SECOND_USERNAME",
                                  "FIXTURE_SECOND_PASSWORD"), credentials[0] + credentials[1]))}
    origins, containers = {}, {}
    sites = ("guest",) if wave == "w1" else ("guest", "orders")
    for site in sites:
        name = f"whippet-wla4-{site}-{token}"
        site_env = {**shop_env, "WLA4_SHARED_SHOP": "1" if site == "orders" else "0"}
        docker("run", "--rm", "--detach", "--pull=never", "--name", name, "--network", "bridge",
               *(argument for key in site_env.keys() - env.keys() for argument in ("--env", key)),
               "--mount", f"type=bind,src={shop},dst=/wla-shop.mjs,readonly",
               "--entrypoint", "node", image, "/opt/wla4/fixture.mjs", "--shop", env=site_env, check=True)
        stack.callback(docker, "stop", name, check=True)
        listening_ports = [8080, 8081, 8082] if site == "orders" else [8080]
        probe = f"""for (const port of {listening_ports}) {{
          require('node:http').get(`http://127.0.0.1:${{port}}/healthz`, r => {{
            r.resume(); if (r.statusCode !== 200) process.exitCode = 1;
          }}).on('error', () => process.exit(1));
        }}"""
        await_ready(lambda: docker("exec", name, "node", "-e", probe).returncode == 0,
                    f"isolated shop {site} did not open all required ports")
        ip = docker("inspect", name, "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", check=True).stdout.strip()
        if not ipaddress.IPv4Address(ip).is_private:
            raise RuntimeError("shop must use a private Docker bridge address")
        if site == "orders":
            origins.update(auth=f"http://{ip}:8080", orders=f"http://{ip}:8081", support=f"http://{ip}:8082")
            containers.update(auth=name, orders=name, support=name)
        else:
            origins[site], containers[site] = f"http://{ip}:8080", name

    if wave == "final":
        content = configuration("WLA4 v8", [("Legacy shop", origins["orders"], "authenticated")])
        content.pop("testAccounts")
        content["targets"][0].pop("testScope")
        content["loginRoles"] = [{"roleId": LEGACY_ROLE, "name": "會員", "loginMethod": "form",
                                  "loginOrigin": origins["orders"]}]
        sql = f"""BEGIN;
        UPDATE workspaces SET lifecycle='active',scope_status='confirmed',authorization_revision=1,
          canonical_config=$wla${json.dumps(content)}$wla$ WHERE id='{LEGACY_WORKSPACE}';
        INSERT INTO workspace_roles (id,workspace_id) VALUES ('{LEGACY_ROLE}','{LEGACY_WORKSPACE}');
        COMMIT;"""
        docker("exec", "-i", database, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres",
               input=sql, check=True)
        docker("cp", f"{containers['guest']}:/opt/whippet/worker/node_modules/ws", str(root / "ws"), check=True)
        with socket.socket() as connection:
            connection.bind(("127.0.0.1", 0))
            port = connection.getsockname()[1]
        proxy = start(stack, ["node", str(HERE / "wla4-fixture.mjs"), "--result-proxy"],
                      {**env, "WLA4_PROXY_PORT": str(port), "WLA4_UPSTREAM": api_url, "WLA4_ROOT": str(root)},
                      HERE, root / "result-proxy.log")
        url = f"https://127.0.0.1:{port}"
        wait_http(url + "/readyz", proxy, "WLA result proxy", cert)
        manager_env["SERVER_URL"] = url
    return {"WLA4_SCOPE": json.dumps({"origins": origins, "containers": containers}),
            "WLA4_SITE_CREDENTIALS": json.dumps(credentials)}


def load_adm_web():
    spec = importlib.util.spec_from_file_location("adm1_ui_smoke", HERE / "adm1-ui-smoke.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check(condition, label):
    if not condition:
        raise AssertionError(label)


def clean(value):
    check(not SENTINEL.search(json.dumps(value, ensure_ascii=False)), "synthetic credential leaked in response")
    return value


def wait_for(fetch, accepts, label, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fetch()
        if accepts(value):
            return value
        time.sleep(0.3)
    raise AssertionError(f"timed out waiting for {label}")


def configuration(name, targets, accounts=()):
    return {"name": name, "purpose": "驗證隔離合成站台的流程", "backgroundSummary": "WLA4 本機驗收",
            "targets": [{"name": label, "purpose": "驗收站台", "origin": origin, "testScope": scope}
                        for label, origin, scope in targets],
            "dependencies": [], "excludedOrigins": [], "exclusions": "", "loginRoles": [],
            "testAccounts": list(accounts), "defaultTestUrl": targets[0][1] + "/login", "timeoutMs": 20000}


def binding(origin, selector='[data-testid="account-state"]', *, login_origin=None):
    return {"targetOrigin": origin, "loginMethod": "form", "entryUrl": (login_origin or origin) + "/login",
            "form": {"usernameSelector": 'input[name="username"]', "passwordSelector": 'input[name="password"]',
                     "submitSelector": 'button[type="submit"]', "loginRejectedSelector": 'h1:text-is("Login rejected")'},
            "success": {"url": origin + "/products", "visibleSelector": selector}}


def command(kind, payload):
    return "WLA4 " + kind + " " + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


class Acceptance:
    def __init__(self, adm, browser, base, key, root):
        self.adm, self.browser, self.base, self.key, self.root = adm, browser, base, key, root
        self.admin = adm.login(browser, base, key, "dev-admin")
        scope = json.loads(os.environ["WLA4_SCOPE"])
        self.origins, self.containers = scope["origins"], scope["containers"]
        self.credentials = json.loads(os.environ["WLA4_SITE_CREDENTIALS"])
        for origin in self.origins.values():
            target = urlsplit(origin)
            check(target.scheme == "http" and target.port in (8080, 8081, 8082) and
                  ipaddress.IPv4Address(target.hostname).is_private,
                  "fixture origin must be on the isolated Docker bridge")
        self.checks = {}
        self.stage = "setup"

    def api(self, method, path, status=200, data=None, code=None, page=None):
        return clean(self.adm.api(page or self.admin, self.base, method, path, status, data, code))

    def workspace(self, workspace):
        return self.api("GET", f"/api/workspaces/{workspace}")

    def run(self, run_id):
        return self.api("GET", f"/api/runs/{run_id}")

    def terminal(self, run_id, expected):
        value = wait_for(lambda: self.run(run_id), lambda run: run["status"] in TERMINAL, f"Run {run_id}")
        check(value["status"] in expected, f"Run {run_id} ended {value['status']}, expected {sorted(expected)}")
        return value

    def create_from_web(self, name):
        page = self.admin
        page.get_by_role("button", name="更多功能", exact=True).click()
        page.get_by_role("button", name="建立 Workspace", exact=True).click()
        page.get_by_label("Workspace 名稱（選填）").fill(name)
        with page.expect_response(lambda res: res.url.endswith("/api/workspaces") and res.request.method == "POST") as res:
            page.get_by_role("button", name="建立並開始訪談", exact=True).click()
        return clean(self.adm.checked(res.value, 201))["id"]

    def open_settings(self, name):
        page = self.admin
        if page.get_by_role("heading", name="Workspace 設定對話", exact=True).is_visible():
            page.get_by_role("button", name="返回測試工作台", exact=True).click()
        page.get_by_role("button", name="更多功能", exact=True).click()
        page.get_by_role("group", name="切換 Workspace").get_by_role("button", name=name, exact=True).click()
        page.get_by_role("button", name="管理 Workspace", exact=True).click()
        page.get_by_role("heading", name="Workspace 設定對話", exact=True).wait_for()

    def propose(self, workspace, config, message, web=False):
        return self.interview(workspace, command("setup", {"proposal": config, "message": message}), web)

    def interview(self, workspace, content, web):
        current = self.workspace(workspace)
        path = f"/api/workspaces/{workspace}"
        if web:
            page = self.admin
            if content is not None:
                page.get_by_role("textbox", name="Workspace 需求或修改訊息").fill(content)
            with page.expect_response(lambda response: response.url.endswith(path + "/messages") and
                                      response.request.method == "POST") as sent:
                page.get_by_role("button", name="送出訊息", exact=True).click()
            reply = clean(self.adm.checked(sent.value, 202))
        else:
            revision = self.api("GET", path + "/conversation")["contextRevision"]
            reply = self.api("POST", path + "/messages", 202,
                             {"revision": current["revision"], "contextRevision": revision, "content": content})
        run_id = reply["run"]["id"]
        self.terminal(run_id, {"succeeded"})
        proposal = self.workspace(workspace)["currentProposal"]
        check(proposal and proposal["sourceRunId"] == run_id and proposal["status"] == "pending",
              "interview must persist a new pending proposal")
        return self.proposal(proposal)

    @staticmethod
    def proposal_path(proposal):
        return f"/api/workspaces/{proposal['workspaceId']}/proposals/{proposal['id']}"

    def proposal(self, proposal):
        return self.api("GET", self.proposal_path(proposal))

    def act(self, proposal, action, status=200, code=None, base_revision=None):
        return self.api("POST", self.proposal_path(proposal) + f"/{action}", status,
                        {"baseRevision": base_revision if base_revision is not None else proposal["baseRevision"],
                         "confirmed": True}, code)

    def panel(self, tab):
        button = self.admin.locator(f"#ws-tab-{tab}")
        toggle = self.admin.get_by_role("button", name="提案與登入資料", exact=True)
        if not button.is_visible() and toggle.is_visible():
            toggle.click()
        button.click()
        return self.admin.locator(f"#ws-panel-{tab}")

    def card(self, proposal):
        card = self.panel("proposal").locator(f'[data-proposal-id="{proposal["id"]}"]')
        card.wait_for()
        return card

    def confirm_from_web(self, proposal, action):
        label = {"confirm": "確認並套用提案", "confirm-scope": "確認提案範圍"}[action]
        card = self.card(proposal)
        card.get_by_role("checkbox", name=re.compile("我已檢視")).check()
        path = self.proposal_path(proposal) + "/" + action
        with self.admin.expect_response(lambda response: response.url.endswith(path) and response.request.method == "POST") as saved:
            card.get_by_role("button", name=label, exact=True).click()
        return clean(self.adm.checked(saved.value, 200))

    def apply_from_web(self, proposal):
        return self.confirm_from_web(proposal, "confirm")["workspace"]

    @staticmethod
    def site(subject, origin):
        matches = [site for site in subject["siteReadiness"] if site["targetOrigin"] == origin]
        check(len(matches) == 1, "each target needs exactly one readiness row")
        return matches[0]

    @classmethod
    def account(cls, subject, origin, account):
        matches = [row for row in cls.site(subject, origin)["accounts"] if row["accountId"] == account]
        check(len(matches) == 1, "site must expose the selected account status")
        return matches[0]

    def w1(self, *, guest_only=False):
        name = "WLA4 訪客說明站"
        workspace = self.create_from_web(name)
        origin = self.origins["guest"]
        if guest_only:
            ready = self.propose(workspace, configuration(name, [("公開登入入口", origin, "guest")]),
                                 "這次只測訪客。", web=True)
            applied = self.apply_from_web(ready)
            check(applied["lifecycle"] == "active" and not applied["settings"]["testAccounts"],
                  "A5 needs an active visitor Workspace with zero accounts")
            return workspace
        proposal = self.propose(workspace, configuration(name, [("公開登入入口", origin, "unknown")]),
                                "這個站要測訪客或登入後流程？", web=True)
        row = self.site(proposal, origin)
        check(row["testScope"] == "unknown" and not row["ready"] and row["reason"] == "scope_choice_required",
              "an unanswered site must remain blocked")
        from playwright.sync_api import expect
        card = self.card(proposal)
        expect(card.get_by_text("待釐清", exact=True)).to_be_visible()
        card.get_by_role("checkbox", name=re.compile("我已檢視")).check()
        expect(card.get_by_role("button", name="確認並套用提案", exact=True)).to_be_disabled()
        self.act(proposal, "confirm", 409, "workspace_setup_incomplete")
        self.open_settings(name)
        card = self.card(proposal)
        card.get_by_role("group", name="公開登入入口 的訪談回覆").get_by_role("button", name="只測登入後", exact=True).click()
        expect(self.admin.get_by_role("textbox", name="Workspace 需求或修改訊息")).to_have_value(f"本次 {origin} 只測登入後。")
        missing = self.interview(workspace, None, web=True)
        check(self.site(missing, origin)["reason"] == "login_verification_required", "no login evidence must block apply")
        self.act(missing, "confirm", 409, "workspace_setup_incomplete")
        ready = self.interview(workspace, f"本次 {origin} 只測訪客。", web=True)
        row = self.site(ready, origin)
        check(row["testScope"] == "guest" and row["ready"] and not ready["content"]["testAccounts"],
              "guest scope must be eligible with zero accounts")
        applied = self.apply_from_web(ready)
        check(applied["lifecycle"] == "active" and applied["settings"]["targets"][0]["testScope"] == "guest",
              "Web confirmation must persist the guest scope")
        self.checks["A1"] = {"workspaceId": workspace, "unknown": 409, "missingEvidence": 409, "guestApply": 200}
        return workspace

    def save_credentials(self, proposal, account, credentials, *, web=False):
        state = next(row for row in self.proposal(proposal)["accountCredentials"] if row["accountId"] == account)
        path = self.proposal_path(proposal) + f"/test-accounts/{account}/credentials"
        if web:
            from playwright.sync_api import expect
            form = self.panel("credentials")
            form.get_by_role("combobox", name="測試帳號", exact=True).select_option(account)
            username = form.get_by_label("登入帳號", exact=True)
            username.fill(credentials[0])
            form.get_by_label("登入密碼", exact=True).fill(credentials[1])
            with self.admin.expect_response(lambda response: response.url.endswith(path) and response.request.method == "PUT") as saved:
                form.get_by_role("button", name="保存登入資料", exact=True).click()
            result = clean(self.adm.checked(saved.value, 200))
            expect(username).to_have_value("")
        else:
            result = self.api("PUT", path, data={"baseRevision": proposal["baseRevision"],
                                                "expectedSecretVersion": state["secretVersion"] or 0,
                                                "username": credentials[0], "password": credentials[1]})
        check(result["configured"] and result["secretVersion"] > (state["secretVersion"] or 0), "new credential version")
        return result["secretVersion"]

    def enqueue(self, proposal, account, site, *, check_replay=False, web=False):
        target = self.origins[site]
        path = self.proposal_path(proposal) + "/verify-login"
        fields = {"baseRevision": proposal["baseRevision"], "accountId": account, "targetOrigin": target}
        if web:
            current = self.proposal(proposal)
            site_name = next(row["name"] for row in current["content"]["targets"] if row["origin"] == target)
            account_name = next(row["name"] for row in current["content"]["testAccounts"] if row["accountId"] == account)
            action = "重試登入驗證" if self.account(current, target, account)["state"] == "failed" else "驗證登入"
            button = self.card(proposal).get_by_role("button", name=f"{action} · {site_name} · {account_name}", exact=True)
            with self.admin.expect_response(lambda response: response.url.endswith(path) and response.request.method == "POST") as queued:
                button.click()
            run = clean(self.adm.checked(queued.value, 202))["run"]
            request = queued.value.request.post_data_json
            check(all(request.get(field) == value for field, value in fields.items()), "Web queued a different login binding")
        else:
            request = {**fields, "requestId": str(uuid4())}
            run = self.api("POST", path, 202, request)["run"]
        check(run["kind"] == "workspace_login_verification" and run["testId"] is None, "expected Workspace verification Run")
        if check_replay:
            check(self.api("POST", path, 202, request)["run"]["id"] == run["id"], "request replay queued another Run")
        return run["id"]

    def verify(self, proposal, account, site, expected, reason=None, *, check_replay=False, web=False):
        run_id = self.enqueue(proposal, account, site, check_replay=check_replay, web=web)
        run = self.terminal(run_id, expected)
        state = self.account(self.proposal(proposal), self.origins[site], account)
        check(state["runId"] == run_id and (state["state"] == "verified") == (run["status"] == "succeeded"),
              "proposal account state must reflect that Run")
        if reason is not None:
            check(state["reason"] in reason, "unexpected verification failure reason")
        return run_id

    def shop_count(self, site, line):
        result = subprocess.run(["docker", "logs", self.containers[site]], capture_output=True, text=True, check=True, timeout=10)
        return result.stdout.splitlines().count(f"{urlsplit(self.origins[site]).port} {line}")

    def multi_site(self, *, exercise_partial=True):
        guest, orders, support, auth = (self.origins[key] for key in ("guest", "orders", "support", "auth"))
        name = "WLA4 商店與客服"
        workspace = self.create_from_web(name)
        accounts = [
            {"accountId": None, "name": "會員 A", "role": "會員", "purpose": ACCOUNT_PURPOSES[0],
             "sites": [binding(orders, login_origin=auth)]},
            {"accountId": None, "name": "會員 B", "role": "會員", "purpose": ACCOUNT_PURPOSES[1],
             "sites": [binding(orders, login_origin=auth), binding(support, login_origin=auth)]},
        ]
        if exercise_partial:
            accounts[1]["sites"][1]["success"]["visibleSelector"] = "#absent-after-submit"
        config = configuration(name, [("訪客站", guest, "guest"), ("訂單站", orders, "authenticated"),
                                      ("客服站", support, "both")], accounts)
        config["dependencies"] = [{"name": "共用登入", "origin": auth, "purpose": "login"}]
        proposal = self.propose(workspace, config, "已記下三個站台的驗測範圍。", web=True)
        ids = {row["name"]: row["accountId"] for row in proposal["content"]["testAccounts"]}
        owner, other = ids["會員 A"], ids["會員 B"]
        check(str(owner) != str(other), "same-role choices need two different IDs")
        self.save_credentials(proposal, owner, self.credentials[0], web=exercise_partial)
        self.save_credentials(proposal, other, self.credentials[1], web=exercise_partial)
        proposal = self.confirm_from_web(proposal, "confirm-scope") if exercise_partial else self.act(proposal, "confirm-scope")
        orders_run = self.verify(proposal, owner, "orders", {"succeeded"}, check_replay=exercise_partial, web=exercise_partial)
        self.verify(proposal, other, "orders", {"succeeded"}, web=exercise_partial)
        if not exercise_partial:
            self.verify(proposal, other, "support", {"succeeded"})
            self.act(proposal, "confirm")
            return workspace, owner, other
        submissions = self.shop_count("auth", "POST /login 303")
        checks = self.shop_count("support", "GET /products 200")
        submit_only = self.verify(proposal, other, "support", {"failed"}, {"login_not_verified"}, web=True)
        check(self.shop_count("auth", "POST /login 303") > submissions and self.shop_count("support", "GET /products 200") > checks,
              "partial failure must submit at the shared IdP and reach the correct target")
        draft = self.proposal(proposal)
        check(self.site(draft, orders)["ready"] and not self.site(draft, support)["ready"], "readiness may not cross origins")
        self.act(draft, "confirm", 409, "workspace_setup_incomplete")
        check(self.workspace(workspace)["lifecycle"] == "draft", "partially verified Workspace must remain draft")
        self.open_settings(name)
        from playwright.sync_api import expect
        card = self.card(draft)
        card.get_by_role("checkbox", name=re.compile("我已檢視")).check()
        expect(card.get_by_role("button", name="確認並套用提案", exact=True)).to_be_disabled()
        fixed = copy.deepcopy(draft["content"])
        target = next(row for row in fixed["testAccounts"] if row["accountId"] == other)
        target["sites"][1] = binding(support, login_origin=auth)
        proposal = self.propose(workspace, fixed, "客服站改驗登入後的身分標記。", web=True)
        if not proposal["scopeConfirmed"]:
            proposal = self.confirm_from_web(proposal, "confirm-scope")
        check(self.site(proposal, orders)["ready"], "untouched site evidence must carry to the next proposal")
        support_run = self.verify(proposal, other, "support", {"succeeded"}, web=True)
        self.open_settings(name)
        confirmed = self.apply_from_web(self.proposal(proposal))
        check(all(site["ready"] for site in confirmed["siteReadiness"]), "all three sites must be ready after apply")
        self.checks["A2"] = {"workspaceId": workspace, "ordersRunId": orders_run,
                              "submitOnlyRunId": submit_only, "supportRunId": support_run}
        return workspace, owner, other

    def retry_and_late_result(self, workspace, account):
        support = self.origins["support"]
        active = self.workspace(workspace)
        config = copy.deepcopy(active["settings"])
        account_config = next(row for row in config["testAccounts"] if row["accountId"] == account)
        site = next(row for row in account_config["sites"] if row["targetOrigin"] == support)
        entry = site["entryUrl"]
        site["entryUrl"] = self.origins["auth"] + "/mfa-login"
        site["form"]["mfaSelector"] = "#mfa-challenge"
        mfa = self.propose(workspace, config, "這次驗收表單後的第二因素提示。")
        if not mfa["scopeConfirmed"]:
            mfa = self.act(mfa, "confirm-scope")
        challenge = self.verify(mfa, account, "support", {"failed"}, {"mfa_required"})
        self.act(mfa, "confirm", 409, "workspace_setup_incomplete")

        site["entryUrl"] = entry + "?case=retry"
        del site["form"]["mfaSelector"]
        proposal = self.propose(workspace, config, "重新核對客服登入。")
        if not proposal["scopeConfirmed"]:
            proposal = self.act(proposal, "confirm-scope")
        wrong = self.credentials[1][0], f"wla4-secret-{uuid4().hex}"
        self.save_credentials(proposal, account, wrong)
        rejects = self.shop_count("auth", "POST /login 401")
        failed = self.verify(proposal, account, "support", {"failed"}, {"login_rejected"})
        check(self.shop_count("auth", "POST /login 401") > rejects, "shared IdP must reject the submitted wrong password")
        self.open_settings(config["name"])
        from playwright.sync_api import expect
        row = self.card(proposal).get_by_role("button", name="重試登入驗證 · 客服站 · 會員 B", exact=True).locator("..")
        expect(row.get_by_text("登入資料遭站台拒絕。請更新帳密後重試。", exact=True)).to_be_visible()
        self.act(proposal, "confirm", 409, "workspace_setup_incomplete")
        self.save_credentials(proposal, account, self.credentials[1], web=True)
        succeeded = self.verify(proposal, account, "support", {"succeeded"}, web=True)
        check(self.workspace(workspace)["revision"] == active["revision"], "draft retry must preserve the confirmed version")

        self.root.joinpath("wla4-arm.json").write_text(json.dumps({"targetOrigin": support, "accountId": account}))
        late = self.enqueue(proposal, account, "support")
        held = self.root / "wla4-held.json"
        wait_for(held.exists, bool, "real Manager success frame to be held")
        frame = json.loads(held.read_text())
        check(frame["runId"] == late and frame["status"] == "succeeded", "proxy must hold a genuine success")
        self.act(proposal, "cancel")
        site["success"]["visibleSelector"] = "#missing-in-new-proposal"
        newer = self.propose(workspace, config, "這次用另一個尚待驗證的成功條件。")
        if not newer["scopeConfirmed"]:
            newer = self.act(newer, "confirm-scope")
        newer_run = self.verify(newer, account, "support", {"failed", "timed_out"}, {"login_not_verified", "timed_out"})
        check(not self.site(newer, support)["ready"], "replacement proposal needs its own evidence")
        self.root.joinpath("wla4-arm.json").unlink()
        self.root.joinpath("wla4-release").touch()
        forwarded = self.root / "wla4-forwarded.json"
        wait_for(forwarded.exists, bool, "unchanged success frame to reach the Server")
        check(json.loads(forwarded.read_text()) == frame, "must forward the original Worker result")
        self.terminal(late, {"cancelled", "failed", "interrupted"})
        self.act(newer, "confirm", 409, "workspace_setup_incomplete")
        latest = self.proposal(newer)
        check(not self.site(latest, support)["ready"] and self.account(latest, support, account)["runId"] == newer_run,
              "late success overwrote the replacement proposal's verification")
        self.act(newer, "cancel")
        self.checks["A3"] = {"mfaRunId": challenge, "rejectedRunId": failed, "retryRunId": succeeded,
                              "replacementRunId": newer_run, "lateWorkerResult": frame}

    def update_account_metadata(self, workspace, owner, other):
        from playwright.sync_api import expect

        workspace_path = f"/api/workspaces/{workspace}"
        self.api("PUT", workspace_path + "/members/dev-qa", data={"role": "qa"})
        qa = self.adm.login(self.browser, self.base, self.key, "dev-qa")
        initial = self.workspace(workspace)
        self.api("GET", workspace_path, page=qa)
        self.open_settings(initial["name"])
        panel = self.panel("settings").get_by_role("region", name="測試帳號維護", exact=True)
        editor = panel.locator("form")
        purposes = ("建立驗收訂單", "檢查別的會員看不到驗收訂單")
        for account, name, purpose in zip((owner, other), ("會員 A", "會員 B"), purposes):
            before = self.workspace(workspace)
            path = workspace_path + f"/test-accounts/{account}"
            patch = {"revision": before["revision"], "name": name, "role": "會員", "purpose": purpose}
            self.api("PATCH", path, 403, patch, "forbidden", page=qa)
            row = panel.locator(f'[data-account-id="{account}"]')
            edit = row.get_by_role("button", name=f"編輯 {name} 的說明", exact=True)
            edit.click()
            expect(editor.locator('input[name="name"]')).to_have_value(name)
            editor.locator('textarea[name="purpose"]').fill(purpose)
            with self.admin.expect_response(lambda response: response.url.endswith(path) and response.request.method == "PATCH") as saved:
                editor.get_by_role("button", name="保存帳號說明", exact=True).click()
            after = clean(self.adm.checked(saved.value, 200))
            check(after["revision"] > before["revision"], "account metadata needs a new Workspace revision")
            expect(editor).to_have_count(0)
            expect(row.get_by_text(purpose, exact=True)).to_be_visible()
            expect(edit).to_be_enabled()
        check(initial["siteReadiness"] == self.workspace(workspace)["siteReadiness"], "metadata edit must preserve evidence")
        self.checks["A4"] = {"metadataUpdated": True, "qaWrite": 403}
        return purposes

    def rotation(self, workspace, owner, other):
        active = self.workspace(workspace)
        orders, support = self.origins["orders"], self.origins["support"]
        proposal = self.propose(workspace, active["settings"], "將訂單站第一個帳號改用新的測試憑證。")
        previous = self.account(proposal, orders, owner)
        check(previous["state"] == "verified", "pre-rotation proof is visible in the draft")
        good = self.account(proposal, orders, other)
        separate_site = self.account(proposal, support, other)
        rotated = self.save_credentials(proposal, owner, (self.credentials[0][0], f"wla4-secret-{uuid4().hex}"))
        current = self.proposal(proposal)
        check(self.account(current, orders, owner)["state"] != "verified", "rotated draft credential must require verification")
        check(self.account(current, orders, other) == good and self.account(current, support, other) == separate_site,
              "rotating one account must preserve the unrelated evidence")
        check(self.workspace(workspace)["siteReadiness"] == active["siteReadiness"], "rotation touched the confirmed read model")
        applied = self.act(current, "confirm")["workspace"]
        check(self.site(applied, orders)["ready"] and self.account(applied, orders, owner)["state"] != "verified",
              "another verified account must keep the target eligible")
        self.checks["A4"].update(rotatedVersion=rotated, otherAccountEvidencePreserved=True)

    def runtime(self, workspace, engine):
        path = f"/api/workspaces/{workspace}/agent-runtime"
        current = self.workspace(workspace)
        self.api("PATCH", path, data={"revision": current["revision"], "profileId": f"wla4-{engine}", "skillProfiles": {}})

    def author(self, workspace, label, payload):
        route, draft = self.adm.author_draft(self.admin, self.base, workspace, label)
        request = {**draft, "content": command("author", payload)}
        run = self.api("POST", route + "/messages", 202, request)["run"]
        return route, run["id"]

    def expect_author_marker(self, route, run_id, marker):
        run = self.terminal(run_id, {"succeeded"})
        if (partial := run.get("authorPartial")) is not None:
            requests = (partial.get("usage") or {}).get("modelRequests", "unknown")
            raise AssertionError(f"Run {run_id} returned {partial['reason']} after {requests} model requests")
        messages = self.api("GET", route + "/conversation")["messages"]
        check(any(row["role"] == "assistant" and row.get("runId") == run_id and row["content"] == marker
                  for row in messages), f"Run {run_id} did not deliver the expected assistant marker {marker}")

    def managed_entrypoints(self, workspace, empty, purposes, engines):
        payload = {"target": self.origins["orders"], "wrongTarget": self.origins["support"],
                   "ownerPurpose": purposes[0], "otherPurpose": purposes[1]}
        for engine in engines:
            self.stage = f"A5 {engine}"
            self.runtime(workspace, engine)
            route, run_id = self.author(workspace, f"WLA4 {engine} 會員工具", payload)
            self.expect_author_marker(route, run_id, f"WLA4 {engine}：錯站拒絕，已讀到受保護商品頁。")

            self.runtime(empty, engine)
            route, missing_run = self.author(empty, f"WLA4 {engine} 缺少帳號", {"missing": True})
            self.expect_author_marker(route, missing_run, f"WLA4 {engine}：缺少適用的會員測試帳號，請補充。")
            dispatches = [json.loads(line) for line in self.root.joinpath("wla4-author-dispatches.jsonl").read_text().splitlines()]
            attempts = {row["runId"]: row for row in dispatches if row["runId"] in (run_id, missing_run)}
            check(set(attempts) == {run_id, missing_run} and all(row["engine"] == engine for row in attempts.values()),
                  f"Manager dispatch must pin {engine} for both author Runs")
            self.checks["A5"][engine] = {"runId": run_id, "attemptId": attempts[run_id]["attemptId"],
                                         "missingAccountRunId": missing_run}

    def mcp_client(self, workspace):
        issued = self.api("POST", f"/api/workspaces/{workspace}/agent-tokens", 201, {"name": "WLA4 acceptance"})
        return self.adm.MCP(self.admin.request, self.base, issued["token"])

    @staticmethod
    def mcp_reply(mcp, name, args, meta=None):
        reply = clean(mcp.tool(name, args, meta))
        operation = f"{name}/{args['name']}" if name == "task_tool_call" else name
        check(isinstance(reply, dict), f"MCP {operation} must return a result object")
        is_error = reply.get("isError", False)
        check(type(is_error) is bool, f"MCP {operation} must use a boolean isError")
        payload = reply.get("structuredContent")
        check(isinstance(payload, dict) and payload, f"MCP {operation} must return structuredContent (isError={is_error})")
        return operation, is_error, payload

    def tool(self, mcp, name, args, *, code=None, meta=None):
        operation, is_error, payload = self.mcp_reply(mcp, name, args, meta)
        check(is_error == (code is not None), f"unexpected MCP result for {operation}")
        if code is not None:
            check(payload.get("error") == code, f"MCP {operation} must return structuredContent.error={code}")
        return payload

    def open_lease(self, mcp):
        lease = self.tool(mcp, "browser_session_open", {"requestId": str(uuid4())})
        ids = {key: lease[key] for key in ("sessionId", "leaseId")}
        ready = wait_for(lambda: self.tool(mcp, "browser_session_status", ids), lambda row: row["state"] == "ready", "MCP lease ready")
        return ids, ready["testAccounts"]

    def close_lease(self, mcp, ids):
        closed = self.tool(mcp, "browser_session_close", ids)
        check(all(closed.get(key) == value for key, value in ids.items()) and
              closed.get("state") in {"closing", "reclaim_pending", "closed"} and type(closed.get("reclaimed")) is bool,
              "MCP browser_session_close must return the lease state")
        wait_for(lambda: self.tool(mcp, "browser_session_status", ids), lambda row: row["reclaimed"], "MCP lease reclaimed")

    @staticmethod
    def assert_directory(directory, owner, other, purposes, origin):
        by_id = {row["accountId"]: row for row in directory}
        for account, purpose in zip((owner, other), purposes):
            row = by_id.get(account)
            check(row and row["role"] == "會員" and row["purpose"] == purpose and
                  {"targetOrigin": origin, "state": "verified"} in row["sites"], "fresh authorized directory omitted account metadata")

    def interactive_mcp(self, mcp, foreign, owner, other, purposes):
        orders, support = self.origins["orders"], self.origins["support"]
        self.stage = "A5 MCP interactive open"
        ids, directory = self.open_lease(mcp)
        self.assert_directory(directory, owner, other, purposes, orders)

        def metadata(lease):
            return {"whippet": {**lease, "callId": str(uuid4())}}

        def login(account, target):
            return {"accountId": account, "targetOrigin": target}

        try:
            self.stage = "A5 MCP interactive wrong-site login"
            self.tool(mcp, "browser_login_account", login(owner, support), code=DENIED, meta=metadata(ids))
            self.stage = "A5 MCP interactive authorized login"
            submitted = self.tool(mcp, "browser_login_account", login(owner, orders), meta=metadata(ids))
            check(submitted.get("submitted") is True, "interactive account login failed")
            self.stage = "A5 MCP interactive protected page"
            view = self.tool(mcp, "browser_navigate", {"url": orders + "/products"}, meta=metadata(ids))
            check(AUTHENTICATED in view["snapshot"], "interactive lease must reach a protected page")
            self.stage = "A5 MCP interactive close"
        finally:
            self.close_lease(mcp, ids)
        self.stage = "A5 MCP interactive guest lease"
        empty, directory = self.open_lease(foreign)
        try:
            check(directory == [], "visitor Workspace must have an empty account directory")
            self.stage = "A5 MCP interactive foreign account"
            self.tool(foreign, "browser_login_account", login(owner, orders), code=DENIED, meta=metadata(empty))
            self.stage = "A5 MCP interactive guest close"
        finally:
            self.close_lease(foreign, empty)
        self.checks["A5"]["mcpInteractive"] = {"allowed": True, "wrongSite": DENIED, "foreignAccount": DENIED,
                                                "missingAccounts": True, "sessionId": ids["sessionId"]}

    def set_author_engine(self, workspace, engine):
        prior = self.workspace(workspace)
        if prior["authorEngine"] != engine:
            self.api("PATCH", f"/api/workspaces/{workspace}/author-engine", data={"revision": prior["revision"], "authorEngine": engine})

    def claim(self, mcp, run_id):
        task = self.tool(mcp, "task_claim", {"requestId": str(uuid4())})["task"]
        check(task and task["runId"] == run_id, "MCP must claim the Run created by the test conversation")
        ids = {key: task[key] for key in ("runId", "attemptId", "leaseId")}
        return task, ids

    def task_tool(self, mcp, ids, name, args, code=None):
        return self.tool(mcp, "task_tool_call", {**ids, "name": name, "arguments": args, "callId": str(uuid4())}, code=code)

    def submit_task(self, mcp, ids, output):
        args = {**ids, "submitId": str(uuid4()), "output": output}

        def submit():
            _, is_error, receipt = self.mcp_reply(mcp, "task_submit", args)
            if is_error and receipt.get("error") == "busy":
                return None
            check(not is_error and receipt.get("state") == "submitted" and
                  "appliedRevision" in receipt and "validationRunId" in receipt,
                  "MCP task_submit must return a submitted receipt")
            return receipt

        return wait_for(submit, bool, "MCP submission after browser reclamation", timeout=30)

    def report(self, run_id):
        run = self.terminal(run_id, {"succeeded"})
        check(run["kind"] == "validation", "expected independent Playwright validation")
        report = self.admin.request.get(self.base + f"/api/runs/{run_id}/artifacts/report.html")
        check(report.status == 200 and "text/html" in report.headers["content-type"] and len(report.body()) > 100,
              "Worker must publish a genuine Playwright HTML report")
        check(not SENTINEL.search(report.text()), "synthetic credentials in HTML report")

    def claimed_mcp(self, mcp, foreign, workspace, empty, owner, other, purposes):
        orders, support = self.origins["orders"], self.origins["support"]
        self.stage = "A5 MCP claim acquire"
        self.set_author_engine(workspace, "external")
        route, run_id = self.author(workspace, "WLA4 外部雙身分訂單", {"target": orders})
        task, ids = self.claim(mcp, run_id)
        bundle = task["contextBundle"]
        context = bundle["workspaceContext"]
        check("accountBindings" not in context, "MCP claim exposed private binding information")
        check("browser_login_account" in bundle["author"]["allowedTools"], "claim is missing the scoped login tool")
        self.assert_directory(context["testAccounts"], owner, other, purposes, orders)
        check(self.tool(mcp, "task_heartbeat", ids).get("state") == "active", "MCP claim must remain active")
        self.stage = "A5 MCP claim wrong-site login"
        self.task_tool(mcp, ids, "browser_login_account", {"accountId": owner, "targetOrigin": support}, DENIED)
        self.stage = "A5 MCP claim authorized login"
        submitted = self.task_tool(mcp, ids, "browser_login_account", {"accountId": owner, "targetOrigin": orders})
        check(submitted.get("submitted") is True, "claimed account login failed")
        self.stage = "A5 MCP claim protected page"
        view = self.task_tool(mcp, ids, "browser_navigate", {"url": orders + "/products"})
        check(AUTHENTICATED in view["snapshot"], "claimed browser must reach its protected page")
        self.stage = "A5 MCP claim submit"
        candidate = order_script(orders, owner, other)
        submitted = self.submit_task(mcp, ids, {"message": "雙身分訂單候選腳本", "script": candidate, "requestValidation": True})
        validation = submitted["validationRunId"]
        check(bool(validation), "MCP candidate must enqueue an independent Worker validation")
        self.report(validation)
        check(self.api("GET", route + "/draft")["script"] == candidate, "verified draft must be the submitted account-ID script")

        self.stage = "A5 MCP claim guest claim"
        self.set_author_engine(empty, "external")
        route, missing_run = self.author(empty, "WLA4 外部帳號缺項", {"missing": True})
        task, missing_ids = self.claim(foreign, missing_run)
        bundle = task["contextBundle"]
        context = bundle["workspaceContext"]
        check(context.get("testAccounts", []) == [] and "accountBindings" not in context and
              "browser_login_account" not in bundle["author"]["allowedTools"], "claim on guest scope must grant no account access")
        self.stage = "A5 MCP claim foreign account"
        self.task_tool(foreign, missing_ids, "browser_login_account", {"accountId": owner, "targetOrigin": orders}, DENIED)
        missing = "缺少適用的會員測試帳號，請補充。"
        self.stage = "A5 MCP claim guest submit"
        receipt = self.submit_task(foreign, missing_ids, {"message": missing, "requestValidation": False})
        check(receipt["validationRunId"] is None, "missing account reply must not enqueue validation")
        self.terminal(missing_run, {"succeeded"})
        messages = self.api("GET", route + "/conversation")["messages"]
        check(any(row["content"] == missing and row["role"] == "assistant" for row in messages), "external account gap must reach the user")
        self.set_author_engine(workspace, "builtin")
        self.set_author_engine(empty, "builtin")
        self.checks["A5"]["mcpClaim"] = {"runId": run_id, "validationRunId": validation, "wrongSite": DENIED,
                                         "missingAccountRunId": missing_run, "foreignAccount": DENIED}

    def legacy(self):
        workspace = LEGACY_WORKSPACE
        orders = self.origins["orders"]
        path = f"/api/workspaces/{workspace}"
        existing = self.workspace(workspace)
        self.api("PUT", path + f"/roles/{LEGACY_ROLE}/credentials", data={"expectedSecretVersion": 0,
                 "username": self.credentials[0][0], "password": self.credentials[0][1]})
        route, draft = self.adm.author_draft(self.admin, self.base, workspace, "WLA4 v8 相容腳本")
        script = f'''import {{test, expect}} from '@playwright/test';
import {{loginAs}} from 'whippet/login';
test('original v8 role', async ({{page}}) => {{
  await page.goto({json.dumps(orders + '/login')});
  await loginAs(page, {json.dumps(LEGACY_ROLE)}, 'input[name="username"]', 'input[name="password"]', 'button[type="submit"]');
  await expect(page.getByTestId('account-state')).toBeVisible();
}});'''
        saved = self.api("PUT", route + "/draft", data={**draft, "script": script})
        run_id = self.api("POST", route + "/draft/validate", 202, {**draft, "revision": saved["revision"]})["id"]
        self.report(run_id)
        before = self.run(run_id)["workspaceContext"]
        self.open_settings(existing["name"])
        config = copy.deepcopy(self.workspace(workspace)["settings"])
        config["targets"][0]["testScope"] = "unknown"
        config["testAccounts"] = [{"accountId": LEGACY_ROLE, "name": "會員", "role": "會員", "purpose": "沿用 v8 帳號",
                                  "sites": [binding(orders)]}]
        pending = self.propose(workspace, config, "先重開既有設定，登入測試範圍還待補答。", web=True)
        check(self.site(pending, orders)["reason"] == "scope_choice_required", "legacy targets need an explicit scope")
        config["targets"][0]["testScope"] = "authenticated"
        pending = self.propose(workspace, config, "這個舊站要測登入後流程。", web=True)
        check(self.account(pending, orders, LEGACY_ROLE)["state"] != "verified", "legacy role may not create login evidence")
        self.act(pending, "confirm", 409, "workspace_setup_incomplete")
        self.runtime(workspace, "vercel")  # A real settings revision change while the proposal is open.
        self.act(pending, "confirm", 409, "conflict")
        check(self.workspace(workspace)["lifecycle"] == "active", "legacy confirmed settings must stay active")
        upgraded = self.propose(workspace, config, "沿用原帳號，補齊舊站的逐站證據。")
        if not upgraded["scopeConfirmed"]:
            upgraded = self.act(upgraded, "confirm-scope")
        evidence = self.verify(upgraded, LEGACY_ROLE, "orders", {"succeeded"})
        self.act(upgraded, "confirm")
        check(self.run(run_id)["workspaceContext"] == before, "historic Run snapshot was mutated")
        current = self.api("GET", route + "/draft")
        rerun = self.api("POST", route + "/draft/validate", 202,
                         {"editingSessionId": current["editingSessionId"], "revision": current["revision"]})["id"]
        self.report(rerun)
        self.checks["A6"] = {"workspaceId": workspace, "legacyRoleId": LEGACY_ROLE, "legacyValidationRunId": run_id,
                              "proposalVerificationRunId": evidence, "upgradedValidationRunId": rerun,
                              "missingEvidence": 409, "staleRevision": 409}

    def final(self, focus):
        if focus == "a6":
            self.stage = "A6"
            self.legacy()
            return
        entries = A5_ENTRIES if focus in (None, "a5") else ()
        if focus in A5_ENTRIES:
            entries = (focus,)
        empty = None
        if entries:
            self.stage = "A1" if focus is None else "prepare guest Workspace"
            empty = self.w1(guest_only=focus is not None)
        exercise_partial = focus in (None, "a2")
        self.stage = "A2" if exercise_partial else "prepare verified accounts"
        workspace, owner, other = self.multi_site(exercise_partial=exercise_partial)
        if focus == "a2":
            return
        if focus in (None, "a3"):
            self.stage = "A3"
            self.retry_and_late_result(workspace, other)
        if focus == "a3":
            return
        purposes = ACCOUNT_PURPOSES
        if focus in (None, "a4"):
            self.stage = "A4 metadata"
            purposes = self.update_account_metadata(workspace, owner, other)
        if entries:
            self.checks["A5"] = {}
            self.managed_entrypoints(workspace, empty, purposes, [entry for entry in entries if entry in MANAGED_ENGINES])
            if "mcp-interactive" in entries or "mcp-claim" in entries:
                mcp, foreign = self.mcp_client(workspace), self.mcp_client(empty)
                if "mcp-interactive" in entries:
                    self.stage = "A5 MCP interactive"
                    self.interactive_mcp(mcp, foreign, owner, other, purposes)
                if "mcp-claim" in entries:
                    self.stage = "A5 MCP claim"
                    self.claimed_mcp(mcp, foreign, workspace, empty, owner, other, purposes)
        if focus in (None, "a4"):
            self.stage = "A4 rotation"
            self.rotation(workspace, owner, other)
        if focus is None:
            self.stage = "A6"
            self.legacy()


def order_script(origin, owner, other):
    return f'''import {{test, expect}} from '@playwright/test';
import {{loginAsAccount}} from 'whippet/login';
test('only the ordering account can see its order', async ({{page, browser}}) => {{
  const origin = {json.dumps(origin)};
  await loginAsAccount(page, {json.dumps(owner)}, origin);
  await page.goto(origin + '/products');
  await expect(page.getByTestId('account-state')).toBeVisible();
  await Promise.all([page.waitForURL('**/orders/*'), page.getByRole('button', {{name:'Create synthetic order'}}).click()]);
  await expect(page.getByTestId('status')).toHaveText('confirmed');
  const orderUrl = page.url();
  const context = await browser.newContext();
  try {{
    const other = await context.newPage();
    await loginAsAccount(other, {json.dumps(other)}, origin);
    await other.goto(origin + '/products');
    await expect(other.getByTestId('account-state')).toBeVisible();
    expect((await other.goto(orderUrl))?.status()).toBe(404);
    await expect(other.getByRole('heading')).toHaveText('Order not found');
  }} finally {{ await context.close(); }}
}});'''


def main():
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--browser-executable", type=Path)
    parser.add_argument("--wave", choices=("w1", "final"), required=True)
    parser.add_argument("--focus", choices=FINAL_FOCUS, help="run one final acceptance case and its prerequisites")
    args = parser.parse_args()
    if args.focus and args.wave != "final":
        parser.error("--focus requires --wave final")
    base = urlsplit(args.base_url)
    if base.scheme != "http" or base.hostname != "127.0.0.1" or not base.port or base.path or base.query or base.fragment:
        parser.error("use the ephemeral loopback Web URL from adm4-local.py --wla")
    if not all(os.environ.get(key) for key in ("ADM_SMOKE_ADMIN_KEY", "WLA4_SCOPE", "WLA4_SITE_CREDENTIALS")):
        parser.error("run through adm4-local.py --wla")
    from playwright.sync_api import sync_playwright

    acceptance = None
    summary = {"wave": args.wave, "status": "failed", "checks": {}}
    if args.focus:
        summary["focus"] = args.focus
    summary_path = args.evidence_dir / "wla4-acceptance.json"
    try:
        with sync_playwright() as playwright:
            executable = str(args.browser_executable) if args.browser_executable else None
            browser = playwright.chromium.launch(headless=True, executable_path=executable)
            try:
                acceptance = Acceptance(load_adm_web(), browser, args.base_url, os.environ["ADM_SMOKE_ADMIN_KEY"], args.evidence_dir)
                summary["checks"] = acceptance.checks
                if args.wave == "final":
                    acceptance.final(args.focus)
                else:
                    acceptance.stage = "A1"
                    acceptance.w1()
            finally:
                browser.close()
        summary["status"] = "passed"
    except Exception as error:
        summary["stage"] = acceptance.stage if acceptance else "setup"
        summary["failure"] = SENTINEL.sub("[redacted]", str(error))[:800]
    finally:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False))
    return summary["status"] != "passed"


if __name__ == "__main__":
    raise SystemExit(main())
