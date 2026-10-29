'use strict';
// Shared page state and settings access. Loaded first; other scripts are
// classic (non-module) scripts sharing this global scope, so the standalone
// build can inline them in order.
const $=id=>document.getElementById(id);
const STATE={ready:false,buffer:null,pcm:null,context:null,source:null,playbackGain:null,playStart:0,pausedAt:0,playing:false,lastFrame:0,lastStats:0,frames:0,nextSample:512,newSpectrum:Array(16).fill(0),pulses:[0,0,0],events:[0,0,0],newParam:0,newLoudness:0,newLine:0,levels:[0,0,0],bpm:0,beatConfidence:0,beatPhase:0,beatPulse:0,audioLen:0,loopDemo:false,lastPlaybackSample:0,inputMode:"file",mic:null,micGeneration:0,micWorkletReady:false,fileName:"",output:{new:0},modules:{},canvases:{}};
const fs=16000,hop=256;
const inputIds=['color','palette','brightness','audio-mode','speed','scale','light','audio-min','audio-max','mix','geometry','geom-w','geom-h','led-dots','invert-y','xy-test','gamma','master-brightness','simulate-led','fft','attack','release','noise','adaptive-floor','gain','transient','agc','compression','freq-min','freq-max','param-source','spectrum-shape','spectrum-onset','line-response',
 'input-min','input-max','input-curve','input-gate','origin-shift','origin-y','origin-reverse','origin-ring','origin-radial','viz-color','viz-auto','viz-mirror','viz-decay','viz-speed'];
// Numeric controls become numbers; string-valued selects (geometry, param-source) stay strings.
const settingValue=el=>el.type==='checkbox'?el.checked:(el.value!==''&&Number.isFinite(+el.value)?+el.value:el.value);
const settings=()=>Object.fromEntries(inputIds.map(i=>[i,settingValue($(i))]));
const asTime=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
// Frequency sliders are logarithmic: 0..1000 -> 20 Hz .. 8 kHz.
const FREQ_LO=20,FREQ_HI=8000;
const sliderHz=v=>FREQ_LO*Math.pow(FREQ_HI/FREQ_LO,v/1000);
const hzSlider=hz=>Math.round(Math.log(hz/FREQ_LO)/Math.log(FREQ_HI/FREQ_LO)*1000);
const roundHz=hz=>hz>=1000?Math.round(hz/100)*100:hz>=200?Math.round(hz/10)*10:Math.round(hz);
const formatHz=hz=>hz>=1000?`${+(hz/1000).toFixed(1)} kHz`:`${hz} Hz`;
// Analysed frequency range in Hz, at least half an octave wide (dsp.cpp clamps the same way).
function frequencyRange(s=settings()){
 const lo=roundHz(sliderHz(s['freq-min'])),hi=roundHz(sliderHz(s['freq-max']));
 return {lo,hi:Math.max(hi,Math.min(FREQ_HI,Math.ceil(lo*1.5)))};
}

