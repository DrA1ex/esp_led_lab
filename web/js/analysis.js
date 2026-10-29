'use strict';
// Source rates describe the original file / capture track, before Web Audio
// resamples into the device context. FFT size and playback rate are independent.
const formatSampleRate=rate=>`${+(rate/1000).toFixed(3)} kHz`;
function sourceSampleRate(){
 if(STATE.inputMode==='microphone')return STATE.mic?.sourceRate||null;
 return STATE.buffer?STATE.fileSampleRate:null;
}
function analysisNyquist(){return Math.min(fs,sourceSampleRate()||fs)/2;}
function sourceAnalysisLimit(){
 const delivered=STATE.inputMode==='microphone'?(STATE.mic?.nativeRate||STATE.context?.sampleRate):STATE.buffer?.sampleRate;
 return Math.max(8000,Math.min(48000,sourceSampleRate()||48000,delivered||48000));
}
function applyAnalysisRate(rate,previous={range:frequencyRange(),full:+$('freq-max').value===1000}){
 const {range,full}=previous;
 fs=rate;$('sample-rate').value=rate;
 const hi=full?analysisNyquist():Math.min(analysisNyquist(),range.hi),lo=Math.min(range.lo,hi/1.5);
 $('freq-min').value=hzSlider(lo);$('freq-max').value=hzSlider(hi);
 // Retain Hz values across rate changes instead of accumulating slider rounding.
 STATE.frequencyWindow={key:frequencyWindowKey(settings()),lo:Math.round(lo),hi:Math.round(hi)};
 updateAnalysisHop();
}
function refreshAnalysisUi(){
 const select=$('sample-rate'),source=sourceSampleRate(),limit=sourceAnalysisLimit();
 for(const o of [...select.options])if(o.dataset.source&&+o.value!==limit)o.remove();
 if(![...select.options].some(o=>+o.value===limit)){
  const o=document.createElement('option');o.value=limit;o.textContent=formatSampleRate(limit)+' · source';o.dataset.source='true';select.add(o);
 }
 for(const o of select.options)o.disabled=+o.value>limit;
 if(!select.hasAttribute('aria-busy'))select.value=fs;
 const origin=STATE.inputMode==='microphone'?'Microphone':'File';
 const text=source?`${origin}: ${formatSampleRate(source)}. `:STATE.buffer?'Original file rate unavailable; using the decoded audio rate as the limit. ':'';
 $('sample-rate-hint').textContent=text+`Analysis: ${formatSampleRate(fs)}, up to ${formatHz(analysisNyquist())}. `+(source&&source<8000?'8 kHz is the minimum analysis rate; upsampling adds no detail. ':'Rates above the source add no detail and are disabled. ')+`Playback is unchanged.`;
}

// Display real FFT bins, combining high-frequency neighbors where the display
// is too narrow. Quantized edges merge unresolved low-frequency bands instead
// of drawing many independent-looking bars from the very same FFT bin.
const SPECTRUM={key:'',groups:[]};
function spectrumPlan(){
 const n=+$('fft').value,{lo,hi}=frequencyRange(),width=$('new-mini-bars').clientWidth||300;
 const count=Math.max(8,Math.min(64,Math.floor(width/5))),step=fs/n;
 const key=[n,fs,lo,hi,count].join(':');
 if(key===SPECTRUM.key)return SPECTRUM;
 const first=Math.max(1,Math.min(n/2-1,Math.round(lo/step))),last=Math.max(first+1,Math.min(n/2,Math.round(hi/step)));
 const edges=[first];
 for(let i=1;i<count;i++){
  const k=Math.max(first,Math.min(last,Math.round(lo*Math.pow(hi/lo,i/count)/step)));
  if(k>edges[edges.length-1])edges.push(k);
 }
 if(edges[edges.length-1]!==last)edges.push(last);
 SPECTRUM.groups=edges.slice(0,-1).map((from,i)=>{
  const to=edges[i+1],low=i?from*step:lo,high=i===edges.length-2?hi:to*step;
  return {from,to,low,high,weight:Math.max(.01,Math.log(high/low)),step};
 });
 SPECTRUM.key=key;STATE.displaySpectrum=[];
 return SPECTRUM;
}
function readDisplaySpectrum(d,s){
 const plan=spectrumPlan(),raw=new Float32Array(d.memory.buffer,d.new_spectrum_ptr(),s.fft/2);
 const ref=Math.max(.003,new Float32Array(d.memory.buffer,d.new_metrics_ptr(),10)[5]);
 const scale=s.fft/512*16000/fs,compression=s.compression/100;
 STATE.displaySpectrum=plan.groups.map(({from,to})=>{
  let sum=0;for(let k=from;k<to;k++)sum+=raw[k]*raw[k];
  const level=Math.max(0,Math.sqrt(sum/(to-from)*scale)-s.noise/1000)*(s.gain/10)/(ref*6.5);
  const value=(1-compression)*level+compression*Math.sqrt(level);
  return value/(.85+value);
 });
}
function renderSpectrum(){
 const plan=spectrumPlan(),wrap=$('new-mini-bars');
 if(wrap.dataset.spectrum!==plan.key){
  wrap.innerHTML=plan.groups.map(g=>`<div class="bar" style="height:2%;flex-grow:${g.weight}" title="${formatHz(Math.round(g.low))}–${formatHz(Math.round(g.high))} · ${g.to-g.from} FFT bin${g.to-g.from===1?'':'s'}"></div>`).join('');
  wrap.dataset.spectrum=plan.key;
  $('spectrum-detail').textContent=`${plan.groups.length} groups · ${(fs/+$('fft').value).toFixed(1)} Hz/bin`;
 }
 for(let j=0;j<plan.groups.length;j++)wrap.children[j].style.height=`${Math.max(2,Math.min(100,(STATE.displaySpectrum[j]||0)*100))}%`;
}
