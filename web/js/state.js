'use strict';
// Shared page state and settings access. Loaded first; other scripts are
// classic (non-module) scripts sharing this global scope, so the standalone
// build can inline them in order.
const $=id=>document.getElementById(id);
const STATE={ready:false,buffer:null,pcm:null,context:null,source:null,playbackGain:null,playStart:0,pausedAt:0,playing:false,lastFrame:0,lastStats:0,lastUi:0,analysisGeneration:0,fileSampleRate:null,frequencyWindow:null,pcmRate:16000,displaySpectrum:[],frames:0,nextSample:512,silenceFrom:Infinity,tailPos:0,tailUntil:-1,seeking:false,newSpectrum:Array(16).fill(0),pulses:[0,0,0],events:[0,0,0],newParam:0,newLoudness:0,newLine:0,levels:[0,0,0],bpm:0,beatConfidence:0,beatPhase:0,beatPulse:0,audioLen:0,loopDemo:false,lastPlaybackSample:0,inputMode:"file",mic:null,micGeneration:0,micWorkletReady:false,fileName:"",output:{new:0},modules:{},canvases:{}};
let fs=16000,hop=256;
// At least 50% overlap for short FFTs; keep the default 16 ms DSP cadence.
function updateAnalysisHop(){hop=Math.min(Math.round(fs*.016),+$('fft').value/2);}
const inputIds=['color','palette','brightness','audio-mode','speed','scale','light','audio-min','audio-max','mix','geometry','geom-w','geom-h','led-dots','invert-y','xy-test','gamma','master-brightness','simulate-led','fft','sample-rate','attack','release','noise','adaptive-floor','gain','transient','agc','compression','freq-min','freq-max',
 'window','tilt','eq-bass','eq-mid','eq-high','balance','smoothing','split-mid','split-high','peak-hold','onset-memory','onset-trim-0','onset-trim-1','onset-trim-2','holdoff-0','holdoff-1','holdoff-2','flash-0','flash-1','flash-2','bpm-min','bpm-max','param-source','spectrum-shape','spectrum-onset','line-response',
 'input-min','input-max','input-curve','input-gate','origin-shift','origin-y','origin-reverse','origin-ring','origin-radial','viz-color','viz-auto','viz-mirror','viz-decay','viz-speed'];
// Numeric controls become numbers; string-valued selects (geometry, param-source) stay strings.
const settingValue=el=>el.type==='checkbox'?el.checked:(el.value!==''&&Number.isFinite(+el.value)?+el.value:el.value);
const settings=()=>Object.fromEntries(inputIds.map(i=>[i,settingValue($(i))]));
const asTime=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
// Logarithmic frequency sliders follow the analysis Nyquist limit.
const FREQ_LO=20;
const sliderHz=v=>FREQ_LO*Math.pow(analysisNyquist()/FREQ_LO,Math.max(0,Math.min(1000,v))/1000);
const hzSlider=hz=>Math.max(0,Math.min(1000,Math.round(Math.log(Math.max(FREQ_LO,hz)/FREQ_LO)/Math.log(analysisNyquist()/FREQ_LO)*1000)));
const roundHz=hz=>hz>=1000?Math.round(hz/100)*100:hz>=200?Math.round(hz/10)*10:Math.round(hz);
const formatHz=hz=>hz>=1000?`${+(hz/1000).toFixed(1)} kHz`:`${hz} Hz`;
const frequencyWindowKey=s=>[fs,analysisNyquist(),s['freq-min'],s['freq-max']].join(':');
// The first band of the mid and of the high group, clamped as the DSP does.
function groupSplits(s=settings()){
 const mid=Math.max(1,Math.min(14,s['split-mid']));
 return {mid,high:Math.max(mid+1,Math.min(15,s['split-high']))};
}
function frequencyRange(s=settings()){
 const key=frequencyWindowKey(s),cached=STATE.frequencyWindow;
 if(cached?.key===key)return {lo:cached.lo,hi:cached.hi};
 const nyquist=analysisNyquist();
 let lo=roundHz(sliderHz(s['freq-min'])),hi=+s['freq-max']===1000?nyquist:roundHz(sliderHz(s['freq-max']));
 hi=Math.min(nyquist,Math.max(hi,lo*1.5));lo=Math.min(lo,hi/1.5);
 const range={lo:Math.round(lo),hi:Math.round(hi)};
 STATE.frequencyWindow={key,...range};return range;
}
