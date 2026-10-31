'use strict';
// Remote Output: feature snapshots, presentation timestamps, the lamp list and
// the target switcher (All lamps or one lamp) above the preview.
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
 return {sample,chroma:STATE.chroma.slice(),newer:STATE.newSpectrum.slice(),display:STATE.displaySpectrum.slice(),displayKey:SPECTRUM.key,
  r16:STATE.newSpectrum.slice(),r32:copy(d.new_remote32_ptr(),32),r64:copy(d.new_remote64_ptr(),64),
  levels:STATE.levels.slice(),pulses:STATE.pulses.slice(),events:STATE.events.slice(),
  metrics, bpm:STATE.bpm,beatConfidence:STATE.beatConfidence,beatPhase:STATE.beatPhase,beatPulse:STATE.beatPulse,
  newParam:STATE.newParam,newLoudness:STATE.newLoudness,newLine:STATE.newLine,
  newWave:copy(d.new_wave_ptr(),128),newWaveHead:d.new_wave_head()};
}
function showFeatureSnapshot(f){
 if(!f)return;
 RS.visual=f;STATE.newSpectrum=f.newer.slice();STATE.chroma=f.chroma.slice();
 STATE.displaySpectrum=f.displayKey===SPECTRUM.key?f.display.slice():[];
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
// One frame per band count (and with or without chroma); all of a moment share the sequence number.
function remoteFrame(snapshot,timestamp,mask,count,seq,chroma=false){
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
  bpm:Math.round(Math.max(0,snapshot.bpm)*10),confidence:Math.round(snapshot.beatConfidence*255),
  // Pitch classes C..B as 0..255, only for lamps listing "chroma" (older firmware gets v1 frames).
  chroma:chroma?snapshot.chroma.map(v=>Math.round(Math.max(0,Math.min(1,Number.isFinite(v)?v:0))*255)):null};
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
 while(RS.frames.length>Math.max(160,Math.ceil(fs*.75/hop))||RS.frames.length>1&&RS.frames[1].sample<pos-fs*.4)RS.frames.shift();
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
 const seq=RS.seq++,frames={};
 REMOTE.stream(d=>{const n=lampBands(d),c=d.acceptsChroma;return frames[n+(c?'c':'')]||=remoteFrame(pick,timestamp,mask,n,seq,c);},lampConfig,lampParams);
}

const modeName=v=>[...$('audio-mode').options].find(o=>+o.value===+v)?.textContent||String(v);
const STATUS_TEXT={disconnected:'disconnected',connecting:'connecting…',handshake:'handshake…',
 synchronizing:'syncing clock…','clock setup':'syncing clock…','clock rejected':'syncing clock…',
 'socket error':'network error','incompatible protocol':'protocol mismatch','unsupported bands':'no common band count'};
