'use strict';
// Remote Output: feature snapshots, presentation timestamps and device list UI.
const REMOTE=new RemoteAudio.Hub(()=>renderRemoteDevices());
const RS={frames:[],session:RemoteAudio.newId(),seq:0,nextSend:0,lastSentSample:-1,
 lastTick:0, loopEpoch:0, lastRenderedEpoch:0, late:0, visual:null, enabled:false};
const remoteEnabled=()=>Boolean($('remote-enable')?.checked);
function remoteInvalidate(){
 RS.frames.length=0;RS.session=RemoteAudio.newId();RS.seq=0;RS.nextSend=0;RS.lastSentSample=-1;
 RS.visual=null;RS.loopEpoch=0;RS.lastRenderedEpoch=0;REMOTE.stop();
}
function sourcePosition(){
 if(!STATE.playing)return -1;
 if(STATE.inputMode==='microphone')return STATE.mic?.written??-1;
 if(STATE.inputMode==='file'&&STATE.context&&STATE.pcm)
  return Math.max(0,Math.floor((STATE.context.currentTime-STATE.playStart)*fs));
 return -1;
}
function currentDisplaySample(){
 const abs=sourcePosition();
 return abs>=0&&STATE.loopDemo&&STATE.pcm?.length?abs%STATE.pcm.length:abs;
}
function captureFeatureSnapshot(sample){
 const d=STATE.modules.dsp.exports;
 const copy=(ptr,n)=>Array.from(new Float32Array(d.memory.buffer,ptr,n));
 const metrics=copy(d.new_metrics_ptr(),10);
 return {sample,newer:STATE.newSpectrum.slice(),
  r16:STATE.newSpectrum.slice(),r32:copy(d.new_remote32_ptr(),32),r64:copy(d.new_remote64_ptr(),64),
  levels:STATE.levels.slice(),pulses:STATE.pulses.slice(),events:STATE.events.slice(),
  metrics, bpm:STATE.bpm,beatConfidence:STATE.beatConfidence,beatPhase:STATE.beatPhase,beatPulse:STATE.beatPulse,
  newParam:STATE.newParam,newLoudness:STATE.newLoudness,newLine:STATE.newLine,
  newWave:copy(d.new_wave_ptr(),128),newWaveHead:d.new_wave_head()};
}
function showFeatureSnapshot(f){
 if(!f)return;
 RS.visual=f;STATE.newSpectrum=f.newer.slice();
 STATE.levels=f.levels.slice();STATE.pulses=f.pulses.slice();STATE.events=f.events.slice();
 STATE.bpm=f.bpm;STATE.beatConfidence=f.beatConfidence;STATE.beatPhase=f.beatPhase;STATE.beatPulse=f.beatPulse;
 STATE.newParam=f.newParam;STATE.newLoudness=f.newLoudness;STATE.newLine=f.newLine;
}
function contextTimeToPerf(target){
 const c=STATE.context;
 if(!c)return performance.now();
 try{const stamp=c.getOutputTimestamp?.();
  if(stamp&&stamp.contextTime>0&&stamp.performanceTime>0)
   return stamp.performanceTime+(target-stamp.contextTime)*1000;
 }catch(_){}
 return performance.now()+(target-c.currentTime+(c.outputLatency||c.baseLatency||0))*1000;
}
// Order matches firmware RemoteReactive::ControlSource (config.param_source).
const PARAM_SOURCES=['loudness','spectral','bass','mid','high','peak','onset','beat'];
// Firmware ignores unknown fields, so the lab tuning below is safe for older
// receivers; receivers advertising "tuning" apply it like the new-FFT preview.
function remoteRuntimeConfig(){const s=settings();return {
  // Visualizations go out as is; lampConfig() turns them Off for lamps without them.
  color_effect:s.color,brightness_effect:s.brightness,audio_effect:s['audio-mode'],
  audio_min:s['audio-min'],audio_max:s['audio-max'],palette:s.palette,
  speed:s.speed,scale:s.scale,light:s.light,
  param_source:Math.max(0,PARAM_SOURCES.indexOf(s['param-source'])),
  // The reaction range replaces the separate speed floor (0 = stock mapping).
  speed_floor:0,spectrum_shape:s['spectrum-shape'],spectrum_onset:s['spectrum-onset'],
  viz_color:+s['viz-color'],viz_mirror:Boolean(s['viz-mirror']),viz_auto:Boolean(s['viz-auto']),
  viz_decay:+s['viz-decay'],viz_motion:+s['viz-speed'],
  ...tuningConfig(s,currentGeometry().w)
 };}
