// Manual, isolated diagnostic against an existing public/development page.
// Does not create a Run, change shared services, read keys, or print raw SDP.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, type Page } from "playwright";
import { VideoHelper } from "./helper.js";
import { mediaEnvironment, within } from "./files.js";

const out = resolve(process.argv.find((v) => v.startsWith("--out="))?.slice(6) ?? "/tmp/whippet-quality");
const url = process.argv.find((v) => v.startsWith("--url="))?.slice(6) ?? "http://host.docker.internal:18080";
// --hint= reproduces the original empty hint; omitted uses production behavior.
const hint = process.argv.find((v) => v.startsWith("--hint="))?.slice(7) ?? "production";
assert.ok(["production", "", "text"].includes(hint));

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true, env: mediaEnvironment(process.env) });
  const source = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const viewer = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const helper = new VideoHelper();
  try {
    await source.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    await source.getByRole("button", { name: "以開發管理員登入", exact: true }).waitFor();
    await source.evaluate(() => document.fonts.ready.then(() => undefined));
    const reference = await source.screenshot({ type: "png" });
    const roi = await source.locator(".login-panel").boundingBox();
    assert.ok(roi);
    let acceptFrame: (data: Buffer) => void = () => undefined;
    const firstFrame = new Promise<Buffer>((done) => { acceptFrame = done; });
    await source.screencast.start({ size: { width: 1280, height: 720 }, fps: 3, quality: 55, onFrame: ({ data }) => acceptFrame(data) });
    const jpeg = await within(firstFrame, 5000);
    await source.screencast.stop();
    await writeFile(join(out, "source.png"), reference);
    await writeFile(join(out, "screencast.jpg"), jpeg);
    const offer = await helper.start([]);
    // Deliberate diagnostic-only access, no new production diagnostics API.
    const senderPage = (helper as unknown as { page: Page }).page;
    if (hint !== "production") await senderPage.evaluate((value) => {
      const { stream } = (window as unknown as { whippetLive: { stream: MediaStream } }).whippetLive;
      stream.getVideoTracks()[0]!.contentHint = value;
    }, hint);
    await viewer.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    await viewer.getByRole("button", { name: "以開發管理員登入", exact: true }).click();
    await viewer.getByRole("region", { name: "測試詳情", exact: true }).waitFor();
    const answer = await viewer.evaluate(async (sdp) => {
      const panel = document.createElement("section"); panel.className = "live-panel";
      panel.innerHTML = '<div class="live-media"><video autoplay muted playsinline></video></div>';
      document.querySelector(".detail-panel")!.append(panel);
      const video = panel.querySelector("video")!;
      video.muted = true;
      const pc = new RTCPeerConnection();
      (window as unknown as { qualityPeer: RTCPeerConnection }).qualityPeer = pc;
      pc.ontrack = (e) => { video.srcObject = e.streams[0]!; void video.play(); };
      await pc.setRemoteDescription({ type: "offer", sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete") await new Promise<void>((done) => {
        const timer = setTimeout(done, 8000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); done(); } };
      });
      return pc.localDescription!.sdp;
    }, offer);
    await helper.answer(answer);
    let pushing = false;
    const paint = setInterval(() => {
      if (!pushing) { pushing = true; void helper.draw(jpeg).catch(() => undefined).finally(() => { pushing = false; }); }
    }, 333);
    try {
      await viewer.waitForFunction(() => {
        const v = document.querySelector(".live-panel video") as HTMLVideoElement;
        return v.videoWidth > 0 && v.getVideoPlaybackQuality().totalVideoFrames >= 6;
      }, undefined, { timeout: 12000 });
      const before = await stats(senderPage, viewer);
      await new Promise((done) => setTimeout(done, 3000));
      const after = await stats(senderPage, viewer);
      const canvasImage = await senderPage.evaluate(() => {
        const { canvas } = (window as unknown as { whippetLive: { canvas: HTMLCanvasElement } }).whippetLive;
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      await writeFile(join(out, "canvas.png"), Buffer.from(canvasImage, "base64"));
      const images = await viewer.evaluate(async ({ reference, jpeg, roi }) => {
        async function load(data: string) { const image = new Image(); image.src = data; await image.decode(); return image; }
        const original = await load(`data:image/png;base64,${reference}`);
        const captured = await load(`data:image/jpeg;base64,${jpeg}`);
        const video = document.querySelector(".live-panel video") as HTMLVideoElement;
        function pixels(image: CanvasImageSource) {
          const canvas = document.createElement("canvas"); canvas.width = 1280; canvas.height = 720;
          canvas.getContext("2d")!.drawImage(image, 0, 0, 1280, 720);
          return canvas;
        }
        const a = pixels(original), b = pixels(captured), c = pixels(video);
        const x = Math.max(0, Math.round(roi.x)), y = Math.max(0, Math.round(roi.y));
        const w = Math.min(1280 - x, Math.round(roi.width)), h = Math.min(720 - y, Math.round(roi.height));
        const pa = a.getContext("2d")!.getImageData(x,y,w,h).data;
        const pb = b.getContext("2d")!.getImageData(x,y,w,h).data;
        const pc = c.getContext("2d")!.getImageData(x,y,w,h).data;
        let edges = 0, jpegError = 0, videoError = 0;
        const luma = (p: Uint8ClampedArray, i: number) => .2126*p[i]! + .7152*p[i+1]! + .0722*p[i+2]!;
        for (let row=1; row<h-1; row++) for (let col=1; col<w-1; col++) {
          const i=(row*w+col)*4;
          if (Math.abs(luma(pa,i-4)-luma(pa,i+4))+Math.abs(luma(pa,i-w*4)-luma(pa,i+w*4))<60) continue;
          edges++;
          for (let k=0;k<3;k++) { jpegError += Math.abs(pa[i+k]!-pb[i+k]!); videoError += Math.abs(pa[i+k]!-pc[i+k]!); }
        }
        function crop(canvas: HTMLCanvasElement) {
          const out=document.createElement("canvas");out.width=w;out.height=h;
          out.getContext("2d")!.drawImage(canvas,x,y,w,h,0,0,w,h);
          return out.toDataURL("image/png").split(",")[1]!;
        }
        return { jpegSize: { width: captured.width, height: captured.height }, edges,
          jpegEdgeMAE: jpegError/(edges*3), videoEdgeMAE: videoError/(edges*3),
          referenceCrop:crop(a), jpegCrop:crop(b), videoCrop:crop(c), video:c.toDataURL("image/png").split(",")[1]!,
        };
      }, { reference: reference.toString("base64"), jpeg: jpeg.toString("base64"), roi });
      for (const key of ["referenceCrop", "jpegCrop", "videoCrop", "video"] as const)
        await writeFile(join(out, `${key}.png`), Buffer.from(images[key], "base64"));
      const display = [];
      for (const width of [1440,1280]) {
        await viewer.setViewportSize({ width, height: 1000 });
        display.push(await viewer.evaluate(() => {
          const v=document.querySelector(".live-panel video") as HTMLVideoElement;
          const r=v.getBoundingClientRect();
          return { viewport:innerWidth, dpr:devicePixelRatio, videoWidth:v.videoWidth, videoHeight:v.videoHeight,
            clientWidth:v.clientWidth,clientHeight:v.clientHeight,cssWidth:r.width,cssHeight:r.height,objectFit:getComputedStyle(v).objectFit };
        }));
      }
      const { referenceCrop, jpegCrop, videoCrop, video, ...metrics } = images;
      const summary = { hint, metrics, before, after, display,
        bitrateBps: Math.round(8*(after.sentBytes-before.sentBytes)*1000/(after.timestamp-before.timestamp)) };
      await writeFile(join(out,"summary.json"), JSON.stringify(summary,null,2)+"\n");
      console.log(JSON.stringify(summary));
    } finally { clearInterval(paint); }
  } finally { await helper.close(); await browser.close(); }
}

