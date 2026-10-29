'use strict';
// Audio sources (file, demo loop, microphone) and the DSP feed.
function bufferToPCM(audio){const targetLength=Math.floor(audio.duration*fs);const pcm=new Float32Array(targetLength);const ratio=audio.sampleRate/fs;const channels=[];for(let c=0;c<Math.min(audio.numberOfChannels,2);c++)channels.push(audio.getChannelData(c));for(let i=0;i<targetLength;i++){const t=i*ratio,index=Math.floor(t),fraction=t-index;let val=0;for(const chan of channels){const a=chan[Math.min(index,chan.length-1)]||0,b=chan[Math.min(index+1,chan.length-1)]||a;val+=a+(b-a)*fraction;}pcm[i]=val/channels.length;}return pcm;}
// Browser OfflineAudioContext uses anti-aliased sample-rate conversion. Plain linear
// interpolation (below) aliases high-frequency MP3/WAV energy into FFT bands.
async function resamplePCM(audio){
 try{
  const count=Math.max(1,Math.floor(audio.duration*fs));
  const offline=new OfflineAudioContext(1,count,fs);
  const src=offline.createBufferSource();src.buffer=audio;src.connect(offline.destination);src.start(0);
  const rendered=await offline.startRendering();
  return Float32Array.from(rendered.getChannelData(0));
 }catch(e){console.warn('OfflineAudioContext resampling unavailable, using linear fallback:',e);return bufferToPCM(audio);}
}
function demoAudio(){const rate=16000,len=16,ns=rate*len,data=new Float32Array(ns);let rand=39929;const noise=()=>{rand^=rand<<13;rand^=rand>>>17;rand^=rand<<5;return ((rand>>>0)/4294967295)*2-1;};const notes=[220,261.63,329.63,392,329.63,293.66,261.63,196];
for(let i=0;i<ns;i++){let t=i/rate,bar=t%2,beat=t%0.5,eighth=t%0.25;let value=0;
let kick=Math.exp(-beat*24)*Math.sin(2*Math.PI*(59*beat+28*beat*Math.exp(-beat*22)));value+=.47*kick;
if(Math.floor(t/.5)%4===1||Math.floor(t/.5)%4===3){let b=beat;value+=.22*Math.exp(-b*27)*noise();}
value+=.14*Math.exp(-eighth*82)*noise();
let note=notes[Math.floor(t/.5)%notes.length];value+=.12*Math.sin(2*Math.PI*note*t)*Math.exp(-beat*2.7);value+=.06*Math.sin(2*Math.PI*(note*.5)*t)*Math.exp(-beat*1.4);data[i]=Math.max(-.85,Math.min(.85,value));}
const b=STATE.context.createBuffer(1,ns,rate);b.getChannelData(0).set(data);return {buffer:b,pcm:data};}
function resetDSP(startSample=0,preserveRemote=false){
 if(!preserveRemote)remoteInvalidate();
 const n=+($('fft')?.value||512);
 STATE.nextSample=Math.max(n,Math.ceil(startSample/hop)*hop);
 STATE.lastPlaybackSample=startSample;STATE.silenceFrom=Infinity;STATE.tailUntil=-1;
 STATE.newParam=0;STATE.newLoudness=0;STATE.newLine=0;STATE.levels.fill(0);STATE.bpm=STATE.beatConfidence=STATE.beatPhase=STATE.beatPulse=0;STATE.newSpectrum.fill(0);STATE.pulses.fill(0);STATE.events.fill(0);STATE.modules.dsp.exports.reset_dsp();if(!preserveRemote)STATE.modules.new.exports.reset_render();}