// One frame per band count; all counts of a moment share the sequence number.
function remoteFrame(snapshot,timestamp,mask,count,seq){
 const bands=(count===16?snapshot.r16:count===32?snapshot.r32:snapshot.r64);
 const norm=n=>Math.round(Math.max(0,Math.min(1,Number.isFinite(n)?n:0))*4096);
 return {session:RS.session,seq,timestamp:timestamp,live:STATE.inputMode==='microphone',
  // rms carries the AGC-normalised loudness envelope (the new-FFT default control
  // source and wave history), not the raw frame RMS: raw RMS depended on track
  // mastering level and rarely exceeded ~40% of the range on the lamp.
  bands:bands.map(norm),rms:norm(snapshot.newLoudness),bass:norm(snapshot.levels[0]),
  mid:norm(snapshot.levels[1]),high:norm(snapshot.levels[2]),
  peak:norm(Math.max(...snapshot.newer)),onsetStrength:norm(Math.max(...snapshot.pulses)),
  onsetMask:mask,beatPhase:Math.round(snapshot.beatPhase*255),
  bpm:Math.round(Math.max(0,snapshot.bpm)*10),confidence:Math.round(snapshot.beatConfidence*255)};
}
function remoteTick(){
 REMOTE.tick();
 if(!STATE.ready||!remoteEnabled()||!STATE.playing)return;
 const pos=sourcePosition();if(pos<0)return;
 const live=STATE.inputMode==='microphone';
 const lookahead=live?0:Math.round(fs*0.24);
 const maxSample=live?pos:STATE.loopDemo?pos+lookahead:Math.min(STATE.pcm.length,pos+lookahead);
 // Never replay seconds of obsolete material after background throttling.
 if(STATE.nextSample<pos-fs*.4){
  resetDSP(Math.max(0,pos-(pos%hop)),false);
 }
 let processed=0;
 while(STATE.nextSample<=maxSample&&processed++<32){
  const at=STATE.nextSample;
  if(!live&&STATE.loopDemo&&STATE.pcm.length){
   const epoch=Math.floor(Math.max(0,at-(+($('fft').value)))/STATE.pcm.length);
   if(epoch>RS.loopEpoch){RS.loopEpoch=epoch;resetDSP(epoch*STATE.pcm.length+(+($('fft').value)),true);continue;}
  }
  processAudio(at);RS.frames.push(captureFeatureSnapshot(at));STATE.nextSample+=hop;
 }
 // Keep only a bounded history for the local presentation consumer.
 while(RS.frames.length>160||RS.frames.length>1&&RS.frames[1].sample<pos-fs*.4)RS.frames.shift();
 let visible=null;
 for(let i=RS.frames.length-1;i>=0;i--){if(RS.frames[i].sample<=pos){visible=RS.frames[i];break;}}
 if(!visible&&RS.frames.length)visible=RS.frames[0];
 showFeatureSnapshot(visible);
 if(!REMOTE.available)return;
 const t=performance.now();if(t<RS.nextSend)return;
 RS.nextSend=t+20;
 const desired=live?pos:pos+Math.round(fs*.13);
 let pick=null;
 for(let i=RS.frames.length-1;i>=0;i--)if(RS.frames[i].sample<=desired){pick=RS.frames[i];break;}
 if(!pick||pick.sample<=RS.lastSentSample)return;
 const latency=Math.max(-100,Math.min(500,Number($('remote-latency').value)||0));
 let timestamp;
 if(live){
  const mic=STATE.mic;
  timestamp=(mic?.receivedAt??t)-(mic?.written-pick.sample||0)*1000/fs+Math.max(60,latency);
 }else timestamp=contextTimeToPerf(STATE.playStart+pick.sample/fs)+latency;
 // Skip deadlines that have already passed, rather than buffering stale frames.
 if(timestamp<t-15){RS.late++;RS.lastSentSample=pick.sample;return;}
 let mask=0;
 for(const f of RS.frames)if(f.sample>RS.lastSentSample&&f.sample<=pick.sample)
  for(let i=0;i<3;i++)if(f.events[i]>0)mask|=(1<<i);
 RS.lastSentSample=pick.sample;
 const seq=RS.seq++,frames={},base=remoteRuntimeConfig();
 REMOTE.stream(d=>{const n=lampBands(d);return frames[n]||=remoteFrame(pick,timestamp,mask,n,seq);},d=>lampConfig(d,base));
}

