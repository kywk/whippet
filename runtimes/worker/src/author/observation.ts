// Optional, fixed-vocabulary local diagnostics. Never receives payloads or secrets.
export const observationEvents = ['started','fetchInvoked','headersReceived','bodyParsed','responseAccepted','failed','timeoutProviderWait','timeoutBodyWait','cancelled','timeoutToolWait','toolCancelled','timeoutOther','feedbackFrameAccepted','feedbackQueued','feedbackIncludedAtFetch','toolsIncludedAtFetch','functionCallObserved'] as const;
export type ObservationEvent=typeof observationEvents[number];
export class AuthorObservation {
 private ordinal=0;private active=false;private phase:'provider'|'body'|'other'='other';
 constructor(private readonly observer?:(event:string)=>void){}
 emit(event:ObservationEvent){if(this.observer)try{this.observer(`author:observe:${this.ordinal}:${event}`);}catch{/* Diagnostics cannot affect author execution. */}}
 start(n:number){this.ordinal=n;this.active=true;this.phase='other';this.emit('started');}
 fetch(){this.phase='provider';this.emit('fetchInvoked');}
 headers(){this.phase='body';this.emit('headersReceived');}
 body(){this.phase='other';this.emit('bodyParsed');}
 accepted(){if(this.active){this.active=false;this.emit('responseAccepted');}}
 failure(aborted:boolean,external:boolean){if(!this.active)return;this.active=false;this.emit(external?'cancelled':aborted?this.phase==='provider'?'timeoutProviderWait':this.phase==='body'?'timeoutBodyWait':'timeoutOther':'failed');}
}