// After a pause, stop or the end of a file the DSP keeps running on silence in
// real time (see animate), so the spectrum and envelopes release as they would
// on a quiet input instead of freezing on the last frame.
function startSilenceTail(){
 if(!STATE.ready)return;
 STATE.silenceFrom=Math.min(STATE.silenceFrom,STATE.nextSample);STATE.tailPos=STATE.nextSample-hop;
 const release=+($('release')?.value||210);
 STATE.tailUntil=STATE.tailPos+Math.round(fs*Math.min(6,Math.max(2.5,release*6/1000)));
}
function loadBuffer(buffer,pcm,name,isDemo=false){
 pauseAudio();STATE.inputMode='file';$('audio-input').value='file';STATE.loopDemo=isDemo;
 STATE.buffer=buffer;STATE.pcm=pcm;STATE.audioLen=buffer.duration;STATE.fileName=name;STATE.pausedAt=0;resetDSP();
 if(+$('audio-mode').value===0){$('audio-mode').value=3;refreshLabels();}
 $('filename').textContent=name;$('duration').textContent=asTime(buffer.duration);$('now').textContent='00:00';$('seek').value=0;$('seek').disabled=false;
 $('play').disabled=false;$('play').textContent='▶ Play';$('status').textContent='Ready to play: '+name;
}
async function ensureAudio(){
 if(!STATE.context)STATE.context=new (window.AudioContext||window.webkitAudioContext)();
 if(!STATE.playbackGain){STATE.playbackGain=STATE.context.createGain();STATE.playbackGain.gain.value=+$('playback-volume').value/100;STATE.playbackGain.connect(STATE.context.destination);}
 await STATE.context.resume();
}
// Each BufferSource is single-use. A new source AND a fresh DSP timeline are
// required for replay after natural onended, including files with no loop.
async function playAudio(){
 if(STATE.inputMode==='microphone')return startMicrophone();
 if(!STATE.buffer||STATE.playing)return;
 await ensureAudio();
 if(STATE.inputMode!=='file'||STATE.playing)return;
 // nextSample also advances through the silence tail; only a finished timeline restarts.
 if(STATE.pausedAt>=STATE.buffer.duration-.005||STATE.nextSample>=STATE.pcm.length&&STATE.silenceFrom===Infinity||STATE.pausedAt===0) {
  STATE.pausedAt=0;resetDSP(0);
 }else{
  STATE.silenceFrom=Infinity;STATE.tailUntil=-1;
  STATE.nextSample=Math.max(+($('fft')?.value||512),Math.ceil(STATE.pausedAt*fs/hop)*hop);
 }
 const context=STATE.context,source=context.createBufferSource();
 source.buffer=STATE.buffer;source.loop=STATE.loopDemo;source.connect(STATE.playbackGain);
 const offset=Math.min(STATE.pausedAt,Math.max(0,STATE.buffer.duration-.005));
 remoteInvalidate();STATE.playStart=context.currentTime-offset;STATE.source=source;STATE.playing=true;
 source.onended=()=>{
  if(STATE.source!==source)return;
  STATE.playing=false;STATE.source=null;STATE.pausedAt=0;remoteInvalidate();startSilenceTail();
  $('play').textContent='▶ Play again';$('now').textContent='00:00';$('seek').value=0;
  $('status').textContent='Playback finished · press Play to start again';
 };
 source.start(0,offset);$('play').textContent='Ⅱ Pause';$('status').textContent='Playing · DSP and rendering in WebAssembly';
}
function stopMicrophone(){
 remoteInvalidate();
 STATE.micGeneration++;
 const mic=STATE.mic;STATE.mic=null;
 if(mic){
  if(mic.worklet)mic.worklet.port.onmessage=null;
  if(mic.processor)mic.processor.onaudioprocess=null;
  for(const node of [mic.input,mic.lowpass1,mic.lowpass2,mic.worklet,mic.processor,mic.silent])try{node?.disconnect();}catch(_){}
  mic.stream.getTracks().forEach(t=>t.stop());
 }
 if(STATE.playing)startSilenceTail();
 STATE.playing=false;STATE.source=null;
 $('play').textContent='🎙 Start microphone';
}
function pauseAudio(){
 remoteInvalidate();
 if(STATE.inputMode==='microphone'){stopMicrophone();return;}
 if(STATE.playing){
  STATE.pausedAt=Math.min(STATE.buffer?.duration||0,Math.max(0,STATE.context.currentTime-STATE.playStart));
  const src=STATE.source;STATE.source=null;STATE.playing=false;try{src?.stop();}catch(_){}
  startSilenceTail();
 }
 $('play').textContent='▶ Play';
}
function receiveMicSamples(samples,mic){
 if(STATE.mic!==mic||STATE.inputMode!=='microphone')return;
 // Continuous linear 16k resampling, no per-chunk phase discontinuities.
 const step=mic.nativeRate/fs;
 for(let i=0;i<samples.length;i++){
  const x=samples[i];const k=mic.nativeCount++;
  if(k===0){mic.previous=x;continue;}
  while(mic.nextOutput<=k){
   const t=Math.max(0,Math.min(1,mic.nextOutput-(k-1)));
   const y=mic.previous*(1-t)+x*t;
   mic.ring[mic.written%mic.ring.length]=y;mic.written++;
   mic.nextOutput+=step;
  }
  mic.previous=x;
 }
 mic.receivedAt=performance.now();
}
function micWorkletModule(){return `
class EspLedMicCapture extends AudioWorkletProcessor {
 constructor(){super();this.pending=new Float32Array(1024);this.used=0;this.active=true;this.port.onmessage=e=>{if(e.data==='stop')this.active=false;};}
 process(inputs,outputs){
  for(const ch of outputs[0]||[])ch.fill(0);
  if(!this.active)return false;
  const input=inputs[0]&&inputs[0][0];
  if(input)for(let i=0;i<input.length;i++){
   this.pending[this.used++]=input[i];
   if(this.used===1024){let data=this.pending;this.port.postMessage(data,[data.buffer]);this.pending=new Float32Array(1024);this.used=0;}
  }
  return true;
 }
}
registerProcessor('esp-led-mic-capture',EspLedMicCapture);`}
async function startMicrophone(){
 if(STATE.mic&&STATE.playing)return;
 const ticket=++STATE.micGeneration;
 if(!navigator.mediaDevices?.getUserMedia)throw new Error('This browser does not provide microphone access. Open the page over HTTPS or from localhost.');
 await ensureAudio();
 if(ticket!==STATE.micGeneration||STATE.inputMode!=='microphone')return;
 $('status').textContent='Requesting microphone access…';
 const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false});
 if(ticket!==STATE.micGeneration||STATE.inputMode!=='microphone'){stream.getTracks().forEach(t=>t.stop());return;}
 const mic={stream,nativeRate:STATE.context.sampleRate,ring:new Float32Array(fs*12),written:0,nativeCount:0,nextOutput:0,previous:0,input:null,worklet:null,processor:null,silent:null};
 STATE.mic=mic;
 try{
  mic.input=STATE.context.createMediaStreamSource(stream);
  // Browser audio hardware often delivers 44.1/48 kHz. Apply two native
  // lowpass sections before 16 kHz downsampling to suppress aliasing.
  let micOutput=mic.input;
  if(mic.nativeRate>fs*1.25){
   mic.lowpass1=STATE.context.createBiquadFilter();mic.lowpass2=STATE.context.createBiquadFilter();
   for(const lp of [mic.lowpass1,mic.lowpass2]){lp.type='lowpass';lp.frequency.value=7000;lp.Q.value=0.707;}
   mic.input.connect(mic.lowpass1);mic.lowpass1.connect(mic.lowpass2);micOutput=mic.lowpass2;
  }
  mic.silent=STATE.context.createGain();mic.silent.gain.value=0;mic.silent.connect(STATE.context.destination);
  if(STATE.context.audioWorklet&&typeof AudioWorkletNode!=='undefined'){
   try{
    if(!STATE.micWorkletReady){const url=URL.createObjectURL(new Blob([micWorkletModule()],{type:'text/javascript'}));
     try{await STATE.context.audioWorklet.addModule(url);STATE.micWorkletReady=true;}finally{URL.revokeObjectURL(url);}}
    if(ticket!==STATE.micGeneration||STATE.mic!==mic)return;
    mic.worklet=new AudioWorkletNode(STATE.context,'esp-led-mic-capture',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
    mic.worklet.port.onmessage=e=>receiveMicSamples(e.data,mic);
    micOutput.connect(mic.worklet);mic.worklet.connect(mic.silent);
   }catch(err){console.warn('AudioWorklet unavailable, using ScriptProcessor fallback:',err);}
  }
  if(!mic.worklet){
   if(!STATE.context.createScriptProcessor)throw new Error('Could not create the microphone audio processor');
   mic.processor=STATE.context.createScriptProcessor(2048,1,1);
   mic.processor.onaudioprocess=e=>{for(const ch of Array.from({length:e.outputBuffer.numberOfChannels},(_,i)=>e.outputBuffer.getChannelData(i)))ch.fill(0);receiveMicSamples(e.inputBuffer.getChannelData(0),mic);};
   micOutput.connect(mic.processor);mic.processor.connect(mic.silent);
  }
  resetDSP(0);STATE.playing=true;STATE.pausedAt=0;
  $('filename').textContent='Microphone · LIVE';$('duration').textContent='LIVE';$('now').textContent='00:00';$('seek').value=0;$('seek').disabled=true;
  $('play').disabled=false;$('play').textContent='■ Stop microphone';
  $('status').textContent=`Microphone on · ${mic.nativeRate} Hz → 16 kHz · not played back`;
 }catch(err){stopMicrophone();throw err;}
}
function sampleAt(index){
 if(index<0||index>=STATE.silenceFrom)return 0;
 if(STATE.inputMode==='microphone'){
  const m=STATE.mic;if(!m||index>=m.written||m.written-index>m.ring.length)return 0;
  return m.ring[index%m.ring.length];
 }
 if(STATE.loopDemo&&STATE.pcm?.length)return STATE.pcm[index%STATE.pcm.length]||0;
 return STATE.pcm?.[index]||0;
}
function processAudio(nowSample){const d=STATE.modules.dsp.exports,s=settings(),n=s.fft,inbuf=new Float32Array(d.memory.buffer,d.new_input_ptr(),d.max_fft_size());
for(let j=0;j<n;j++)inbuf[j]=sampleAt(nowSample-n+j);
d.new_process(n,hop/fs,s.attack,s.release,s.noise/1000,s.transient/10,s.gain/10,s.compression/100,s.agc,s['adaptive-floor']/100);STATE.newParam=d.new_param_value();STATE.newLoudness=d.new_loudness_value();STATE.newLine=d.new_line_value();
const stats=new Float32Array(d.memory.buffer,d.new_metrics_ptr(),10);
STATE.bpm=stats[6];STATE.beatConfidence=stats[7];STATE.beatPhase=stats[8];STATE.beatPulse=stats[9];
const levels=new Float32Array(d.memory.buffer,d.new_levels_ptr(),3);
for(let j=0;j<3;j++)STATE.levels[j]=levels[j];
const newer=new Float32Array(d.memory.buffer,d.new_bands_ptr(),16),p=new Float32Array(d.memory.buffer,d.new_pulses_ptr(),3),e=new Float32Array(d.memory.buffer,d.new_events_ptr(),3);
for(let j=0;j<16;j++)STATE.newSpectrum[j]=newer[j];for(let j=0;j<3;j++){STATE.pulses[j]=p[j];STATE.events[j]=e[j];}
}
function seekTo(pos){if(!STATE.buffer||STATE.inputMode!=='file')return;let wasPlaying=STATE.playing;pauseAudio();STATE.pausedAt=Math.min(STATE.buffer.duration-.01,Math.max(0,pos));const start=Math.floor(STATE.pausedAt*fs);resetDSP(start);if(wasPlaying)playAudio();}