function lampStatus(d){
 if(d.status==='ready')return d.receiverPlaying?['playing','playing']:['ready','ready'];
 if(d.status.startsWith('error')||['socket error','incompatible protocol','unsupported bands'].includes(d.status))
  return [STATUS_TEXT[d.status]||'error','error'];
 return [STATUS_TEXT[d.status]||d.status,d.status==='disconnected'?'':'busy'];
}
const ICON=name=>`<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
function throttle(fn,ms){let last=0,timer=0,args=null;return (...a)=>{args=a;const wait=last+ms-performance.now();
 if(wait<=0){last=performance.now();fn(...args);}else if(!timer)timer=setTimeout(()=>{timer=0;last=performance.now();fn(...args);},wait);};}
// A slider being dragged (or just released) is not overwritten by lamp reports.
const HELD=new WeakMap();
const held=el=>HELD.set(el,performance.now()),isHeld=el=>document.activeElement===el&&performance.now()-(HELD.get(el)||0)<1500;
function editLamp(d,tab='effect'){selectTarget(d.url);showPanel(tab);}

// Lamp cards are keyed by device and updated in place every 500 ms, so
// buttons keep focus and hover state.
const LAMP_CARDS=new Map();
function lampCard(d){
 let card=LAMP_CARDS.get(d);
 if(card)return card;
 card=document.createElement('article');card.className='lamp';
 card.innerHTML='<div class="lamp-row"><button type="button" class="lamp-pick" title="Preview and edit this lamp">'+
  '<span class="lamp-dot" aria-hidden="true"></span><span class="lamp-title"><span class="lamp-name"></span><span class="lamp-badge"></span></span></button>'+
  '<button type="button" class="btn small lamp-connect" hidden>Connect</button>'+
  '<button type="button" class="lamp-power" role="switch" aria-checked="false" hidden><span class="switch-track" aria-hidden="true"></span></button></div>'+
  '<label class="lamp-ctl" title="Max brightness: the all-lamps brightness scales within it">'+ICON('sun')+
  '<input class="lamp-bright" type="range" min="0" max="100" value="100" aria-label="Max brightness"><b class="val"></b><span class="lamp-now"></span></label>'+
  '<div class="lamp-foot"><span class="lamp-own"></span><button type="button" class="text-btn lamp-edit">'+ICON('sliders')+'<span>Customize</span></button>'+
  '<button type="button" class="icon-btn lamp-more-toggle" aria-expanded="false" title="Details" aria-label="Lamp details">'+ICON('chevron')+'</button></div>'+
  '<div class="lamp-more" hidden><div class="field-pair">'+
  '<label class="mini">Name<input class="lamp-rename" type="text" autocomplete="off" spellcheck="false"></label>'+
  '<label class="mini">Spectrum bands<select class="lamp-bands"><option value="">Auto</option><option>16</option><option>32</option><option>64</option></select></label></div>'+
  '<label class="check"><input type="checkbox" class="lamp-select"><span>Stream to this lamp</span></label>'+
  '<p class="lamp-address"></p><div class="lamp-stats"></div>'+
  '<div class="lamp-more-actions"><button type="button" class="btn small lamp-disconnect">Disconnect</button>'+
  '<button type="button" class="btn small danger lamp-remove">'+ICON('trash')+'Remove</button></div></div>';
 const q=sel=>card.querySelector(sel),p=lampProfile(d);
 q('.lamp-pick').onclick=()=>selectTarget(d.url);
 q('.lamp-edit').onclick=()=>editLamp(d);
 q('.lamp-connect').onclick=()=>d.connect();
 q('.lamp-disconnect').onclick=()=>d.socket?d.disconnect():d.connect();
 q('.lamp-power').onclick=()=>d.control('power',d.power===false);
 const bright=q('.lamp-bright'),send=throttle(v=>setLampLimit(d,v),120);
 bright.value=p.limit;
 bright.oninput=()=>{held(bright);q('.lamp-ctl .val').textContent=bright.value+'%';send(+bright.value);};
 q('.lamp-more-toggle').onclick=e=>{const more=q('.lamp-more'),open=more.hidden;more.hidden=!open;e.currentTarget.setAttribute('aria-expanded',String(open));card.classList.toggle('open',open);};
 const rename=q('.lamp-rename');rename.value=p.name;rename.placeholder=lampHost(d);
 rename.oninput=()=>{lampProfile(d).name=rename.value.trim();scheduleProfiles();renderRemoteDevices();};
 q('.lamp-bands').value=p.bands;
 q('.lamp-bands').onchange=e=>{lampProfile(d).bands=e.target.value;saveProfiles();d.stop();refreshLabels();}; // the next frame restarts the session
 q('.lamp-select').onchange=e=>{d.selected=e.target.checked;d.stop();};
 q('.lamp-remove').onclick=()=>{REMOTE.remove(d);forgetLamp(d);saveLamps();};
 q('.lamp-address').textContent=d.url;
 LAMP_CARDS.set(d,card);
 return card;
}
function updateLampCard(d){
 const card=lampCard(d),q=sel=>card.querySelector(sel),[text,cls]=lampStatus(d),size=lampSize(d),p=lampProfile(d);
 card.classList.toggle('selected',TARGET===d.url);
 card.classList.toggle('state-playing',cls==='playing');card.classList.toggle('state-error',cls==='error');
 q('.lamp-pick').setAttribute('aria-pressed',String(TARGET===d.url));
 q('.lamp-name').textContent=lampName(d);
 q('.lamp-dot').className='lamp-dot '+cls;
 q('.lamp-badge').textContent=[text,size&&geometryLabel(size),d.power===false&&d.controllable&&'power off',!d.selected&&'not streamed'].filter(Boolean).join(' · ');
 q('.lamp-connect').hidden=Boolean(d.socket);
 const power=q('.lamp-power');power.hidden=!d.controllable;
 power.setAttribute('aria-checked',String(d.power!==false));
 power.title=d.power===false?'Lamp is off · turn on':'Lamp is on · turn off';power.setAttribute('aria-label',power.title);
 const bright=q('.lamp-bright');
 if(!isHeld(bright)){bright.value=p.limit;paintRange(bright);q('.lamp-ctl .val').textContent=p.limit+'%';}
 q('.lamp-now').textContent=d.controllable&&d.brightness!==null?`now ${to100(d.brightness)}%`:'';
 const groups=ownGroups(d);
 q('.lamp-own').textContent=groups.length?`Own ${groups.join(', ').toLowerCase()}`:'Same as All lamps';
 q('.lamp-own').classList.toggle('custom',groups.length>0);
 q('.lamp-edit span').textContent=TARGET===d.url?'Edit effect':'Customize';
 q('.lamp-disconnect').textContent=d.socket?'Disconnect':'Connect';
 q('.lamp-select').checked=d.selected;
 const stats=[];
 if(d.socket&&d.status==='ready'){
  stats.push(`RTT ${Number.isFinite(d.rtt)?d.rtt.toFixed(1)+' ms':'—'}`,`sent ${d.sent}`,`received ${d.received}`,`buffer ${d.buffered}`);
  if(d.dropped||d.receiverDropped)stats.push(`<span class="warn">dropped ${d.dropped} / ${d.receiverDropped}</span>`);
  if(!d.capabilities.includes('control'))stats.push('<span class="warn">older firmware: power and brightness over HTTP, state unknown</span>');
  if(!d.capabilities.includes('tuning'))stats.push('<span class="warn">older firmware: no reaction tuning</span>');
  else if(!d.visualizations.length)stats.push('<span class="warn">older firmware: no visualizations</span>');
  else if(!d.acceptsParams(FX_PARAMS_VERSION))stats.push('<span class="warn">older firmware: effect parameters stay at their defaults</span>');
  const mode=lampConfig(d).audio_effect;
  stats.push(`sends ${lampBands(d)} bands${d.acceptsChroma?' + notes':''} · ${mode?modeName(mode):'audio off'}`);
 }
 if(d.lastError)stats.push(`<span class="err">${d.lastError.replace(/[<>&]/g,'')}</span>`);
 const html=stats.map(t=>t.startsWith('<')?t:`<span>${t}</span>`).join('');
 const box=q('.lamp-stats');if(box.innerHTML!==html)box.innerHTML=html;box.hidden=!html;
 return card;
}
// Power and brightness for all connected lamps (saved on each lamp).
function renderLampsMaster(){
 const all=REMOTE.devices,ctl=REMOTE.controllable,offline=all.filter(d=>!d.socket);
 $('lamps-master').hidden=!all.length;
 const connect=$('lamps-connect');
 connect.disabled=!all.length;
 connect.textContent=!all.length||offline.length===all.length?'Connect all':offline.length?`Connect ${offline.length} more`:'Disconnect all';
 $('lamps-on').disabled=$('lamps-off').disabled=$('lamps-brightness').disabled=!ctl.length;
 const known=ctl.filter(d=>d.power!==null);
 for(const [id,on] of [['lamps-on',true],['lamps-off',false]]){
  const active=known.length>0&&known.every(d=>d.power===on);
  $(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',String(active));
 }
 $('lamps-limit-hint').hidden=!all.some(d=>lampProfile(d).limit<100);
 const slider=$('lamps-brightness');
 if(isHeld(slider))return;
 if(!ctl.length){$('lamps-brightness-value').textContent='—';return;}
 const level=lampsMaster();
 if(!level){$('lamps-brightness-value').textContent=slider.value+'%';return;}
 slider.value=level.value;paintRange(slider);$('lamps-brightness-value').textContent=(level.mixed?'~':'')+level.value+'%';
}
function initLampsMaster(){
 $('lamps-connect').onclick=()=>{if(REMOTE.devices.some(d=>!d.socket))REMOTE.connectAll();else REMOTE.disconnectAll();renderRemoteDevices();};
 $('lamps-on').onclick=()=>REMOTE.control('power',true);
 $('lamps-off').onclick=()=>REMOTE.control('power',false);
 const slider=$('lamps-brightness'),send=throttle(setLampsMaster,120);
 slider.oninput=()=>{held(slider);$('lamps-brightness-value').textContent=slider.value+'%';send(+slider.value);};
 const AUTO_KEY='esp-led-lab.autoconnect',auto=$('remote-autoconnect');
 try{auto.checked=localStorage.getItem(AUTO_KEY)==='1';}catch(_){}
 auto.onchange=()=>{try{localStorage.setItem(AUTO_KEY,auto.checked?'1':'0');}catch(_){}if(auto.checked)REMOTE.connectAll();};
 if(auto.checked)REMOTE.connectAll();
}

// Target switcher above the preview: All lamps or one lamp. The preview shows
// the target and the Effect / Reaction panels edit it.
const TARGET_BUTTONS=new Map();
function targetButton(key){
 let b=TARGET_BUTTONS.get(key);
 if(b)return b;
 b=document.createElement('button');b.type='button';b.className='target';b.dataset.target=key;
 b.innerHTML=key==='all'?ICON('broadcast')+'<span class="target-name">All lamps</span>':'<span class="lamp-dot" aria-hidden="true"></span><span class="target-name"></span><i class="own-mark" title="Has its own settings"></i>';
 b.onclick=()=>selectTarget(key);
 TARGET_BUTTONS.set(key,b);
 return b;
}
// The control (or section heading) that marks a setting the edited lamp owns.
const OWN_MARKS=new Map();
function ownMark(id){
 if(!OWN_MARKS.has(id)){const el=$(id);OWN_MARKS.set(id,el.closest('.field,.check')||el.closest('.section')?.querySelector('.section-head'));}
 return OWN_MARKS.get(id);
}
function renderTargetNote(note,d,others,withAll){
 note.replaceChildren();
 note.classList.toggle('for-lamp',Boolean(d));
 if(!REMOTE.devices.length){
  note.hidden=!withAll;
  if(withAll){const text=document.createElement('span');text.textContent='Sent to lamps with the stream; the preset saved on the lamp is not changed.';note.append(ICON_NODE('broadcast'),text);}
  return;
 }
 note.hidden=false;
 const text=document.createElement('span'),name=document.createElement('b');
 note.append(ICON_NODE(d?'bulb':'broadcast'),text);
 if(d){
  const own=ownKeys(d).length;name.textContent=lampName(d);
  text.append('Editing ',name,own?` only · ${own} own setting${own===1?'':'s'}`:' only · same as All lamps until you change something');
  if(own){const b=document.createElement('button');b.type='button';b.className='text-btn';b.textContent='Use All lamps settings';b.onclick=()=>useSharedSettings(d);note.append(b);}
 }else{
  name.textContent='All lamps';text.append('Editing ',name);
  if(others.length)text.append(` · ${others.length===1?lampName(others[0])+' keeps its':others.length+' lamps keep their'} own settings`);
 }
}
const ICON_NODE=name=>{const t=document.createElement('template');t.innerHTML=ICON(name);return t.content.firstChild;};
function renderTargets(){
 const bar=$('targets'),devices=REMOTE.devices,d=targetLamp();
 bar.hidden=!devices.length;
 const keys=['all',...devices.map(x=>x.url)];
 for(const [key,b] of TARGET_BUTTONS)if(!keys.includes(key)){b.remove();TARGET_BUTTONS.delete(key);}
 keys.forEach((key,i)=>{
  const b=targetButton(key),lamp=devices.find(x=>x.url===key);
  if(lamp){
   b.querySelector('.target-name').textContent=lampName(lamp);
   b.querySelector('.lamp-dot').className='lamp-dot '+lampStatus(lamp)[1];
   b.querySelector('.own-mark').hidden=!ownKeys(lamp).length;
   b.title=`${lampName(lamp)} · ${lampStatus(lamp)[0]} · preview and edit this lamp`;
  }else b.title='Preview and edit the settings shared by all lamps';
  b.setAttribute('aria-pressed',String(TARGET===key));
  if(bar.children[i]!==b)bar.insertBefore(b,bar.children[i]||null);
 });
 if(bar.dataset.target!==TARGET){bar.dataset.target=TARGET;TARGET_BUTTONS.get(TARGET)?.scrollIntoView?.({block:'nearest',inline:'nearest'});}
 const others=devices.filter(x=>ownKeys(x).length);
 for(const note of document.querySelectorAll('.target-note'))renderTargetNote(note,d,others,note.hasAttribute('data-shared-note'));
 const own=d?lampProfile(d).overrides:{};
 for(const id of LAMP_KEYS)ownMark(id)?.classList.toggle('own',id in own);
 for(const b of document.querySelectorAll('[data-reset]'))b.title=d?`Use the All lamps values for ${lampName(d)}`:b.dataset.reset;
}

const LAMPS_KEY='esp-led-lab.lamps';
function saveLamps(){try{localStorage.setItem(LAMPS_KEY,JSON.stringify(REMOTE.devices.map(d=>d.address)));}catch(_){}}
function renderRemoteDevices(){
 // Remember each lamp's size, so its preview is right before it reconnects.
 for(const d of REMOTE.devices)if(d.width>0&&d.height>0){
  const p=lampProfile(d);if(!p.size||p.size.w!==d.width||p.size.h!==d.height){p.size={w:d.width,h:d.height};scheduleProfiles();}
 }
 if(editorStale())loadEditor();
 // The preview follows a size that just arrived (the edited lamp, "From connected lamp").
 if(STATE.ready){
  const g=currentGeometry(),m=STATE.modules.new.exports;
  if(m.get_width()!==g.w||m.get_height()!==g.h)refreshLabels();
 }
 if(TARGET!=='all'&&!targetLamp())selectTarget('all');
 const list=$('remote-devices');if(!list)return;
 for(const [d,card] of LAMP_CARDS)if(!REMOTE.devices.includes(d)){card.remove();LAMP_CARDS.delete(d);}
 REMOTE.devices.forEach((d,i)=>{const card=updateLampCard(d);if(list.children[i]!==card)list.insertBefore(card,list.children[i]||null);});
 renderLampsMaster();renderTargets();
 const ready=REMOTE.devices.filter(d=>d.status==='ready'),live=Boolean(remoteEnabled()&&STATE.playing&&ready.length);
 // Header pill: one dot per lamp, colored by its state.
 const chip=$('lamp-chip'),all=REMOTE.devices.length;
 const dots=REMOTE.devices.slice(0,8).map(d=>`<i class="${lampStatus(d)[1]}"></i>`).join('');
 if($('lamp-dots').innerHTML!==dots)$('lamp-dots').innerHTML=dots;
 $('lamp-chip-text').textContent=!all?'No lamps':`${ready.length}/${all} ${all===1?'lamp':'lamps'}`+(remoteEnabled()?'':' · stream off');
 chip.title=!all?'Lamps over Wi-Fi: add a lamp':`Lamps over Wi-Fi: ${ready.length} of ${all} ready`+(live?', streaming':'');
 chip.classList.toggle('on',ready.length>0&&remoteEnabled());
 chip.classList.toggle('live',live);
 $('lamps-badge').hidden=!live;
 $('lamps-empty').hidden=all>0;
 const text=$('remote-state');
 if(!remoteEnabled()){text.textContent='Off · the preview only';return;}
 const parts=[];
 if(!all)parts.push('On · no lamps yet');
 else parts.push(`${STATE.playing?'Audio running':'Audio stopped'} · lamps ready: ${ready.length}`);
 if(RS.late)parts.push(`skipped frames: ${RS.late}`);
 const unsupported=ready.filter(d=>!d.supported.includes(lampBands(d)));
 if(unsupported.length)parts.push(`lamp accepts only ${unsupported.map(d=>d.supported.join('/')).join(', ')} bands`);
 text.textContent=parts.join(' · ');
}
function addLamp(){
 try{
  const d=REMOTE.add($('remote-address').value);d.connect();$('remote-address').value='';saveLamps();renderRemoteDevices();
  $('remote-address').setCustomValidity('');$('lamp-add-error').hidden=true;
 }catch(err){$('lamp-add-error').textContent=err.message;$('lamp-add-error').hidden=false;}
}
function initRemote(){
 $('lamp-chip').onclick=()=>{
  showPanel('lamps');
  if(!REMOTE.devices.length)$('remote-address').focus({preventScroll:true});
 };
 $('remote-add').onclick=addLamp;
 // Remembered lamps come back disconnected unless "Connect all lamps when the page opens" is on.
 try{for(const address of JSON.parse(localStorage.getItem(LAMPS_KEY)||'[]'))if(typeof address==='string'&&address)REMOTE.add(address);}catch(_){}
 initLampsMaster();
 $('remote-enable').onchange=()=>{
  if(!remoteEnabled()){remoteInvalidate();if(STATE.ready&&STATE.playing)resetDSP(Math.max(0,currentDisplaySample()));}
  else remoteInvalidate();renderRemoteDevices();
 };
 $('remote-bands').onchange=()=>{remoteInvalidate();renderRemoteDevices();refreshLabels();};
 $('remote-adapt').onchange=()=>{remoteInvalidate();renderRemoteDevices();refreshLabels();};
 $('remote-latency').oninput=()=>{$('remote-latency-value').textContent=$('remote-latency').value+' ms';};
 setInterval(remoteTick,10);setInterval(renderRemoteDevices,500);
}
