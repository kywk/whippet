#!/usr/bin/env python3
"""Exercise the v15 Workspace login contract through the isolated ADM-4 launcher."""

import argparse
import copy
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


def configure(server, manager, docker, image):
    label = docker("image", "inspect", image, "--format", '{{index .Config.Labels "org.whippet.acceptance"}}',
                   check=True).stdout.strip()
    if label != "wla4":
        raise RuntimeError("--wla requires the derived image from scripts/test/wla4-worker.Dockerfile")
    server["WHIPPET_AI_RUNTIME_PROFILES_JSON"] = json.dumps([
        {"id": f"wla4-{engine}", "engine": engine, "provider": "openai-responses", "model": f"wla4-{engine}",
         "baseURL": MODEL_ORIGIN, "reasoningEffort": "low", "contextWindowTokens": 32768, "contextInputTokens": 16384}
        for engine in ("builtin", "vercel", "pi")
    ])
    server.update(WHIPPET_AI_PROVIDER="openai-responses", WHIPPET_AI_BASE_URL=MODEL_ORIGIN,
                  WHIPPET_AI_MODEL="wla4-builtin", WHIPPET_AI_CONTEXT_WINDOW_TOKENS="32768",
                  WHIPPET_AI_CONTEXT_INPUT_TOKENS="16384")
    manager.update(WHIPPET_AI_ENABLED="true", WHIPPET_AI_PROVIDER="openai-responses",
                   WHIPPET_AI_API_KEY="wla4-provider-key", OPENCODE_API_KEY="wla4-provider-key", WHIPPET_AI_BASE_URL=MODEL_ORIGIN,
                   WHIPPET_AI_MODEL="wla4-builtin", WHIPPET_AI_CONTEXT_WINDOW_TOKENS="32768",
                   WHIPPET_AI_CONTEXT_INPUT_TOKENS="16384")


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
        await_ready(lambda: docker("exec", name, "node", "-e",
                                   "require('node:http').get('http://127.0.0.1:8080/healthz',r=>{r.resume();"
                                   "process.exitCode=Number(r.statusCode!==200)}).on('error',()=>process.exit(1))")
                    .returncode == 0, f"isolated shop {site} did not start")
        ip = docker("inspect", name, "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", check=True).stdout.strip()
        if not ipaddress.IPv4Address(ip).is_private:
            raise RuntimeError("shop must use a private Docker bridge address")
        if site == "orders":
            origins.update(auth=f"http://{ip}:8080", orders=f"http://{ip}:8081", support=f"http://{ip}:8082")
            containers.update(orders=name, support=name)
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

    def card(self, proposal):
        card = self.admin.locator(f'[data-proposal-id="{proposal["id"]}"]')
        toggle = self.admin.get_by_role("button", name="提案與登入資料", exact=True)
        if toggle.is_visible():
            toggle.click()
        card.wait_for()
        return card

    def apply_from_web(self, proposal):
        card = self.card(proposal)
        checkbox = card.get_by_role("checkbox", name=re.compile("我已檢視"))
        if checkbox.count():
            checkbox.check()
        with self.admin.expect_response(lambda response: response.url.endswith(self.proposal_path(proposal) + "/confirm") and
                                        response.request.method == "POST") as saved:
            card.get_by_role("button", name="確認並套用提案", exact=True).click()
        return clean(self.adm.checked(saved.value, 200))["workspace"]

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

    def w1(self):
        name = "WLA4 訪客說明站"
        workspace = self.create_from_web(name)
        origin = self.origins["guest"]
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

    def save_credentials(self, proposal, account, credentials):
        state = next(row for row in self.proposal(proposal)["accountCredentials"] if row["accountId"] == account)
        path = self.proposal_path(proposal) + f"/test-accounts/{account}/credentials"
        result = self.api("PUT", path, data={"baseRevision": proposal["baseRevision"],
                                            "expectedSecretVersion": state["secretVersion"] or 0,
                                            "username": credentials[0], "password": credentials[1]})
        check(result["configured"] and result["secretVersion"] > (state["secretVersion"] or 0), "new credential version")
        return result["secretVersion"]

    def enqueue(self, proposal, account, site, *, check_replay=False):
        request = {"baseRevision": proposal["baseRevision"], "requestId": str(uuid4()),
                   "accountId": account, "targetOrigin": self.origins[site]}
        path = self.proposal_path(proposal) + "/verify-login"
        run = self.api("POST", path, 202, request)["run"]
        check(run["kind"] == "workspace_login_verification" and run["testId"] is None, "expected Workspace verification Run")
        if check_replay:
            check(self.api("POST", path, 202, request)["run"]["id"] == run["id"], "request replay queued another Run")
        return run["id"]

    def verify(self, proposal, account, site, expected, reason=None, *, check_replay=False):
        run_id = self.enqueue(proposal, account, site, check_replay=check_replay)
        run = self.terminal(run_id, expected)
        state = self.account(self.proposal(proposal), self.origins[site], account)
        check(state["runId"] == run_id and (state["state"] == "verified") == (run["status"] == "succeeded"),
              "proposal account state must reflect that Run")
        if reason is not None:
            check(state["reason"] in reason, "unexpected verification failure reason")
        return run_id

    def shop_count(self, site, line):
        result = subprocess.run(["docker", "logs", self.containers[site]], capture_output=True, text=True, check=True, timeout=10)
        return result.stdout.splitlines().count(line)

    def multi_site(self):
        guest, orders, support, auth = (self.origins[key] for key in ("guest", "orders", "support", "auth"))
        name = "WLA4 商店與客服"
        workspace = self.create_from_web(name)
        accounts = [
            {"accountId": None, "name": "會員 A", "role": "會員", "purpose": "建立訂單",
             "sites": [binding(orders, login_origin=auth)]},
            {"accountId": None, "name": "會員 B", "role": "會員", "purpose": "檢查他人的訂單不可見",
             "sites": [binding(orders, login_origin=auth), binding(support, "#absent-after-submit", login_origin=auth)]},
        ]
        config = configuration(name, [("訪客站", guest, "guest"), ("訂單站", orders, "authenticated"),
                                      ("客服站", support, "both")], accounts)
        config["dependencies"] = [{"name": "共用登入", "origin": auth, "purpose": "login"}]
        proposal = self.propose(workspace, config, "已記下三個站台的驗測範圍。", web=True)
        ids = {row["name"]: row["accountId"] for row in proposal["content"]["testAccounts"]}
        owner, other = ids["會員 A"], ids["會員 B"]
        check(str(owner) != str(other), "same-role choices need two different IDs")
        self.save_credentials(proposal, owner, self.credentials[0])
        self.save_credentials(proposal, other, self.credentials[1])
        proposal = self.act(proposal, "confirm-scope")
        orders_run = self.verify(proposal, owner, "orders", {"succeeded"}, check_replay=True)
        self.verify(proposal, other, "orders", {"succeeded"})
        submissions = self.shop_count("support", "POST /login 303")
        submit_only = self.verify(proposal, other, "support", {"failed", "timed_out"}, {"login_not_verified", "timed_out"})
        check(self.shop_count("support", "POST /login 303") > submissions, "partial failure must follow a real form submit")
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
            proposal = self.act(proposal, "confirm-scope")
        check(self.site(proposal, orders)["ready"], "untouched site evidence must carry to the next proposal")
        support_run = self.verify(proposal, other, "support", {"succeeded"})
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
        rejects = self.shop_count("support", "POST /login 401")
        failed = self.verify(proposal, account, "support", {"failed"}, {"login_rejected"})
        check(self.shop_count("support", "POST /login 401") > rejects, "fixture must reject the submitted wrong password")
        self.open_settings(config["name"])
        check(self.card(proposal).is_visible(), "failed verification must be visible after reopening the draft")
        self.act(proposal, "confirm", 409, "workspace_setup_incomplete")
        self.save_credentials(proposal, account, self.credentials[1])
        succeeded = self.verify(proposal, account, "support", {"succeeded"})
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
        workspace_path = f"/api/workspaces/{workspace}"
        self.api("PUT", workspace_path + "/members/dev-qa", data={"role": "qa"})
        qa = self.adm.login(self.browser, self.base, self.key, "dev-qa")
        initial = self.workspace(workspace)
        self.api("GET", workspace_path, page=qa)
        purposes = ("建立驗收訂單", "檢查別的會員看不到驗收訂單")
        for account, name, purpose in zip((owner, other), ("會員 A", "會員 B"), purposes):
            before = self.workspace(workspace)
            path = workspace_path + f"/test-accounts/{account}"
            patch = {"revision": before["revision"], "name": name, "role": "會員", "purpose": purpose}
            self.api("PATCH", path, 403, patch, "forbidden", page=qa)
            after = self.api("PATCH", path, data=patch)
            check(after["revision"] > before["revision"], "account metadata needs a new Workspace revision")
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

    def managed_entrypoints(self, workspace, empty, purposes):
        payload = {"target": self.origins["orders"], "wrongTarget": self.origins["support"],
                   "ownerPurpose": purposes[0], "otherPurpose": purposes[1]}
        for engine in ("builtin", "vercel", "pi"):
            self.runtime(workspace, engine)
            route, run_id = self.author(workspace, f"WLA4 {engine} 會員工具", payload)
            self.terminal(run_id, {"succeeded"})
            messages = self.api("GET", route + "/conversation")["messages"]
            marker = f"WLA4 {engine}：錯站拒絕，已讀到受保護商品頁。"
            check(any(row["content"] == marker and row["role"] == "assistant" for row in messages),
                  f"{engine} must read a protected page after allowed login and denied wrong-site call")

            self.runtime(empty, engine)
            route, missing_run = self.author(empty, f"WLA4 {engine} 缺少帳號", {"missing": True})
            self.terminal(missing_run, {"succeeded"})
            messages = self.api("GET", route + "/conversation")["messages"]
            marker = f"WLA4 {engine}：缺少適用的會員測試帳號，請補充。"
            check(any(row["content"] == marker and row["role"] == "assistant" for row in messages),
                  f"{engine} must report the absence of a suitable account")
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
    def tool(mcp, name, args, *, code=None, meta=None):
        reply = clean(mcp.tool(name, args, meta))
        check(bool(reply.get("isError")) == bool(code), f"unexpected MCP tool result for {name}")
        payload = reply["structuredContent"]
        if code:
            check(payload.get("error") == code, f"unexpected MCP error for {name}")
        return payload

    def open_lease(self, mcp):
        lease = self.tool(mcp, "browser_session_open", {"requestId": str(uuid4())})
        ids = {key: lease[key] for key in ("sessionId", "leaseId")}
        ready = wait_for(lambda: self.tool(mcp, "browser_session_status", ids), lambda row: row["state"] == "ready", "MCP lease ready")
        return ids, ready["testAccounts"]

    def close_lease(self, mcp, ids):
        self.tool(mcp, "browser_session_close", ids)
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
        ids, directory = self.open_lease(mcp)
        self.assert_directory(directory, owner, other, purposes, orders)

        def metadata(lease):
            return {"whippet": {**lease, "callId": str(uuid4())}}

        def login(account, target):
            return {"accountId": account, "targetOrigin": target}

        try:
            self.tool(mcp, "browser_login_account", login(owner, support), code=DENIED, meta=metadata(ids))
            submitted = self.tool(mcp, "browser_login_account", login(owner, orders), meta=metadata(ids))
            check(submitted.get("submitted") is True, "interactive account login failed")
            view = self.tool(mcp, "browser_navigate", {"url": orders + "/products"}, meta=metadata(ids))
            check(AUTHENTICATED in view["snapshot"], "interactive lease must reach a protected page")
        finally:
            self.close_lease(mcp, ids)
        empty, directory = self.open_lease(foreign)
        try:
            check(directory == [], "visitor Workspace must have an empty account directory")
            self.tool(foreign, "browser_login_account", login(owner, orders), code=DENIED, meta=metadata(empty))
        finally:
            self.close_lease(foreign, empty)
        self.checks["A5"]["mcpInteractive"] = {"allowed": True, "wrongSite": DENIED, "foreignAccount": DENIED,
                                                "missingAccounts": True, "sessionId": ids["sessionId"]}

    def set_external(self, workspace):
        prior = self.workspace(workspace)
        self.api("PATCH", f"/api/workspaces/{workspace}/author-engine", data={"revision": prior["revision"], "authorEngine": "external"})

    def claim(self, mcp, run_id):
        task = self.tool(mcp, "task_claim", {"requestId": str(uuid4())})["task"]
        check(task and task["runId"] == run_id, "MCP must claim the Run created by the test conversation")
        ids = {key: task[key] for key in ("runId", "attemptId", "leaseId")}
        return task, ids

    def task_tool(self, mcp, ids, name, args, code=None):
        return self.tool(mcp, "task_tool_call", {**ids, "name": name, "arguments": args, "callId": str(uuid4())}, code=code)

    def report(self, run_id):
        run = self.terminal(run_id, {"succeeded"})
        check(run["kind"] == "validation", "expected independent Playwright validation")
        report = self.admin.request.get(self.base + f"/api/runs/{run_id}/artifacts/report.html")
        check(report.status == 200 and "text/html" in report.headers["content-type"] and len(report.body()) > 100,
              "Worker must publish a genuine Playwright HTML report")
        check(not SENTINEL.search(report.text()), "synthetic credentials in HTML report")

    def claimed_mcp(self, mcp, foreign, workspace, empty, owner, other, purposes):
        orders, support = self.origins["orders"], self.origins["support"]
        self.set_external(workspace)
        route, run_id = self.author(workspace, "WLA4 外部雙身分訂單", {"target": orders})
        task, ids = self.claim(mcp, run_id)
        context = task["contextBundle"]["workspaceContext"]
        check("accountBindings" not in context, "MCP claim exposed private binding information")
        self.assert_directory(context["testAccounts"], owner, other, purposes, orders)
        self.tool(mcp, "task_heartbeat", ids)
        self.task_tool(mcp, ids, "browser_login_account", {"accountId": owner, "targetOrigin": support}, DENIED)
        submitted = self.task_tool(mcp, ids, "browser_login_account", {"accountId": owner, "targetOrigin": orders})
        check(submitted.get("submitted") is True, "claimed account login failed")
        view = self.task_tool(mcp, ids, "browser_navigate", {"url": orders + "/products"})
        check(AUTHENTICATED in view["snapshot"], "claimed browser must reach its protected page")
        candidate = order_script(orders, owner, other)
        submitted = self.tool(mcp, "task_submit", {**ids, "submitId": str(uuid4()), "output": {
            "message": "雙身分訂單候選腳本", "script": candidate, "requestValidation": True}})
        validation = submitted["validationRunId"]
        check(bool(validation), "MCP candidate must enqueue an independent Worker validation")
        self.report(validation)
        check(self.api("GET", route + "/draft")["script"] == candidate, "verified draft must be the submitted account-ID script")

        self.set_external(empty)
        route, missing_run = self.author(empty, "WLA4 外部帳號缺項", {"missing": True})
        task, missing_ids = self.claim(foreign, missing_run)
        check(task["contextBundle"]["workspaceContext"]["testAccounts"] == [], "claim on guest scope must show no accounts")
        self.task_tool(foreign, missing_ids, "browser_login_account", {"accountId": owner, "targetOrigin": orders}, DENIED)
        missing = "缺少適用的會員測試帳號，請補充。"
        self.tool(foreign, "task_submit", {**missing_ids, "submitId": str(uuid4()), "output": {
            "message": missing, "requestValidation": False}})
        self.terminal(missing_run, {"succeeded"})
        messages = self.api("GET", route + "/conversation")["messages"]
        check(any(row["content"] == missing and row["role"] == "assistant" for row in messages), "external account gap must reach the user")
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

    def final(self, empty):
        workspace, owner, other = self.multi_site()
        self.retry_and_late_result(workspace, other)
        purposes = self.update_account_metadata(workspace, owner, other)
        self.checks["A5"] = {}
        self.managed_entrypoints(workspace, empty, purposes)
        mcp, foreign = self.mcp_client(workspace), self.mcp_client(empty)
        self.interactive_mcp(mcp, foreign, owner, other, purposes)
        self.claimed_mcp(mcp, foreign, workspace, empty, owner, other, purposes)
        self.rotation(workspace, owner, other)
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
    args = parser.parse_args()
    base = urlsplit(args.base_url)
    if base.scheme != "http" or base.hostname != "127.0.0.1" or not base.port or base.path or base.query or base.fragment:
        parser.error("use the ephemeral loopback Web URL from adm4-local.py --wla")
    if not all(os.environ.get(key) for key in ("ADM_SMOKE_ADMIN_KEY", "WLA4_SCOPE", "WLA4_SITE_CREDENTIALS")):
        parser.error("run through adm4-local.py --wla")
    from playwright.sync_api import sync_playwright

    acceptance = None
    summary = {"wave": args.wave, "status": "failed", "checks": {}}
    summary_path = args.evidence_dir / "wla4-acceptance.json"
    try:
        with sync_playwright() as playwright:
            executable = str(args.browser_executable) if args.browser_executable else None
            browser = playwright.chromium.launch(headless=True, executable_path=executable)
            try:
                acceptance = Acceptance(load_adm_web(), browser, args.base_url, os.environ["ADM_SMOKE_ADMIN_KEY"], args.evidence_dir)
                summary["checks"] = acceptance.checks
                guest = acceptance.w1()
                if args.wave == "final":
                    acceptance.final(guest)
            finally:
                browser.close()
        summary["status"] = "passed"
    except Exception as error:
        summary["failure"] = SENTINEL.sub("[redacted]", str(error))[:800]
    finally:
        summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False))
    return summary["status"] != "passed"


if __name__ == "__main__":
    raise SystemExit(main())