// Per-lamp adaptation ("Adapt to each lamp"): band count from the lamp's
// width, and optional mode / start-point overrides kept per lamp URL.
const PROFILES_KEY='esp-led-lab.lamp-profiles';
let LAMP_PROFILES={};
try{LAMP_PROFILES=JSON.parse(localStorage.getItem(PROFILES_KEY)||'{}')||{};}catch(_){}
const lampAdapt=()=>Boolean($('remote-adapt')?.checked);
const lampProfile=d=>LAMP_PROFILES[d.url]||{mode:'',bands:'',shift:''};
function setLampProfile(d,key,value){
 LAMP_PROFILES[d.url]={...lampProfile(d),[key]:value};
 try{localStorage.setItem(PROFILES_KEY,JSON.stringify(LAMP_PROFILES));}catch(_){}
 d.stop(); // the next frame restarts the session with the new config / band count
}
function lampBands(d){
 if(!lampAdapt())return +$('remote-bands').value;
 const p=lampProfile(d);
 if(p.bands&&d.supported.includes(+p.bands))return +p.bands;
 return RemoteAudio.pickBands(d.width||currentGeometry().w,d.supported);
}
function lampConfig(d,base){
 const c={...base};
 if(lampAdapt()){
  const p=lampProfile(d);
  if(p.mode!=='')c.audio_effect=+p.mode;
  // Start offset in this lamp's own LEDs; otherwise the lab's offset as a share of the width.
  if(p.shift!==''&&d.width>0)c.origin_shift=Math.max(-500,Math.min(500,Math.round(+p.shift*1000/d.width)));
 }
 // A visualization this lamp's firmware does not render: Off instead.
 if(LAB_MODES.includes(c.audio_effect)&&!d.visualizations.includes(c.audio_effect))c.audio_effect=0;
 return c;
}
const modeName=v=>[...$('audio-mode').options].find(o=>+o.value===+v)?.textContent||String(v);
// Lamp cards are keyed by device and updated in place every 500 ms, so
// buttons keep focus and hover state.
const LAMP_CARDS=new Map();
const STATUS_TEXT={disconnected:'disconnected',connecting:'connecting…',handshake:'handshake…',
 synchronizing:'syncing clock…','clock setup':'syncing clock…','clock rejected':'syncing clock…',
 'socket error':'network error','incompatible protocol':'protocol mismatch','unsupported bands':'no common band count'};
