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
  // Lab-only visualizations are not in the firmware yet: the lamp gets Off.
  color_effect:s.color,brightness_effect:s.brightness,audio_effect:LAB_MODES.includes(s['audio-mode'])?0:s['audio-mode'],
  audio_min:s['audio-min'],audio_max:s['audio-max'],palette:s.palette,
  speed:s.speed,scale:s.scale,light:s.light,
  param_source:Math.max(0,PARAM_SOURCES.indexOf(s['param-source'])),
  // The reaction range replaces the separate speed floor (0 = stock mapping).
  speed_floor:0,spectrum_shape:s['spectrum-shape'],spectrum_onset:s['spectrum-onset'],
  ...tuningConfig(s,currentGeometry().w)
 };}
function remoteFrame(snapshot,timestamp,mask){
 const count=+($('remote-bands').value);
 const bands=(count===16?snapshot.r16:count===32?snapshot.r32:snapshot.r64);
 const norm=n=>Math.round(Math.max(0,Math.min(1,Number.isFinite(n)?n:0))*4096);
 return {session:RS.session,seq:RS.seq++,timestamp:timestamp,live:STATE.inputMode==='microphone',
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
 REMOTE.stream(remoteFrame(pick,timestamp,mask),remoteRuntimeConfig());
}
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
  '<div class="lamp-actions"><button class="ghost lamp-geo" title="Use this lamp\'s size for the preview" hidden></button><button class="ghost lamp-connect"></button>'+
  '<button class="ghost lamp-remove" title="Remove lamp" aria-label="Remove lamp">×</button></div></div><div class="lamp-stats"></div>';
 const q=sel=>card.querySelector(sel);
 q('input').onchange=e=>{d.selected=e.target.checked;d.stop();};
 q('.lamp-geo').onclick=()=>applyGeometry(d.width,d.height);
 q('.lamp-connect').onclick=()=>d.socket?d.disconnect():d.connect();
 q('.lamp-remove').onclick=()=>{REMOTE.remove(d);saveLamps();};
 q('.lamp-name').textContent=d.address;
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
 const stats=[];
 if(d.socket&&d.status==='ready'){
  stats.push(`RTT ${Number.isFinite(d.rtt)?d.rtt.toFixed(1)+' ms':'—'}`,`sent ${d.sent}`,`received ${d.received}`,`buffer ${d.buffered}`);
  if(d.dropped||d.receiverDropped)stats.push(`<span class="warn">dropped ${d.dropped} / ${d.receiverDropped}</span>`);
  if(!d.capabilities.includes('tuning'))stats.push('<span class="warn">older firmware: no reaction tuning</span>');
 }
 if(d.lastError)stats.push(`<span class="err">${d.lastError.replace(/[<>&]/g,'')}</span>`);
 const html=stats.join('<span>·</span>');
 const box=q('.lamp-stats');if(box.innerHTML!==html)box.innerHTML=html;box.hidden=!html;
 return card;
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
 const unsupported=ready.filter(d=>!d.supported.includes(bands));
 if(unsupported.length)parts.push(`lamp accepts only ${unsupported.map(d=>d.supported.join('/')).join(', ')} bands`);
 text.textContent=parts.join(' · ');
}
function initRemote(){
 $('remote-add').onclick=()=>{try{const d=REMOTE.add($('remote-address').value);d.connect();$('remote-address').value='';saveLamps();renderRemoteDevices();}
 catch(err){$('remote-state').textContent=err.message;}};
 // Remembered lamps come back disconnected; one click connects them.
 try{for(const address of JSON.parse(localStorage.getItem(LAMPS_KEY)||'[]'))if(typeof address==='string'&&address)REMOTE.add(address);}catch(_){}
 $('remote-enable').onchange=()=>{
  if(!remoteEnabled()){remoteInvalidate();if(STATE.ready&&STATE.playing)resetDSP(Math.max(0,currentDisplaySample()));}
  else remoteInvalidate();renderRemoteDevices();
 };
 $('remote-bands').onchange=()=>{remoteInvalidate();renderRemoteDevices();};
 $('remote-latency').oninput=()=>{$('remote-latency-value').textContent=$('remote-latency').value+' ms';};
 setInterval(remoteTick,10);setInterval(renderRemoteDevices,500);
}
