'use strict';
// WASM bootstrap, animation loop and UI wiring.
// The standalone build defines WASM_EMBEDDED (base64) so the page also works
// from file://; the development page fetches the files next to index.html.
async function loadWasm(name){
 if(typeof WASM_EMBEDDED!=='undefined'&&WASM_EMBEDDED[name]){
  const bin=atob(WASM_EMBEDDED[name]),bytes=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);
  return bytes.buffer;
 }
 const resp=await fetch('wasm/'+name);
 if(!resp.ok)throw new Error(`Could not fetch ${name}: ${resp.status}`);
 return resp.arrayBuffer();
}
async function init(){
 try{
  const [render,dsp]=await Promise.all(['render.wasm','dsp.wasm'].map(loadWasm));
  const {module,instance}=await WebAssembly.instantiate(render);
  STATE.modules.new=instance;
  // A second renderer draws the palette swatches and color-effect thumbnails.
  STATE.modules.thumb=await WebAssembly.instantiate(module);
  STATE.canvases.new={off:document.createElement('canvas')};
  const dspCode=await WebAssembly.instantiate(dsp);
  // The module is kept for the DSP view's A/B instance.
  STATE.modules.dsp=dspCode.instance;STATE.modules.dspModule=dspCode.module;
  STATE.ready=true;
  STATE.modules.new.exports.set_palette(3);
  initPickers();refreshLabels();resetDSP();
  $('status').textContent='Pick a track or the demo beat';$('play').disabled=true;
  requestAnimationFrame(animate);
 }catch(err){
  console.error(err);$('status').textContent='WASM loading error: '+err.message;
  alert('Could not load WebAssembly. Run a local server (make serve) or open dist/standalone.html.\n'+err.message);
 }
}
function animate(t){requestAnimationFrame(animate);if(!STATE.ready)return;const dt=Math.min(50,Math.max(1,STATE.lastFrame?t-STATE.lastFrame:16.667));STATE.lastFrame=t;
let current=-1;
if(STATE.playing&&STATE.inputMode==='microphone'&&STATE.mic){
 current=STATE.mic.written;$('now').textContent=asTime(current/fs);
}else if(STATE.playing&&STATE.inputMode==='file'&&STATE.pcm){
 const elapsed=Math.max(0,STATE.context.currentTime-STATE.playStart);
 current=STATE.loopDemo?Math.floor((elapsed%STATE.buffer.duration)*fs):Math.min(STATE.pcm.length,Math.floor(elapsed*fs));
 if(!remoteEnabled()&&STATE.loopDemo&&current<STATE.lastPlaybackSample)resetDSP(0);
 if(remoteEnabled()&&STATE.loopDemo&&STATE.pcm.length){
  const epoch=Math.floor(elapsed/STATE.buffer.duration);
  if(epoch>RS.lastRenderedEpoch){RS.lastRenderedEpoch=epoch;
   STATE.modules.new.exports.reset_render();}
 }
 STATE.lastPlaybackSample=current;
 if(!STATE.seeking){$('now').textContent=asTime(current/fs);setSeek(Math.floor(current/STATE.pcm.length*1000));}
}else if(!STATE.playing&&STATE.tailUntil>=0){
 // Paused or stopped: feed silence at real time until the envelopes settle.
 STATE.tailPos+=dt*fs/1000;current=Math.min(STATE.tailUntil,Math.floor(STATE.tailPos));
 if(current>=STATE.tailUntil)STATE.tailUntil=-1;
}
if(current>=0&&(!remoteEnabled()||!STATE.playing)){
 const budget=Math.max(12,Math.ceil(fs*.06/hop));
 let processed=0;while(STATE.nextSample<=current&&processed<budget){processAudio(STATE.nextSample);STATE.nextSample+=hop;processed++;}
 if(STATE.nextSample<current-budget*hop)STATE.nextSample=Math.max(+($('fft').value),current-(current%hop));
}
const s=settings(),m=STATE.modules.new.exports;feedRender(m);if(LAYOUT.test)m.render_test_pattern(layoutOriginShift(currentLayout()));else m.render_frame(dt);paint(m,$('canvas-new'),'new',s['led-dots']);
// Meters follow every rendered frame; the FPS counter has its own clock.
meters();
if(t-STATE.lastUi>=100){refreshEffective();STATE.lastUi=t;}
STATE.frames++;
if(t-STATE.lastStats>=1000){$('fps').textContent=Math.round(STATE.frames*1000/Math.max(1,t-STATE.lastStats))+' FPS';STATE.frames=0;STATE.lastStats=t;}
}
$('fps').hidden=!/[?&]debug\b/.test(location.search);
restoreSettings();
initRemote();
spectrumPlan();
initTuning();initLayout();
initUi();
initDspView();
initLamps();
renderRemoteDevices();
for(const id of inputIds.filter(id=>id!=='sample-rate')){$(id).addEventListener('input',refreshLabels);$(id).addEventListener('change',refreshLabels);}
// Microphone or file / demo. A failed microphone falls back to the file side.
async function setInputMode(mode){
 pauseAudio();STATE.inputMode=mode;
 if(STATE.ready)resetDSP(); // the release tail would read the other source's timeline
 const fileSide=()=>{
  $('play').disabled=!STATE.buffer;playLabel('play','Play (Space)');$('filename').textContent=STATE.fileName||'No audio file';
  $('duration').textContent=STATE.buffer?asTime(STATE.buffer.duration):'00:00';$('now').textContent=asTime(STATE.pausedAt);$('seek').disabled=false;
 };
 if(mode==='microphone'){
  $('play').disabled=false;playLabel('mic','Start microphone (Space)');
  try{await startMicrophone();}catch(err){console.error(err);STATE.inputMode='file';await changeAnalysisRate(fs);fileSide();$('status').textContent='Microphone error: '+err.message;}
 }else{await changeAnalysisRate(fs);fileSide();$('status').textContent=STATE.buffer?'Ready to play':'Pick a track or the demo beat';}
 refreshAnalysisUi();
 if(typeof renderPlaylist==='function')renderPlaylist();
}
$('playback-volume').addEventListener('input',()=>{
 const v=+$('playback-volume').value/100;
 $('playback-volume-value').textContent=Math.round(v*100)+'%';
 if(STATE.playbackGain&&STATE.context)STATE.playbackGain.gain.setTargetAtTime(v,STATE.context.currentTime,.01);
});
$('play').onclick=async()=>{try{if(STATE.playing)pauseAudio();else await playAudio();}catch(err){console.error(err);$('status').textContent='Error: '+err.message;}};
// While the slider is held the animation loop leaves it alone; the jump happens on release.
$('seek').addEventListener('pointerdown',()=>{STATE.seeking=true;});
for(const ev of ['pointerup','pointercancel','blur'])$('seek').addEventListener(ev,()=>{STATE.seeking=false;});
$('seek').oninput=()=>{if(!STATE.buffer||STATE.inputMode!=='file')return;STATE.seeking=true;$('now').textContent=asTime(+($('seek').value)/1000*STATE.buffer.duration);};
$('seek').onchange=()=>{STATE.seeking=false;if(STATE.buffer&&STATE.inputMode==='file')seekTo(+($('seek').value)/1000*STATE.buffer.duration);};
$('sample-rate').addEventListener('change',()=>changeAnalysisRate(+$('sample-rate').value));
$('fft').addEventListener('change',()=>{
 if(!STATE.ready)return;
 const start=STATE.inputMode==='microphone'?STATE.mic?.written||0:
 (STATE.playing&&STATE.context?Math.floor((STATE.context.currentTime-STATE.playStart)*fs):Math.floor(STATE.pausedAt*fs));
 resetDSP(Math.max(0,start));
});
// Keep the frequency range at least half an octave wide while dragging.
for(const id of ['freq-min','freq-max'])$(id).addEventListener('input',()=>{
 const lo=sliderHz(+$('freq-min').value),hi=sliderHz(+$('freq-max').value);
 if(hi>=lo*1.5)return;
 if(id==='freq-min')$('freq-max').value=Math.min(1000,hzSlider(lo*1.5)+1);
 if(id==='freq-max'||sliderHz(+$('freq-max').value)<lo*1.5)$('freq-min').value=Math.max(0,hzSlider(sliderHz(+$('freq-max').value)/1.5)-1);
 refreshLabels();
});
// Analyzer defaults: 40 Hz is set in Hz so it survives the change back to 16 kHz.
function resetAnalyzer(){
 resetControls(['fft','attack','release','noise-db','adaptive-floor','floor-rise','floor-fall','gain','transient','agc','compression','window','tilt','eq-bass','eq-mid','eq-high','balance','smoothing','split-mid','split-high','peak-hold','onset-memory',
  'onset-trim-0','onset-trim-1','onset-trim-2','holdoff-0','holdoff-1','holdoff-2','flash-0','flash-1','flash-2','bpm-min','bpm-max']);
 $('freq-min').value=hzSlider(40);$('freq-max').value=1000;refreshLabels();
 if(STATE.ready)resetDSP(Math.max(0,STATE.inputMode==='microphone'?STATE.mic?.written||0:Math.floor((STATE.playing&&STATE.context?STATE.context.currentTime-STATE.playStart:STATE.pausedAt)*fs)));
 changeAnalysisRate(16000);
}
$('defaults').onclick=resetAnalyzer;
refreshLabels();
init();