async function stats(sender: Page, viewer: Page) {
  const sent = await sender.evaluate(async () => {
    const {pc,canvas,stream}=(window as unknown as {whippetLive:{pc:RTCPeerConnection,canvas:HTMLCanvasElement,stream:MediaStream}}).whippetLive;
    const reports=await pc.getStats();
    let row: Record<string, unknown> = {};
    reports.forEach((s) => { if(s.type==="outbound-rtp" && s.kind==="video") row={
      frameWidth:s.frameWidth,frameHeight:s.frameHeight,framesEncoded:s.framesEncoded,framesPerSecond:s.framesPerSecond,
      qualityLimitationReason:s.qualityLimitationReason,targetBitrate:s.targetBitrate,qpSum:s.qpSum,
      bytesSent:s.bytesSent,timestamp:s.timestamp,codec:reports.get(s.codecId)?.mimeType,
    }; });
    return {canvas:{width:canvas.width,height:canvas.height},track:stream.getVideoTracks()[0]!.getSettings(),contentHint:stream.getVideoTracks()[0]!.contentHint,
      parameters:pc.getSenders()[0]!.getParameters(),outbound:row};
  });
  const received = await viewer.evaluate(async () => {
    const pc=(window as unknown as {qualityPeer:RTCPeerConnection}).qualityPeer;
    const reports=await pc.getStats();let row: Record<string,unknown>={};
    reports.forEach((s)=>{if(s.type==="inbound-rtp"&&s.kind==="video")row={frameWidth:s.frameWidth,frameHeight:s.frameHeight,framesDecoded:s.framesDecoded,bytesReceived:s.bytesReceived,packetsLost:s.packetsLost};});
    return row;
  });
  // Avoid SDP, ICE credentials, certificate identifiers, or arbitrary stats dumps.
  return {canvas:sent.canvas,track:{width:sent.track.width,height:sent.track.height,frameRate:sent.track.frameRate},contentHint:sent.contentHint,
    encoding:sent.parameters.encodings.map((e)=>({scaleResolutionDownBy:e.scaleResolutionDownBy,maxBitrate:e.maxBitrate,maxFramerate:e.maxFramerate})),
    outbound:sent.outbound,inbound:received,sentBytes:Number(sent.outbound.bytesSent),timestamp:Number(sent.outbound.timestamp)};
}

main().catch((error: unknown) => { console.error(`Quality diagnostic failed (${error instanceof Error ? error.name : "unknown"}); details hidden`); process.exitCode=1; });
