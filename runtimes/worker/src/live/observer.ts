import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { MAX_JPEG, readControl, replaceFile, within, type LiveControl } from "./files.js";
import { VideoHelper } from "./helper.js";

export class LiveObserver {
  private readonly dir: string;
  private readonly pages: Page[] = [];
  private readonly contexts = new Set<BrowserContext>();
  private restore?: () => void;
  private timer: NodeJS.Timeout;
  private busy = false;
  private closed = false;
  private control?: LiveControl;
  private capturing?: Page;
  private helper?: VideoHelper;
  private offer?: string;
  private answered = false;
  private lastFrame?: Buffer;
  private frameBusy = false;
  private failedMode?: string;
  private lastState = "";
  private sensitive=false;

  async pauseSensitive():Promise<void>{this.sensitive=true;await this.stopMedia();if(this.control)await this.state('waiting','sensitive_input');}
  resumeSensitive():void{this.sensitive=false;}

  constructor(workDir = process.env.WHIPPET_WORK_DIR ?? "/work") {
    this.dir = join(resolve(workDir), "live");
    this.timer = setInterval(() => { void this.tick(); }, 250);
    this.timer.unref();
  }
  observePage = (page: Page): void => {
    if (!this.pages.includes(page)) this.pages.push(page);
  };
  private observeContext(context: BrowserContext): void {
    if (this.contexts.has(context)) return;
    this.contexts.add(context);
    context.on("page", this.observePage);
    context.pages().forEach(this.observePage);
  }
  observeBrowser(browser: Browser): void {
    const newContext = browser.newContext, newPage = browser.newPage;
    browser.contexts().forEach((c) => this.observeContext(c));
    browser.newContext = async (...args) => {
      const context = await newContext.apply(browser, args);
      try { this.observeContext(context); } catch { /* Media never fails a fixture. */ } return context;
    };
    browser.newPage = async (...args) => {
      const page = await newPage.apply(browser, args);
      try { this.observeContext(page.context()); } catch { /* Media never fails a fixture. */ } return page;
    };
    this.restore = () => { browser.newContext = newContext; browser.newPage = newPage; };
  }
  private async state(state: string, reason?: string): Promise<void> {
    if (!this.control) return;
    const data = JSON.stringify({ viewerId: this.control.viewerId, state, transport: this.control.mode, reason, offer: this.offer });
    if (data === this.lastState) return;
    await replaceFile(join(this.dir, "state.json"), data);
    this.lastState = data;
  }
  private async stopCapture(): Promise<void> {
    const page = this.capturing; this.capturing = undefined;
    this.lastFrame = undefined;
    if (page) await within(page.screencast.stop(), 1500).catch(() => undefined);
  }
  private async stopMedia(): Promise<void> {
    await this.stopCapture();
    const helper = this.helper; this.helper = undefined;
    if (helper) await within(helper.close(), 2000).catch(() => undefined);
    if (this.control) await rm(join(this.dir, `${this.control.viewerId}.jpg`), { force: true }).catch(() => undefined);
    this.offer = undefined; this.answered = false; this.failedMode = undefined; this.lastState = "";
  }
  private async tick(): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      const control = await readControl(this.dir);
      if(this.sensitive){await this.stopMedia();return;}
      if (!control) {
        await this.stopMedia(); this.control = undefined; return;
      }
      if (control.viewerId !== this.control?.viewerId || control.mode !== this.control?.mode) await this.stopMedia();
      this.control = control;
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const page = [...this.pages].reverse().find((p) => !p.isClosed());
      if (!page) { await this.stopCapture(); await this.state("waiting", "no_page"); return; }
      if (this.failedMode === control.mode) return;
      if (this.capturing !== page) {
        await this.stopCapture();
        this.capturing = page;
        await within(page.screencast.start({ size: { width: 1280, height: 720 }, fps: 3, quality: 55,
          onFrame: ({ data }) => {
            // One in-flight write; no unbounded media queue or test awaits.
            if (this.frameBusy || this.closed || this.capturing !== page || !this.control || this.control.expiresAt <= Date.now() || data.length > MAX_JPEG) return;
            const viewer = this.control.viewerId;
            this.lastFrame = data;
            this.frameBusy = true;
            void replaceFile(join(this.dir, `${viewer}.jpg`), data).catch(() => undefined).finally(() => { this.frameBusy = false; });
          },
        }), 3000);
      }
      if (control.mode === "jpeg") { await this.state(this.lastFrame ? "streaming" : "waiting"); return; }
      if (!this.helper) {
        await this.state("connecting");
        this.helper = new VideoHelper();
        this.offer = await within(this.helper.start(control.iceServers), 18000);
        await this.state("connecting");
      }
      if (control.answer && !this.answered) { await within(this.helper.answer(control.answer), 3000); this.answered = true; }
      if (this.lastFrame && control.expiresAt > Date.now()) await within(this.helper.draw(this.lastFrame), 2000);
      // Only the viewer can confirm a decoded video track. Peer setup alone
      // never reports WebRTC streaming success.
    } catch {
      await this.stopMedia().catch(() => undefined);
      this.failedMode = this.control?.mode;
      await this.state("unavailable", "media_failed").catch(() => undefined);
    } finally { this.busy = false; }
  }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer);
    this.restore?.();
    for (const context of this.contexts) context.off("page", this.observePage);
    if (this.helper) await within(this.helper.close(), 1000).catch(() => undefined); // Interrupt ICE gather.
    await this.state("ended").catch(() => undefined);
    await within(this.stopMedia(), 1500).catch(() => undefined);
  }
}
