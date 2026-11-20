import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { assertionDigest, deploymentProbe, RetestChecks, watchDeployment, type RetestTarget } from "./deployment-retest.js";
import { startScopeProxy } from "./scope-proxy.js";
import { unconfirmedBrowserScope } from "./author/scope.js";

test("deployment proof rejects wrong identity and binds actual target responses between probes", async t => {
  const target: RetestTarget = {
    origin: "", proofPath: "/.well-known/deployment.json", projectSlug: "sandbox-todomvc", environment: "qa",
    deploymentId: "deploy-a", artifactRevision: "artifact-a",
  };
  let release = { deploymentId: target.deploymentId, artifactRevision: target.artifactRevision };
  const site = createServer((req, res) => {
    res.setHeader("X-Whippet-Deployment-Id", release.deploymentId);
    res.setHeader("X-Whippet-Artifact-Revision", release.artifactRevision);
    res.end(req.url === target.proofPath
      ? JSON.stringify({ ...release, projectSlug: target.projectSlug, environment: target.environment })
      : "model content");
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  t.after(() => { site.closeAllConnections(); site.close(); });
  target.origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  assert.equal(await deploymentProbe(target), true);
  assert.equal(await deploymentProbe({ ...target, deploymentId: "old-deployment" }), false);
  assert.equal(await deploymentProbe({ ...target, environment: "stage" }), false);

  const proxy = await startScopeProxy({
    ...unconfirmedBrowserScope(),
    targets: [{ name: "QA", origin: target.origin, purpose: "test" }],
    defaultTestUrl: target.origin,
  }, target);
  const read = () => new Promise<void>((resolve, reject) => {
    request(proxy.url, { path: target.origin + "/model.js" }, response => {
      if (response.statusCode !== 200) reject(new Error("proxy did not reach the fixture"));
      response.resume().once("end", resolve);
    }).once("error", reject).end();
  });
  t.after(() => proxy.close());
  const watch = await watchDeployment(target);
  t.after(() => watch.close());
  assert.ok(watch.ready);
  assert.equal(proxy.verifiedDeploymentTraffic(), false);
  await read();
  assert.ok(proxy.verifiedDeploymentTraffic());

  // A wrong deployment served actual test code before changing back. A new
  // probe of the current deployment can pass, but the observation stays bad.
  release = { deploymentId: "deploy-b", artifactRevision: "artifact-b" };
  await read();
  release = { deploymentId: target.deploymentId, artifactRevision: target.artifactRevision };
  assert.ok(await deploymentProbe(target));
  assert.equal(proxy.verifiedDeploymentTraffic(), false);
  await watch.finish();
});

test("named native expectations supply checked pass/failure and omit skipped or ambiguous steps", () => {
  const cases = new RetestChecks();
  const entry = { title: "save todo", expectedStatus: "passed" } as const;
  const skipped = { title: "discard todo", expectedStatus: "passed" } as const;
  const category = "expect";
  const add = (title: string, error?: { message: string }) => cases.step(entry, { category, title, error });
  const failure = { message: "asserted condition failed" };
  add("typed title");
  add("focused");
  add("focused");
  add("blank titles ignored", failure);
  cases.finishTest(entry, { status: "failed", errors: [failure] });
  cases.finishTest(skipped, { status: "skipped", errors: [] });
  assert.deepEqual(cases.observations(), {
    [assertionDigest("save todo", "typed title")]: "passed",
    [assertionDigest("save todo", "blank titles ignored")]: "failed",
  });
  const broken = new RetestChecks();
  broken.step(entry, { category: "pw:api", title: "goto", error: failure });
  broken.finishTest(entry, { status: "failed", errors: [failure] });
  assert.equal(broken.observations(), undefined);
});
