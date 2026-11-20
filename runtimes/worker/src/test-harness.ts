import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { chmod, chown, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startScopeProxy } from "./scope-proxy.js";
import type { WorkspaceConfig } from "./workspace-context.js";

const run = promisify(execFile);
const scriptUID = 65532;
const setpriv = "/usr/bin/setpriv";
const restricted = [
  "--reuid", String(scriptUID), "--regid", String(scriptUID), "--clear-groups",
  "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--",
];

export class TestHarnessError extends Error {
  constructor() { super("test_harness_unavailable: 無法啟用 Workspace 測試網路隔離，已停止執行腳本。"); }
}

export async function startTestHarness(scope: WorkspaceConfig) {
  // Allows known local fixtures to exercise Playwright during development.
  // The production image disables this option and Manager never forwards it.
  const localFixture = process.env.WHIPPET_LOCAL_TEST_FIXTURES === "1";
  if (!localFixture && (process.platform !== "linux" || process.getuid?.() !== 0)) throw new TestHarnessError();
  const proxy = await startScopeProxy(scope).catch(() => { throw new TestHarnessError(); });
  try {
    if (!localFixture) {
      const dir = await mkdtemp(join(tmpdir(), "whippet-firewall-"));
      try {
        const rules = join(dir, "rules.nft");
        // An inet table applies to IPv4 and IPv6 in one transaction. Leave
        // the rules in place for the lifetime of this isolated Docker Worker.
        await writeFile(rules, `add table inet whippet_test
flush table inet whippet_test
table inet whippet_test {
  chain output {
    type filter hook output priority filter; policy accept;
    meta skuid ${scriptUID} oifname "lo" ip daddr 127.0.0.1 tcp dport ${proxy.port} accept
    meta skuid ${scriptUID} reject
  }
}
`, { mode: 0o600 });
        await run("/usr/sbin/nft", ["-f", rules], { timeout: 5000 });
        await run(setpriv, [...restricted, "/usr/bin/true"], { timeout: 5000 });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  } catch {
    await proxy.close();
    throw new TestHarnessError();
  }

  return {
    networkIsolated: !localFixture,
    proxy: { server: proxy.url },
    reachedTargetOrigin: proxy.reachedTargetOrigin,
    credentialUID: localFixture ? undefined : scriptUID,
    async grantAccess(path: string) {
      if (!localFixture) await chown(path, scriptUID, scriptUID);
    },
    async configureTask(parent: string, task: string) {
      if (!localFixture) {
        await chmod(parent, 0o711);
        await chown(task, scriptUID, scriptUID);
      }
    },
    spawn(args: string[], options: SpawnOptions & { cwd: string }, env: NodeJS.ProcessEnv) {
      const proxyEnv = {
        ...env, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, http_proxy: proxy.url,
        https_proxy: proxy.url, NO_PROXY: "", no_proxy: "", ALL_PROXY: "", all_proxy: "",
        NODE_USE_ENV_PROXY: "1", ...(!localFixture ? { HOME: options.cwd } : {}),
      };
      return localFixture
        ? spawn(process.execPath, args, { ...options, env: proxyEnv })
        : spawn(setpriv, [...restricted, process.execPath, ...args], { ...options, env: proxyEnv });
    },
    async stopScripts() {
      if (localFixture) return;
      try {
        await run("/usr/bin/pkill", ["-KILL", "-u", String(scriptUID)], { timeout: 3000 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === 1)) throw new TestHarnessError();
      }
    },
    close: proxy.close,
  };
}

export type TestHarness = Awaited<ReturnType<typeof startTestHarness>>;
