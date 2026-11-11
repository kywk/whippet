import { chromium, type Browser, type Page } from "playwright";
import { MAX_SDP, mediaEnvironment } from "./files.js";

// A separate, keyless Chromium supplies actual RTP video via a canvas track.
// No DataChannel, remote page navigation or model-generated code is used here.
export class VideoHelper {
  private browser?: Browser;
  private page?: Page;
  private stopped = false;
  private drawing = false;

  async start(iceServers: RTCIceServer[]): Promise<string> {
    const browser = await chromium.launch({
      headless: true,
      env: mediaEnvironment(process.env),
      // This ephemeral sender has no user profile. Numeric host candidates
      // avoid relying on container mDNS visibility from a native Mac viewer.
      args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
      timeout: 10000,
    });
    this.browser = browser;
    if (this.stopped) { await browser.close(); throw new Error("Live stopped"); }
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    this.page = page;
    const sdp = await page.evaluate(async (servers) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280; canvas.height = 720;
      document.body.append(canvas);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(3);
      const pc = new RTCPeerConnection({ iceServers: servers });
      for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);
      const live = { pc, canvas, stream };
      (window as unknown as { whippetLive: typeof live }).whippetLive = live;
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 8000);
        function done() { clearTimeout(timer); pc.removeEventListener("icegatheringstatechange", changed); resolve(); }
        function changed() { if (pc.iceGatheringState === "complete") done(); }
        pc.addEventListener("icegatheringstatechange", changed);
      });
      return pc.localDescription!.sdp;
    }, iceServers);
    if (Buffer.byteLength(sdp) > MAX_SDP) throw new Error("Live SDP too large");
    return sdp;
  }
  async answer(sdp: string): Promise<void> {
    if (!this.page) throw new Error("No live peer");
    await this.page.evaluate(async (answer) => {
      const { pc } = (window as unknown as { whippetLive: { pc: RTCPeerConnection } }).whippetLive;
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    }, sdp);
  }
  async draw(data: Buffer): Promise<void> {
    if (!this.page || this.drawing || this.stopped) return;
    this.drawing = true;
    try {
      await this.page.evaluate(async (base64) => {
        const { canvas } = (window as unknown as { whippetLive: { canvas: HTMLCanvasElement } }).whippetLive;
        const image = new Image();
        image.src = `data:image/jpeg;base64,${base64}`;
        await image.decode();
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "black"; ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
        const w = image.width * scale, h = image.height * scale;
        ctx.drawImage(image, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }, data.toString("base64"));
    } finally { this.drawing = false; }
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
  }
}
