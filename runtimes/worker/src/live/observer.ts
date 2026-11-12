import {mkdir,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {join,resolve} from "node:path";
import type {Browser,BrowserContext,Page} from "@playwright/test";
import {MAX_JPEG,readControl,replaceFile,within,type LiveControl} from "./files.js";
import {VideoHelper} from "./helper.js";

type MediaHelper=Pick<VideoHelper,"start"|"answer"|"draw"|"close">;
type ObserverOptions={helperFactory?:()=>MediaHelper;autoTick?:boolean;writeFrame?:(path:string,data:Buffer)=>Promise<void>};

export class LiveObserver {
  private readonly dir:string;
  private readonly pages:Page[]=[];
  private readonly contexts=new Set<BrowserContext>();
  private restore?:()=>void;
  private timer?:NodeJS.Timeout;
  private busy=false;
  private closed=false;
  private serial:Promise<void>=Promise.resolve();
  private epoch=0;
  private sensitiveDepth=0;
  private paused=false;
  private resumeMarker=false;
  private control?:LiveControl;
  private capturing?:Page;
  private helper?:MediaHelper;
  private offer?:string;
  private offerId?:string;
  private answered=false;
  private lastFrame?:Buffer;
  private frameWrite?:Promise<void>;
  private frameBusy=false;
  private readonly framePaths=new Set<string>();
  private failedMode?:string;
  private lastState="";

  constructor(workDir=process.env.WHIPPET_WORK_DIR??"/work",private readonly options:ObserverOptions={}){
    this.dir=join(resolve(workDir),"live");
    if(options.autoTick!==false){this.timer=setInterval(()=>{void this.tick();},250);this.timer.unref();}
  }
  private enqueue(operation:()=>Promise<void>):Promise<void>{
    const pending=this.serial.then(operation);this.serial=pending.catch(()=>undefined);return pending;
  }
  async pauseSensitive():Promise<void>{
    // Invalidate callbacks immediately, before waiting for an in-flight tick.
    this.sensitiveDepth++;this.paused=true;this.resumeMarker=false;this.epoch++;
    void this.helper?.close().catch(()=>undefined); // Interrupt ICE startup.
    await this.enqueue(async()=>{
      await this.stopMedia();
      this.control=await readControl(this.dir);
      if(this.control&&!this.closed)await this.state("waiting","sensitive_input");
    });
  }
  async resumeSensitive():Promise<void>{
    if(this.sensitiveDepth===0||this.closed)return;
    this.sensitiveDepth--;if(this.sensitiveDepth>0)return;
    this.epoch++;
    await this.enqueue(async()=>{
      if(this.closed||this.sensitiveDepth>0)return;
      await this.stopMedia();this.resumeMarker=true;
      this.control=await readControl(this.dir);
      if(this.control)await this.state("waiting","sensitive_input_complete");
      if(this.sensitiveDepth===0&&!this.closed)this.paused=false;
    });
  }
  observePage=(page:Page):void=>{if(!this.pages.includes(page))this.pages.push(page);};
  private observeContext(context:BrowserContext):void{
    if(this.contexts.has(context))return;this.contexts.add(context);
    context.on("page",this.observePage);context.pages().forEach(this.observePage);
  }
  observeBrowser(browser:Browser):void{
    const newContext=browser.newContext,newPage=browser.newPage;
    browser.contexts().forEach((c)=>this.observeContext(c));
    browser.newContext=async(...args)=>{const context=await newContext.apply(browser,args);try{this.observeContext(context);}catch{}return context;};
    browser.newPage=async(...args)=>{const page=await newPage.apply(browser,args);try{this.observeContext(page.context());}catch{}return page;};
    this.restore=()=>{browser.newContext=newContext;browser.newPage=newPage;};
  }
  private async state(state:string,reason?:string):Promise<void>{
    if(!this.control)return;
    const data=JSON.stringify({viewerId:this.control.viewerId,state,transport:this.control.mode,reason,offer:this.offer,offerId:this.offerId});
    if(data===this.lastState)return;
    await replaceFile(join(this.dir,"state.json"),data);this.lastState=data;
  }
  private async mediaState(normal:string):Promise<void>{
    // Persist the resume marker throughout the resumed epoch. A one-tick pulse
    // could disappear before Manager's polling loop observes it.
    await this.state(this.resumeMarker?"waiting":normal,this.resumeMarker?"sensitive_input_complete":undefined);
  }
  private async stopCapture():Promise<void>{
    const page=this.capturing;this.capturing=undefined;this.lastFrame=undefined;
    if(page)await within(page.screencast.stop(),1500).catch(()=>undefined);
    // Never report pause complete while an older atomic write can still rename.
    await this.frameWrite;this.frameWrite=undefined;
  }
  private async stopMedia():Promise<void>{
    this.epoch++;
    await this.stopCapture();
    const helper=this.helper;this.helper=undefined;
    if(helper)await within(helper.close(),2000).catch(()=>undefined);
    if(this.control)this.framePaths.add(join(this.dir,`${this.control.viewerId}.jpg`));
    for(const path of this.framePaths)await rm(path,{force:true}).catch(()=>undefined);
    this.framePaths.clear();
    this.offer=undefined;this.offerId=undefined;this.answered=false;this.failedMode=undefined;
  }
  private current(epoch:number):boolean{return !this.closed&&!this.paused&&epoch===this.epoch;}
  private async tick():Promise<void>{
    if(this.busy||this.closed)return;this.busy=true;
    try{await this.enqueue(()=>this.tickMedia());}finally{this.busy=false;}
  }
  private async tickMedia():Promise<void>{
    try{
      const control=await readControl(this.dir);
      // Still read fresh viewer/mode leases during sensitive input. A viewer
      // joining mid-pause must receive the pause state, never start capture.
      if(this.paused){
        await this.stopMedia();this.control=control;
        if(control)await this.state("waiting","sensitive_input");return;
      }
      if(!control){await this.stopMedia();this.control=undefined;return;}
      if(control.viewerId!==this.control?.viewerId||control.mode!==this.control?.mode)await this.stopMedia();
      this.control=control;let epoch=this.epoch;
      await mkdir(this.dir,{recursive:true,mode:0o700});if(!this.current(epoch))return;
      const page=[...this.pages].reverse().find((p)=>!p.isClosed());
      if(!page){await this.stopMedia();if(!this.paused)await this.state("waiting",this.resumeMarker?"sensitive_input_complete":"no_page");return;}
      if(this.failedMode===control.mode)return;
      if(this.capturing!==page){
        await this.stopCapture();if(!this.current(epoch))return;
        this.capturing=page;
        const captureEpoch=epoch;
        await within(page.screencast.start({size:{width:1280,height:720},fps:3,quality:55,onFrame:({data})=>{
          if(!this.current(captureEpoch)||this.frameBusy||this.capturing!==page||!this.control||this.control.expiresAt<=Date.now()||data.length>MAX_JPEG)return;
          this.lastFrame=data;this.frameBusy=true;
          const path=join(this.dir,`${this.control.viewerId}.jpg`);this.framePaths.add(path);
          this.frameWrite=(this.options.writeFrame??replaceFile)(path,data).catch(()=>undefined).finally(()=>{this.frameBusy=false;});
        }}),3000);
        if(!this.current(epoch))return;
      }
      if(control.mode==="jpeg"){await this.mediaState(this.lastFrame?"streaming":"waiting");return;}
      if(!this.helper){
        this.helper=this.options.helperFactory?.()??new VideoHelper();this.offerId=randomUUID();
        await this.mediaState("connecting");if(!this.current(epoch))return;
        this.offer=await within(this.helper.start(control.iceServers),18000);if(!this.current(epoch))return;
        await this.mediaState("connecting");if(!this.current(epoch))return;
      }
      // Read the latest control only after publishing the new offer. Never use
      // a pre-pause answer captured before helper.start awaited ICE gathering.
      const latest=await readControl(this.dir);if(!this.current(epoch))return;
      if(latest?.viewerId===control.viewerId&&latest.mode==="webrtc"&&latest.answer&&latest.answerOfferId===this.offerId&&!this.answered){
        await within(this.helper.answer(latest.answer),3000);if(!this.current(epoch))return;this.answered=true;
      }
      if(this.lastFrame&&control.expiresAt>Date.now()&&this.current(epoch))await within(this.helper.draw(this.lastFrame),2000);
    }catch{
      await this.stopMedia().catch(()=>undefined);
      if(this.closed)return;
      if(this.paused){if(this.control)await this.state("waiting","sensitive_input").catch(()=>undefined);return;}
      this.failedMode=this.control?.mode;await this.state("unavailable","media_failed").catch(()=>undefined);
    }
  }
  async close():Promise<void>{
    if(this.closed)return;this.closed=true;this.epoch++;if(this.timer)clearInterval(this.timer);
    void this.helper?.close().catch(()=>undefined);
    await this.enqueue(async()=>{this.restore?.();for(const context of this.contexts)context.off("page",this.observePage);await this.stopMedia();await this.state("ended").catch(()=>undefined);});
  }
}