function lampStatus(d){
 if(d.status==='ready')return d.receiverPlaying?['playing','playing']:['ready','ready'];
 if(d.status.startsWith('error')||['socket error','incompatible protocol','unsupported bands'].includes(d.status))
  return [STATUS_TEXT[d.status]||'error','error'];
 return [STATUS_TEXT[d.status]||d.status,''];
}
function lampCard(d){
 let card=LAMP_CARDS.get(d);
 if(card)return card;
 card=document.createElement('div');card.className='lamp';
 card.innerHTML='<div class="lamp-row"><input type="checkbox" title="Send audio to this lamp"><span class="lamp-name"></span><span class="lamp-badge"></span>'+
  '<div class="lamp-actions"><button class="ghost lamp-geo" title="Use this lamp\'s size for the preview" hidden></button>'+
  '<button class="ghost lamp-power" hidden>⏻</button><button class="ghost lamp-connect"></button>'+
  '<button class="ghost lamp-remove" title="Remove lamp" aria-label="Remove lamp">×</button></div></div>'+
  '<div class="lamp-tune"><label>Mode<select class="lamp-mode"></select></label><label>Bands<select class="lamp-bands">'+
  '<option value="">Auto</option><option>16</option><option>32</option><option>64</option></select></label>'+
  '<label>Start, LED<input class="lamp-shift" type="number" step="1" placeholder="lab"></label></div>'+
  '<label class="lamp-ctl" hidden><span aria-hidden="true">☀</span><input class="lamp-bright" type="range" min="0" max="100" aria-label="Lamp brightness"><b class="value"></b></label>'+
  '<div class="lamp-stats"></div>';
 const q=sel=>card.querySelector(sel);
 q('input').onchange=e=>{d.selected=e.target.checked;d.stop();};
 q('.lamp-geo').onclick=()=>applyGeometry(d.width,d.height);
 q('.lamp-connect').onclick=()=>d.socket?d.disconnect():d.connect();
 q('.lamp-power').onclick=()=>d.control('power',d.power===false);
 const bright=q('.lamp-bright'),send=throttle(v=>d.control('brightness',v),120);
 bright.oninput=()=>{held(bright);q('.lamp-ctl .value').textContent=bright.value+'%';send(pct255(+bright.value));};
 q('.lamp-remove').onclick=()=>{REMOTE.remove(d);saveLamps();};
 q('.lamp-name').textContent=d.address;
 // Every mode; a visualization the lamp does not render is sent as Off (see the stats line).
 q('.lamp-mode').innerHTML='<option value="">Same as the lab</option>'+[...$('audio-mode').options]
  .map(o=>`<option value="${o.value}">${o.textContent}</option>`).join('');
 const p=lampProfile(d);
 q('.lamp-mode').value=p.mode;q('.lamp-bands').value=p.bands;q('.lamp-shift').value=p.shift;
 q('.lamp-mode').onchange=e=>setLampProfile(d,'mode',e.target.value);
 q('.lamp-bands').onchange=e=>setLampProfile(d,'bands',e.target.value);
 q('.lamp-shift').onchange=e=>setLampProfile(d,'shift',e.target.value===''?'':String(Math.round(+e.target.value)||0));
 LAMP_CARDS.set(d,card);
 return card;
}
function updateLampCard(d){
 const card=lampCard(d),q=sel=>card.querySelector(sel),[text,cls]=lampStatus(d);
 q('input').checked=d.selected;
 const badge=q('.lamp-badge');badge.textContent=text;badge.className='lamp-badge'+(cls?' '+cls:'');
 const geo=q('.lamp-geo');geo.hidden=!(d.width>0&&d.height>0);
 if(!geo.hidden)geo.textContent=geometryLabel(clampGeometry(d.width,d.height));
 q('.lamp-connect').textContent=d.socket?'Disconnect':'Connect';
 const power=q('.lamp-power'),ctl=q('.lamp-ctl');
 power.hidden=ctl.hidden=!d.controllable;
 power.classList.toggle('on',d.power===true);power.classList.toggle('off',d.power===false);
 power.title=d.power===false?'Lamp is off · turn on':d.power?'Lamp is on · turn off':'Turn the lamp off';
 power.setAttribute('aria-pressed',String(d.power!==false));
 const bright=q('.lamp-bright');
 if(d.brightness!==null&&!isHeld(bright)){bright.value=to100(d.brightness);q('.lamp-ctl .value').textContent=to100(d.brightness)+'%';}
 else if(d.brightness===null&&!isHeld(bright))q('.lamp-ctl .value').textContent='—';
 q('.lamp-tune').hidden=!lampAdapt();
 const stats=[];
 if(d.socket&&d.status==='ready'){
  stats.push(`RTT ${Number.isFinite(d.rtt)?d.rtt.toFixed(1)+' ms':'—'}`,`sent ${d.sent}`,`received ${d.received}`,`buffer ${d.buffered}`);
  if(d.dropped||d.receiverDropped)stats.push(`<span class="warn">dropped ${d.dropped} / ${d.receiverDropped}</span>`);
  if(!d.capabilities.includes('control'))stats.push('<span class="warn">older firmware: power and brightness over HTTP, state unknown</span>');
  if(!d.capabilities.includes('tuning'))stats.push('<span class="warn">older firmware: no reaction tuning</span>');
  else if(!d.visualizations.length)stats.push('<span class="warn">older firmware: no visualizations</span>');
  const mode=lampConfig(d,remoteRuntimeConfig()).audio_effect;
  stats.push(`sends ${lampBands(d)} bands · ${mode?modeName(mode):'audio off'}`);
 }
 if(d.lastError)stats.push(`<span class="err">${d.lastError.replace(/[<>&]/g,'')}</span>`);
 const html=stats.join('<span>·</span>');
 const box=q('.lamp-stats');if(box.innerHTML!==html)box.innerHTML=html;box.hidden=!html;
 return card;
}
// Power and brightness for all connected lamps (saved on each lamp).
const to100=v=>Math.round(v*100/255),pct255=p=>Math.round(p*255/100);
function throttle(fn,ms){let last=0,timer=0,args=null;return (...a)=>{args=a;const wait=last+ms-performance.now();
 if(wait<=0){last=performance.now();fn(...args);}else if(!timer)timer=setTimeout(()=>{timer=0;last=performance.now();fn(...args);},wait);};}
