'use strict';
// Audio sources (file, demo loop, microphone) and the DSP feed.
function bufferToPCM(audio,rate=fs){const targetLength=Math.floor(audio.duration*rate);const pcm=new Float32Array(targetLength);const ratio=audio.sampleRate/rate;const channels=[];for(let c=0;c<Math.min(audio.numberOfChannels,2);c++)channels.push(audio.getChannelData(c));for(let i=0;i<targetLength;i++){const t=i*ratio,index=Math.floor(t),fraction=t-index;let val=0;for(const chan of channels){const a=chan[Math.min(index,chan.length-1)]||0,b=chan[Math.min(index+1,chan.length-1)]||a;val+=a+(b-a)*fraction;}pcm[i]=val/channels.length;}return pcm;}
// Browser OfflineAudioContext uses anti-aliased sample-rate conversion. Plain linear
// interpolation (below) aliases high-frequency MP3/WAV energy into FFT bands.
async function resamplePCM(audio,rate=fs){
 try{
  const count=Math.max(1,Math.floor(audio.duration*rate));
  const offline=new OfflineAudioContext(1,count,rate);
  const src=offline.createBufferSource();src.buffer=audio;src.connect(offline.destination);src.start(0);
  const rendered=await offline.startRendering();
  return Float32Array.from(rendered.getChannelData(0));
 }catch(e){console.warn('OfflineAudioContext resampling unavailable, using linear fallback:',e);return bufferToPCM(audio,rate);}
}
async function changeAnalysisRate(requestedRate){
 const ticket=++STATE.analysisGeneration;
 $('sample-rate').setAttribute('aria-busy','true');
 try{
  for(;;){
   const buffer=STATE.buffer,mode=STATE.inputMode;
   const rate=Math.round(Math.max(8000,Math.min(sourceAnalysisLimit(),Number(requestedRate)||16000)));
   if(rate===fs&&!(mode==='file'&&buffer&&STATE.pcmRate!==rate))return;
   const pcm=buffer&&mode==='file'?await resamplePCM(buffer,rate):null;
   if(ticket!==STATE.analysisGeneration)return;
   if(buffer!==STATE.buffer||mode!==STATE.inputMode)continue;
   let position=STATE.playing&&mode==='file'?Math.max(0,STATE.context.currentTime-STATE.playStart):STATE.pausedAt;
   if(STATE.loopDemo&&!remoteEnabled()&&buffer)position%=buffer.duration;
   applyAnalysisRate(rate);
   if(pcm){STATE.pcm=pcm;STATE.pcmRate=rate;}
   if(mode==='microphone'&&STATE.mic){
    const mic=STATE.mic;
    mic.ring=new Float32Array(fs*12);mic.written=mic.nativeCount=mic.nextOutput=0;mic.previous=0;
    for(const lp of [mic.lowpass1,mic.lowpass2])lp.frequency.setValueAtTime(Math.min(fs*.4375,mic.nativeRate*.45),STATE.context.currentTime);
    position=0;$('status').textContent=`Live · ${formatSampleRate(mic.sourceRate)} → ${formatSampleRate(fs)}`;
   }
   refreshLabels();
   if(STATE.ready)resetDSP(Math.max(0,Math.floor(position*fs)));
   return;
  }
 }catch(err){
  if(ticket===STATE.analysisGeneration){$('sample-rate').value=fs;$('status').textContent='Analysis rate error: '+err.message;}
 }finally{if(ticket===STATE.analysisGeneration){$('sample-rate').removeAttribute('aria-busy');refreshAnalysisUi();}}
}
function demoAudio(){const rate=fs,len=16,ns=rate*len,data=new Float32Array(ns);let rand=39929;const noise=()=>{rand^=rand<<13;rand^=rand>>>17;rand^=rand<<5;return ((rand>>>0)/4294967295)*2-1;};const notes=[220,261.63,329.63,392,329.63,293.66,261.63,196];
for(let i=0;i<ns;i++){let t=i/rate,bar=t%2,beat=t%0.5,eighth=t%0.25;let value=0;
let kick=Math.exp(-beat*24)*Math.sin(2*Math.PI*(59*beat+28*beat*Math.exp(-beat*22)));value+=.47*kick;
if(Math.floor(t/.5)%4===1||Math.floor(t/.5)%4===3){let b=beat;value+=.22*Math.exp(-b*27)*noise();}
value+=.14*Math.exp(-eighth*82)*noise();
let note=notes[Math.floor(t/.5)%notes.length];value+=.12*Math.sin(2*Math.PI*note*t)*Math.exp(-beat*2.7);value+=.06*Math.sin(2*Math.PI*(note*.5)*t)*Math.exp(-beat*1.4);data[i]=Math.max(-.85,Math.min(.85,value));}
const b=STATE.context.createBuffer(1,ns,rate);b.getChannelData(0).set(data);return {buffer:b,pcm:data};}
function resetDSP(startSample=0,preserveRemote=false){
 const n=+($('fft')?.value||512);
 if(!preserveRemote){
  remoteInvalidate();
  if(STATE.loopDemo&&STATE.pcm?.length){
   RS.loopEpoch=Math.floor(Math.max(0,startSample-n)/STATE.pcm.length);
   RS.lastRenderedEpoch=Math.floor(startSample/STATE.pcm.length);
  }
 }
 STATE.displaySpectrum=[];
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
// The header play button is an icon; its label and tooltip carry the words.
function playLabel(icon,label){const b=$('play');b.innerHTML='<svg class="ico" aria-hidden="true" focusable="false"><use href="#i-'+icon+'"/></svg>';b.title=label;b.setAttribute('aria-label',label);}
function loadBuffer(buffer,pcm,name,isDemo=false,sourceRate=buffer.sampleRate,rate=fs){
 const previous={range:frequencyRange(),full:+$('freq-max').value===1000};
 pauseAudio();STATE.inputMode='file';STATE.loopDemo=isDemo;
 STATE.buffer=buffer;STATE.pcm=pcm;STATE.fileSampleRate=sourceRate;STATE.pcmRate=rate;STATE.audioLen=buffer.duration;STATE.fileName=name;STATE.pausedAt=0;
 applyAnalysisRate(rate,previous);refreshLabels();resetDSP();
 if(+$('audio-mode').value===0){$('audio-mode').value=3;refreshLabels();}
 $('filename').textContent=name;$('duration').textContent=asTime(buffer.duration);$('now').textContent='00:00';$('seek').value=0;$('seek').disabled=false;
 $('play').disabled=false;playLabel('play','Play (Space)');$('status').textContent='Ready to play';
}
// Decode → 20-minute limit → loadBuffer → play. `current()` says whether this
// load is still wanted (a newer track or source may have been picked meanwhile).
async function loadFile(file,name=file.name,current=()=>true){
 await ensureAudio();$('status').textContent='Decoding…';
 const data=await file.arrayBuffer();
 const sourceRate=await AudioMetadata.sampleRate(file);
 // Decode independently of the playback hardware, preserving all frequencies
 // the analyzer can use. Web Audio otherwise silently resamples to the device.
 let decoder=STATE.context;
 try{decoder=new OfflineAudioContext(1,1,Math.max(8000,Math.min(48000,sourceRate||STATE.context.sampleRate)));}catch(_){}
 const buf=await decoder.decodeAudioData(data);
 if(!current())return false;
 if(buf.duration>1200)throw new Error('Files longer than 20 minutes are not supported yet');
 let pcm,rate,before;
 do{before=fs;rate=Math.max(8000,Math.min(fs,sourceRate||buf.sampleRate,buf.sampleRate));pcm=await resamplePCM(buf,rate);if(!current())return false;}while(before!==fs);
 loadBuffer(buf,pcm,name,false,sourceRate,rate);await playAudio();return true;
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
  playLabel('play','Play again (Space)');$('now').textContent='00:00';$('seek').value=0;
  $('status').textContent='Finished';
  if(typeof onTrackEnded==='function')onTrackEnded(); // playlist: next track or repeat
 };
 source.start(0,offset);playLabel('pause','Pause (Space)');$('status').textContent='Playing';
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
 playLabel('mic','Start microphone (Space)');
}
function pauseAudio(){
 remoteInvalidate();
 if(STATE.inputMode==='microphone'){stopMicrophone();return;}
 if(STATE.playing){
  STATE.pausedAt=Math.min(STATE.buffer?.duration||0,Math.max(0,STATE.context.currentTime-STATE.playStart));
  const src=STATE.source;STATE.source=null;STATE.playing=false;try{src?.stop();}catch(_){}
  startSilenceTail();
 }
 playLabel('play','Play (Space)');
}
function receiveMicSamples(samples,mic){
 if(STATE.mic!==mic||STATE.inputMode!=='microphone')return;
 // Continuous resampling to the selected analysis rate, no per-chunk phase discontinuities.
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
 const sourceRate=stream.getAudioTracks()[0]?.getSettings()?.sampleRate||STATE.context.sampleRate;
 if(fs>sourceRate)applyAnalysisRate(Math.max(8000,sourceRate));
 const mic={stream,sourceRate,nativeRate:STATE.context.sampleRate,ring:new Float32Array(fs*12),written:0,nativeCount:0,nextOutput:0,previous:0,input:null,worklet:null,processor:null,silent:null};
 STATE.mic=mic;
 try{
  mic.input=STATE.context.createMediaStreamSource(stream);
  // Anti-alias filters track the selected analysis rate, including live changes.
  let micOutput=mic.input;
  {
   mic.lowpass1=STATE.context.createBiquadFilter();mic.lowpass2=STATE.context.createBiquadFilter();
   for(const lp of [mic.lowpass1,mic.lowpass2]){lp.type='lowpass';lp.frequency.value=Math.min(fs*.4375,mic.nativeRate*.45);lp.Q.value=0.707;}
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
  refreshLabels();resetDSP(0);STATE.playing=true;STATE.pausedAt=0;
  $('filename').textContent='Microphone · LIVE';$('duration').textContent='LIVE';$('now').textContent='00:00';$('seek').value=0;$('seek').disabled=true;
  $('play').disabled=false;playLabel('stop','Stop microphone (Space)');
  $('status').textContent=`Live · ${formatSampleRate(mic.sourceRate)} → ${formatSampleRate(fs)}`;
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
readDisplaySpectrum(d,s);
const stats=new Float32Array(d.memory.buffer,d.new_metrics_ptr(),10);
STATE.bpm=stats[6];STATE.beatConfidence=stats[7];STATE.beatPhase=stats[8];STATE.beatPulse=stats[9];
const levels=new Float32Array(d.memory.buffer,d.new_levels_ptr(),3);
for(let j=0;j<3;j++)STATE.levels[j]=levels[j];
const newer=new Float32Array(d.memory.buffer,d.new_bands_ptr(),16),p=new Float32Array(d.memory.buffer,d.new_pulses_ptr(),3),e=new Float32Array(d.memory.buffer,d.new_events_ptr(),3);
for(let j=0;j<16;j++)STATE.newSpectrum[j]=newer[j];for(let j=0;j<3;j++){STATE.pulses[j]=p[j];STATE.events[j]=e[j];}
}
function seekTo(pos){if(!STATE.buffer||STATE.inputMode!=='file')return;let wasPlaying=STATE.playing;pauseAudio();STATE.pausedAt=Math.min(STATE.buffer.duration-.01,Math.max(0,pos));const start=Math.floor(STATE.pausedAt*fs);resetDSP(start);$('now').textContent=asTime(STATE.pausedAt);$('seek').value=Math.floor(STATE.pausedAt/STATE.buffer.duration*1000);if(wasPlaying)playAudio();}
