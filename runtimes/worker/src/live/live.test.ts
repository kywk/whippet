import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
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
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: true, env: mediaEnvironment(process.env) });
  const helper = new VideoHelper();
  const source = await browser.newPage();
  const receiver = await browser.newPage();
  let latest: Buffer | undefined;
  let drawCompleted = false;
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
      if (latest) { assert.equal(latest[0], 0xff); assert.equal(latest[1], 0xd8); await helper.draw(latest); drawCompleted = true; }
      frames = await receiver.evaluate(async () => {
        const pc = (window as unknown as { peer: RTCPeerConnection }).peer;
        const stats = await pc.getStats(); let decoded = 0;
        stats.forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "video") decoded += Number(s.framesDecoded ?? 0); });
        return document.querySelector("video")!.videoWidth > 0 ? decoded : 0;
      });
      if (frames < 3) await new Promise((done) => setTimeout(done, 100));
    }
    // Test-only projection: never retain SDP, candidate values, media or raw stats.
    // Diagnostic failure must not change the original decoded-frame assertion.
    try {
      const senderPage = (helper as unknown as { page?: Page }).page;
      if (!senderPage) throw new Error("diagnostic_unavailable");
      const [sender, sink] = await Promise.all([
        senderPage.evaluate(async () => {
          const { pc, stream } = (window as unknown as { whippetLive: { pc: RTCPeerConnection; stream: MediaStream } }).whippetLive;
          const stats = await pc.getStats();
          let encoded = 0, sent = 0, hostCandidate = false, nominatedPair = false;
          stats.forEach((s) => {
            if (s.type === "outbound-rtp" && s.kind === "video") { encoded += Number(s.framesEncoded ?? 0); sent += Number(s.bytesSent ?? 0); }
            if (s.type === "local-candidate" && s.candidateType === "host") hostCandidate = true;
            if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) nominatedPair = true;
          });
          return { gathering: pc.iceGatheringState, ice: pc.iceConnectionState, connection: pc.connectionState,
            localCandidateInSdp: pc.localDescription?.sdp.includes("a=candidate:") ?? false,
            remoteCandidateInSdp: pc.remoteDescription?.sdp.includes("a=candidate:") ?? false,
            remoteMdnsCandidate: /a=candidate:[^\r\n]*\.local\b/.test(pc.remoteDescription?.sdp ?? ""),
            trackLive: stream.getVideoTracks()[0]?.readyState === "live", hostCandidate, nominatedPair,
            encodedPositive: encoded > 0, sentPositive: sent > 0 };
        }),
        receiver.evaluate(async () => {
          const pc = (window as unknown as { peer: RTCPeerConnection }).peer;
          const video = document.querySelector("video")!;
          const stats = await pc.getStats();
          let decoded = 0, received = 0, hostCandidate = false, nominatedPair = false;
          stats.forEach((s) => {
            if (s.type === "inbound-rtp" && s.kind === "video") { decoded += Number(s.framesDecoded ?? 0); received += Number(s.bytesReceived ?? 0); }
            if (s.type === "local-candidate" && s.candidateType === "host") hostCandidate = true;
            if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) nominatedPair = true;
          });
          return { gathering: pc.iceGatheringState, ice: pc.iceConnectionState, connection: pc.connectionState,
            localCandidateInSdp: pc.localDescription?.sdp.includes("a=candidate:") ?? false,
            remoteCandidateInSdp: pc.remoteDescription?.sdp.includes("a=candidate:") ?? false,
            remoteMdnsCandidate: /a=candidate:[^\r\n]*\.local\b/.test(pc.remoteDescription?.sdp ?? ""),
            trackAttached: video.srcObject instanceof MediaStream, hostCandidate, nominatedPair,
            receivedPositive: received > 0, decodedFrames: Math.min(9999, Math.max(0, decoded)),
            videoWidthPositive: video.videoWidth > 0 };
        }),
      ]);
      const state = (value: string) => ["new", "gathering", "complete", "checking", "connected", "completed", "disconnected", "failed", "closed"].includes(value) ? value : "other";
      const connected = (value: string) => value === "connected" || value === "completed";
      const failureEnum = !latest ? "SOURCE_JPEG_MISSING" : !drawCompleted ? "DRAW_NOT_COMPLETED"
        : sender.gathering !== "complete" || sink.gathering !== "complete" ? "ICE_GATHERING_INCOMPLETE"
        : !sender.hostCandidate || !sink.hostCandidate ? "ICE_NO_HOST_CANDIDATE"
        : !connected(sender.ice) || !connected(sink.ice) ? "ICE_NOT_CONNECTED"
        : !sender.encodedPositive || !sender.sentPositive ? "NO_OUTBOUND_RTP"
        : !sink.receivedPositive ? "NO_INBOUND_RTP"
        : sink.decodedFrames === 0 ? "RTP_RECEIVED_NOT_DECODED"
        : !sink.videoWidthPositive ? "DECODED_VIDEO_ELEMENT_ZERO"
        : frames < 3 ? "FRAME_COUNT_BELOW_THREE" : "PASS";
      console.log("WHIPPET_LIVE_SAFE " + JSON.stringify({ failureEnum, sourceJpegCaptured: !!latest, drawCompleted,
        sender: { gathering: state(sender.gathering), ice: state(sender.ice), connection: state(sender.connection),
          trackLive: sender.trackLive, hostCandidate: sender.hostCandidate, nominatedPair: sender.nominatedPair,
          localCandidateInSdp: sender.localCandidateInSdp, remoteCandidateInSdp: sender.remoteCandidateInSdp,
          remoteMdnsCandidate: sender.remoteMdnsCandidate,
          encodedPositive: sender.encodedPositive, sentPositive: sender.sentPositive },
        receiver: { gathering: state(sink.gathering), ice: state(sink.ice), connection: state(sink.connection),
          trackAttached: sink.trackAttached, hostCandidate: sink.hostCandidate, nominatedPair: sink.nominatedPair,
          localCandidateInSdp: sink.localCandidateInSdp, remoteCandidateInSdp: sink.remoteCandidateInSdp,
          remoteMdnsCandidate: sink.remoteMdnsCandidate,
          receivedPositive: sink.receivedPositive, decodedFrames: sink.decodedFrames, videoWidthPositive: sink.videoWidthPositive },
        frameGateCount: frames, elapsedMs: Date.now() - startedAt }));
    } catch { console.log('WHIPPET_LIVE_SAFE {"failureEnum":"DIAGNOSTIC_UNAVAILABLE"}'); }
    assert.ok(frames >= 3, `Expected decoded RTP video frames, got ${frames}`);
    assert.deepEqual(await receiver.evaluate(() => {
      const video = document.querySelector("video")!;
      return { width: video.videoWidth, height: video.videoHeight };
    }), { width: 1280, height: 720 }, "Webpage video must preserve source resolution for readable text");
    await source.screencast.stop(); await helper.close();
    await source.locator("h1").evaluate((el) => { el.textContent = "continued"; });
    assert.equal(await source.locator("h1").textContent(), "continued");
    console.log(JSON.stringify({ liveSmoke: "passed", transport: "webrtc", framesDecoded: frames, jpegCaptured: !!latest }));
  } finally { await helper.close(); await browser.close(); }
});
