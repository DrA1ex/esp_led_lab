'use strict';
// Optional, LAN-only audio feature transport. No PCM is transmitted.
// The 16/32/64 layout is 38 + count*2 bytes; a count is sent only when the
// receiver lists it in band_counts (current firmware: 16, 32 and 64).
const RemoteAudio = (() => {
 const COUNTS=[16,32,64], MAGIC=[69,76,65,70];
 // Clock sync: a short burst at connect, then a refresh every few seconds
 // (also while streaming) so ESP crystal drift never accumulates. The offset
 // is taken from the lowest-RTT sample of a recent window, not of all time.
 const SYNC_BURST=5, SYNC_BURST_GAP_MS=80, SYNC_INTERVAL_MS=5000, SYNC_WINDOW_MS=30000, SYNC_KEEP=12;
 const clamp=(n,lo,hi)=>Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):lo;
 const u16=(n)=>Math.round(clamp(n,0,4096));
 const serialize=(f)=>{
  const count=f.bands.length;
  if(!COUNTS.includes(count))throw new RangeError('Unsupported audio band count '+count);
  const buffer=new ArrayBuffer(38+count*2),view=new DataView(buffer);
  MAGIC.forEach((b,i)=>view.setUint8(i,b));
  view.setUint8(4,1);view.setUint8(5,1);view.setUint8(6,f.live?1:0);view.setUint8(7,count);
  view.setUint32(8,f.session>>>0,true);view.setUint32(12,f.seq>>>0,true);
  view.setUint32(16,Math.round(f.timestamp)>>>0,true);
  for(const [i,k] of ['rms','bass','mid','high','peak','onsetStrength'].entries())view.setUint16(20+i*2,u16(f[k]),true);
  view.setUint8(32,(f.onsetMask||0)&7);view.setUint8(33,Math.round(clamp(f.beatPhase,0,255)));
  view.setUint16(34,Math.round(clamp(f.bpm,0,65535)),true);
  view.setUint8(36,Math.round(clamp(f.confidence,0,255)));view.setUint8(37,0);
  for(let i=0;i<count;i++)view.setUint16(38+i*2,u16(f.bands[i]),true);
  return buffer;
 };
 // Band count for a lamp of `width` columns: about one band per column (fewer
 // bands than columns are interpolated, more are averaged), as the nearest
 // count the lamp accepts, preferring the larger one.
 function pickBands(width,supported=COUNTS){
  const want=width<=24?16:width<=48?32:64;
  const ok=COUNTS.filter(n=>supported.includes(n));
  if(!ok.length)return 32;
  if(ok.includes(want))return want;
  return ok.find(n=>n>want)??ok[ok.length-1];
 }
 function addressToUrl(address){
  const v=address.trim();if(!v)throw new Error('Specify device address');
  if(v.includes('://')&&!/^wss?:\/\//i.test(v))throw new Error('Only ws:// or wss:// addresses are supported');
  const raw=/^wss?:\/\//i.test(v)?v:'ws://'+v;
  const url=new URL(raw);
  if(!['ws:','wss:'].includes(url.protocol))throw new Error('Use ws:// or wss://');
  if(url.username||url.password)throw new Error('URL credentials are not supported');
  if(url.pathname==='/'||!url.pathname)url.pathname='/audio';
  return url.href;
 }
 const decode=(ev)=>{try{return JSON.parse(ev.data)}catch(_){return null}};
 const now=()=>performance.now();
 const newId=()=>{const v=new Uint32Array(1);if(typeof crypto!=='undefined'&&crypto.getRandomValues)crypto.getRandomValues(v);else v[0]=(now()*104729)>>>0;return v[0]||1};
 class Device {
  constructor(address,notify){this.address=address;this.url=addressToUrl(address);this.notify=notify;this.selected=true;
   this.status='disconnected';this.socket=null;this.supported=[32];this.session=null;this.clockOffset=0;this.rtt=NaN;this.synced=false;
   this.sent=0;this.dropped=0;this.buffered=0;this.received=0;this.delay=NaN;this.syncId=0;this.pending=new Map();this.syncSamples=[];
   this.reconnectAttempts=0;this.reconnectAt=0;this.manual=false;this.lastSync=0;this.lastStatus=0;this.lastConfig='';this.clockSamples=0;
   this.receiverPlaying=false;this.started=false;this.lastError='';this.receiverDropped=0;this.receiverStale=0;this.lastStartAt=0;
   this.width=0;this.height=0;this.capabilities=[];}
  connect(){
   this.manual=false;
   if(this.socket&&this.socket.readyState<=1)return;
   this.status='connecting';this.stageAt=now();this.notify();
   try{
    const ws=new WebSocket(this.url);this.socket=ws;ws.binaryType='arraybuffer';let opened=false;
    ws.onopen=()=>{if(this.socket!==ws)return;opened=true;this.stageAt=now();this.status='handshake';this.reconnectAttempts=0;this.started=false;this.receiverPlaying=false;this.lastError='';
      this.syncSamples=[];this.pending.clear();this.clockSamples=0;
      this.sendText({type:'hello',version:1,band_counts:COUNTS,client:'esp-led-wasm-lab'});this.notify();};
    ws.onmessage=ev=>{if(this.socket===ws)this.message(decode(ev));};
    ws.onerror=()=>{if(this.socket===ws){this.status='socket error';this.notify();}};
    ws.onclose=ev=>{if(this.socket!==ws)return;
      // Say why: the browser only reports a code, and "nothing happens" is the usual symptom.
      if(!opened&&!this.manual)this.lastError=`no WebSocket at ${this.url} (code ${ev.code}): check the address and that the lamp is on this network; outside 192.168.x.x WEB_AUTH firmware asks for a login`;
      this.socket=null;this.session=null;this.synced=false;this.pending.clear();
      this.status='disconnected';this.started=false;this.receiverPlaying=false;if(!this.manual){this.reconnectAttempts++;this.reconnectAt=now()+Math.min(15000,600*Math.pow(2,this.reconnectAttempts));}this.notify();};
   }catch(e){this.status='error: '+e.message;this.reconnectAt=now()+2000;this.notify();}
  }
  disconnect(){this.manual=true;this.reconnectAt=0;this.stop();const ws=this.socket;this.socket=null;this.status='disconnected';this.synced=false;this.started=false;this.receiverPlaying=false;
    try{ws?.close()}catch(_){}this.notify();}
  sendText(msg){if(this.socket?.readyState===1){this.socket.send(JSON.stringify(msg));return true;}return false;}
  message(msg){if(!msg||typeof msg!=='object')return;
   const type=msg.type||msg.op;
   if(type==='hello_ack'){
    if(msg.version!==undefined&&msg.version!==1){this.status='incompatible protocol';this.disconnect();return;}
    // A receiver which does not advertise counts is treated as 32-only.
    const counts=msg.band_counts||msg.supported_bands||msg.bands;
    this.supported=Array.isArray(counts)?COUNTS.filter(n=>counts.includes(n)):[32];
    if(!this.supported.length){this.status='unsupported bands';this.notify();return;}
    this.width=Number(msg.width)||0;this.height=Number(msg.height)||0;
    this.capabilities=Array.isArray(msg.capabilities)?msg.capabilities.map(String):[];
    this.status='synchronizing';this.reconnectAttempts=0;this.syncBurst();this.notify();
   }else if(type==='sync_ack'){
    const id=msg.id, t0=this.pending.get(id);
    if(t0===undefined)return;this.pending.delete(id);
    const t3=now(),t1=Number(msg.t1??msg.receive_ms),t2=Number(msg.t2??msg.send_ms);
    if(!Number.isFinite(t1)||!Number.isFinite(t2))return;
    const duration=(t3-t0)-(t2-t1);if(duration<0||duration>2000)return;
    const offset=((t1-t0)+(t2-t3))/2;
    if(!Number.isFinite(offset))return;
    this.syncSamples.push({duration,offset,at:t3});
    this.syncSamples=this.syncSamples.filter(x=>t3-x.at<=SYNC_WINDOW_MS).slice(-SYNC_KEEP);
    const best=this.syncSamples.reduce((a,b)=>b.duration<a.duration?b:a);
    this.clockSamples++;this.rtt=best.duration;
    // Re-send only on a real change: each clock rebases the ESP queue.
    const next=Math.round(best.offset);
    if(!this.synced||next!==Math.round(this.clockOffset)){
     this.clockOffset=next;
     if(!this.synced)this.status='clock setup';
     this.sendText({type:'clock',offset_ms:next,rtt_ms:Math.round(this.rtt)});
    }
    this.notify();
   }else if(type==='clock_ack'){
    this.synced=true;this.status='ready';this.lastError='';this.notify();
   }else if(type==='start_ack'){
    if(this.session!==null&&(msg.session===undefined||msg.session===this.session)){
     this.started=true;this.receiverPlaying=true;this.lastError='';this.notify();
    }
   }else if(type==='stop_ack'){
    if(this.session===null){this.started=false;this.receiverPlaying=false;this.notify();}
   }else if(type==='error'){
    this.lastError=String(msg.reason||'unknown_error');
    if(this.lastError==='clock_not_set'){this.synced=false;this.status='clock rejected';this.sync();}
    this.notify();
   }else if(type==='status'){
    this.received=Number(msg.received_frames??msg.received??this.received);
    this.receiverPlaying=typeof msg.playing==='boolean'?msg.playing:this.receiverPlaying;
    this.receiverDropped=Number(msg.dropped??this.receiverDropped);
    this.receiverStale=Number(msg.stale??this.receiverStale);
    this.delay=Number(msg.presentation_delay_ms??msg.frame_age_ms??this.delay);
    this.buffered=Number(msg.buffer_occupancy??msg.buffered_frames??this.buffered);
    // A device may stop after its 300 ms stream timeout. Resume the same
    // control lease instead of silently remaining stopped until page reload.
    if(this.session!==null&&!this.receiverPlaying&&now()-this.lastStartAt>1000){
     this.sendText({type:'start',session_id:this.session,band_count:this.sessionBands,rate_hz:50});
     this.lastStartAt=now();this.started=false;
    }
    this.notify();
   }
  }
  syncBurst(){
   const ws=this.socket;this.sync();
   for(let i=1;i<SYNC_BURST;i++)setTimeout(()=>{if(this.socket===ws)this.sync();},i*SYNC_BURST_GAP_MS);
  }
  sync(){if(this.socket?.readyState!==1)return;
   const t0=now(),id=++this.syncId;this.pending.set(id,t0);
   if(this.pending.size>10)this.pending.delete(this.pending.keys().next().value);
   this.lastSync=t0;this.sendText({type:'sync',id,t0});
  }
  stop(){if(this.session!==null)this.sendText({type:'stop',session_id:this.session});this.session=null;this.started=false;this.receiverPlaying=false;this.lastConfig='';}
  tick(t){
   // Handshake watchdogs: a lamp that never answers otherwise looks like a hang.
   if(this.socket&&this.status==='connecting'&&t-this.stageAt>5000){
    this.lastError=`no answer from ${this.url} within 5 s`;const ws=this.socket;try{ws.close();}catch(_){}
   }else if(this.socket?.readyState===1&&this.status==='handshake'&&t-this.stageAt>4000){
    this.lastError='connected, but no hello_ack: firmware without Remote Audio, or a long blocking task on the lamp';this.stageAt=t;this.notify();
   }if(!this.manual&&this.socket===null&&this.reconnectAt>0&&t>=this.reconnectAt){this.reconnectAt=0;this.connect();}
   if(this.socket?.readyState===1&&this.status==='ready'){
    if(t-this.lastSync>SYNC_INTERVAL_MS)this.sync();
    if(t-this.lastStatus>2000){this.lastStatus=t;this.sendText({type:'status'});}
   }
  }
  stream(frame,config){
   if(!this.selected||this.status!=='ready'||!this.synced||this.socket?.readyState!==1)return;
   if(!this.supported.includes(frame.bands.length)){this.dropped++;this.notify();return;}
   if(this.socket.bufferedAmount>8192){this.dropped++;this.notify();return;}
   const serialized=JSON.stringify(config);
   if(this.session!==frame.session){this.stop();this.sendText({type:'config',...config});
    this.sendText({type:'start',session_id:frame.session,band_count:frame.bands.length,rate_hz:50});this.session=frame.session;this.sessionBands=frame.bands.length;this.lastStartAt=now();this.started=false;this.lastConfig=serialized;
   }else if(serialized!==this.lastConfig){this.lastConfig=serialized;this.sendText({type:'config',...config});}
   this.socket.send(serialize(frame));this.sent++;
  }
 }
 class Hub {
  constructor(onChange=()=>{}){this.devices=[];this.onChange=onChange;}
  add(address){const url=addressToUrl(address);const exists=this.devices.find(d=>d.url===url);if(exists)return exists;
   const d=new Device(address,()=>this.onChange());this.devices.push(d);this.onChange();return d;}
  remove(d){d.disconnect();this.devices=this.devices.filter(x=>x!==d);this.onChange();}
  tick(){const t=now();for(const d of this.devices)d.tick(t);}
  stop(){for(const d of this.devices)d.stop();this.onChange();}
  // frame / config may be functions of the device (per-lamp adaptation).
  stream(frame,config){for(const d of this.devices)d.stream(typeof frame==='function'?frame(d):frame,typeof config==='function'?config(d):config);}
  get available(){return this.devices.some(d=>d.selected&&d.status==='ready'&&d.synced);}
 }
 return {serialize,addressToUrl,pickBands,Hub,Device,newId};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=RemoteAudio;