// A slider being dragged (or just released) is not overwritten by lamp reports.
const HELD=new WeakMap();
const held=el=>HELD.set(el,performance.now()),isHeld=el=>document.activeElement===el&&performance.now()-(HELD.get(el)||0)<1500;
function renderLampsMaster(){
 const all=REMOTE.devices,ctl=REMOTE.controllable,offline=all.filter(d=>!d.socket);
 const connect=$('lamps-connect');if(!connect)return;
 connect.disabled=!all.length;
 connect.textContent=!all.length||offline.length===all.length?'Connect all':offline.length?`Connect ${offline.length} more`:'Disconnect all';
 $('lamps-on').disabled=$('lamps-off').disabled=$('lamps-brightness').disabled=!ctl.length;
 const known=ctl.filter(d=>d.power!==null);
 $('lamps-on').classList.toggle('active',known.length>0&&known.every(d=>d.power));
 $('lamps-off').classList.toggle('active',known.length>0&&known.every(d=>!d.power));
 const slider=$('lamps-brightness'),levels=ctl.map(d=>d.brightness).filter(v=>v!==null);
 if(isHeld(slider))return;
 if(!ctl.length){$('lamps-brightness-value').textContent='—';return;}
 if(!levels.length){$('lamps-brightness-value').textContent=slider.value+'%';return;}
 const avg=to100(levels.reduce((a,b)=>a+b,0)/levels.length),same=levels.every(v=>v===levels[0]);
 slider.value=avg;$('lamps-brightness-value').textContent=(same?'':'~')+avg+'%';
}
function initLampsMaster(){
 $('lamps-connect').onclick=()=>{if(REMOTE.devices.some(d=>!d.socket))REMOTE.connectAll();else REMOTE.disconnectAll();renderRemoteDevices();};
 $('lamps-on').onclick=()=>REMOTE.control('power',true);
 $('lamps-off').onclick=()=>REMOTE.control('power',false);
 const slider=$('lamps-brightness'),send=throttle(v=>REMOTE.control('brightness',v),120);
 slider.oninput=()=>{held(slider);$('lamps-brightness-value').textContent=slider.value+'%';send(pct255(+slider.value));};
 const AUTO_KEY='esp-led-lab.autoconnect',auto=$('remote-autoconnect');
 try{auto.checked=localStorage.getItem(AUTO_KEY)==='1';}catch(_){}
 auto.onchange=()=>{try{localStorage.setItem(AUTO_KEY,auto.checked?'1':'0');}catch(_){}if(auto.checked)REMOTE.connectAll();};
 if(auto.checked)REMOTE.connectAll();
}
const LAMPS_KEY='esp-led-lab.lamps';
function saveLamps(){try{localStorage.setItem(LAMPS_KEY,JSON.stringify(REMOTE.devices.map(d=>d.address)));}catch(_){}}
function renderRemoteDevices(){
 // "From connected ESP": follow the device geometry as soon as hello_ack arrives.
 if(STATE.ready&&$('geometry').value==='device'){
  const g=currentGeometry(),m=STATE.modules.new.exports;
  if(m.get_width()!==g.w||m.get_height()!==g.h)refreshLabels();
 }
 const list=$('remote-devices');if(!list)return;
 for(const [d,card] of LAMP_CARDS)if(!REMOTE.devices.includes(d)){card.remove();LAMP_CARDS.delete(d);}
 REMOTE.devices.forEach((d,i)=>{const card=updateLampCard(d);if(list.children[i]!==card)list.insertBefore(card,list.children[i]||null);});
 renderLampsMaster();
 const ready=REMOTE.devices.filter(d=>d.status==='ready');
 const chip=$('lamp-chip');
 if(chip){
  chip.textContent=REMOTE.devices.length?`Lamps: ${ready.length} of ${REMOTE.devices.length}`:'Lamps: none';
  chip.classList.toggle('on',ready.length>0);
 }
 const text=$('remote-state');if(!text)return;
 if(!remoteEnabled()){text.textContent='Streaming off · preview only';return;}
 const bands=+$('remote-bands').value,parts=[];
 if(!REMOTE.devices.length)parts.push('Add a lamp by IP or host name');
 else parts.push(`${STATE.playing?'Audio running':'Audio stopped'} · lamps ready: ${ready.length}`);
 if(RS.late)parts.push(`skipped frames: ${RS.late}`);
 const unsupported=ready.filter(d=>!d.supported.includes(lampBands(d)));
 if(unsupported.length)parts.push(`lamp accepts only ${unsupported.map(d=>d.supported.join('/')).join(', ')} bands`);
 text.textContent=parts.join(' · ');
}
function initRemote(){
 $('remote-add').onclick=()=>{try{const d=REMOTE.add($('remote-address').value);d.connect();$('remote-address').value='';saveLamps();renderRemoteDevices();}
 catch(err){$('remote-state').textContent=err.message;}};
 // Remembered lamps come back disconnected unless "Connect all lamps when the page opens" is on.
 try{for(const address of JSON.parse(localStorage.getItem(LAMPS_KEY)||'[]'))if(typeof address==='string'&&address)REMOTE.add(address);}catch(_){}
 initLampsMaster();
 $('remote-enable').onchange=()=>{
  if(!remoteEnabled()){remoteInvalidate();if(STATE.ready&&STATE.playing)resetDSP(Math.max(0,currentDisplaySample()));}
  else remoteInvalidate();renderRemoteDevices();
 };
 $('remote-bands').onchange=()=>{remoteInvalidate();renderRemoteDevices();};
 $('remote-adapt').onchange=()=>{remoteInvalidate();renderRemoteDevices();};
 $('remote-latency').oninput=()=>{$('remote-latency-value').textContent=$('remote-latency').value+' ms';};
 setInterval(remoteTick,10);setInterval(renderRemoteDevices,500);
}
