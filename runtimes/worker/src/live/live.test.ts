import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { mediaEnvironment, readControl, replaceFile } from "./files.js";
import { VideoHelper } from "./helper.js";
import { fixtureBridge } from "./fixture-bridge.js";

test("live lease expires and does not expose credentials through browser env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whippet-live-"));
  try {
    const control = { viewerId: "11111111-1111-4111-8111-111111111111", mode: "jpeg", expiresAt: Date.now() + 10000, iceServers: [] };
    await replaceFile(join(dir, "control.json"), JSON.stringify(control));
    assert.equal((await readControl(dir))?.viewerId, control.viewerId);
    assert.equal(await readControl(dir, control.expiresAt), undefined);
    await writeFile(join(dir, "control.json"), " ".repeat(192 * 1024 + 1));
    assert.equal(await readControl(dir), undefined);
    assert.deepEqual(mediaEnvironment({ PATH: "/bin", OPENCODE_API_KEY: "test-only", MANAGER_TOKEN: "test-only" }), { PATH: "/bin" });
    const bridge = fixtureBridge("file:///fixture/observer.js");
    assert.match(bridge, /require\('playwright\/test'\)/);
    assert.match(bridge, /await use\(browser\)/);
    assert.match(bridge, /live\.close\(\)\.catch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Chromium screencast becomes decoded WebRTC video, then test page continues", {
  skip: process.env.WHIPPET_LIVE_BROWSER_TEST !== "1", timeout: 45000,
}, async () => {
  const browser = await chromium.launch({ headless: true, env: mediaEnvironment(process.env) });
  const helper = new VideoHelper();
  const source = await browser.newPage();
  const receiver = await browser.newPage();
  let latest: Buffer | undefined;
  try {
    await source.setContent('<body style="background:#18a"><h1>Live synthetic frame</h1><script>let i=0;setInterval(()=>document.querySelector("h1").textContent="Live "+(++i),100)</script>');
    await source.screencast.start({ size: { width: 1280, height: 720 }, quality: 55, fps: 3, onFrame: ({ data }) => { latest = data; } });
    const offer = await helper.start([]);
    assert.match(offer, /m=video /);
    assert.doesNotMatch(offer, /m=application /);
    const answer = await receiver.evaluate(async (sdp) => {
      const pc = new RTCPeerConnection();
      const video = document.createElement("video"); video.autoplay = true; video.muted = true;
      document.body.append(video);
      (window as unknown as { peer: RTCPeerConnection }).peer = pc;
      pc.ontrack = (event) => { video.srcObject = event.streams[0]!; void video.play(); };
      await pc.setRemoteDescription({ type: "offer", sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } };
      });
      return pc.localDescription!.sdp;
    }, offer);
    await helper.answer(answer);
    const until = Date.now() + 12000;
    let frames = 0;
    while (Date.now() < until && frames < 3) {
      if (latest) { assert.equal(latest[0], 0xff); assert.equal(latest[1], 0xd8); await helper.draw(latest); }
      frames = await receiver.evaluate(async () => {
        const pc = (window as unknown as { peer: RTCPeerConnection }).peer;
        const stats = await pc.getStats(); let decoded = 0;
        stats.forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "video") decoded += Number(s.framesDecoded ?? 0); });
        return document.querySelector("video")!.videoWidth > 0 ? decoded : 0;
      });
      if (frames < 3) await new Promise((done) => setTimeout(done, 100));
    }
    assert.ok(frames >= 3, `Expected decoded RTP video frames, got ${frames}`);
    await source.screencast.stop(); await helper.close();
    await source.locator("h1").evaluate((el) => { el.textContent = "continued"; });
    assert.equal(await source.locator("h1").textContent(), "continued");
    console.log(JSON.stringify({ liveSmoke: "passed", transport: "webrtc", framesDecoded: frames, jpegCaptured: !!latest }));
  } finally { await helper.close(); await browser.close(); }
});
