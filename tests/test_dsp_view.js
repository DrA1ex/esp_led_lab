// The DSP view's intermediate signals: targets are the band levels before the
// envelope and follow the curve dsp-view.js draws (levelOut); a hit fires only
// above the exported onset threshold.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const d=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')))).exports;
const source=fs.readFileSync(path.join(__dirname,'../web/js/dsp-view.js'),'utf8');
const levelOut=new Function(source.match(/function levelOut[\s\S]*?\n}\n/)[0]+'return levelOut;')();

const [gate,gain,compression]=[.008,1.6,.82];
d.reset_dsp();
const input=new Float32Array(d.memory.buffer,d.new_input_ptr(),d.max_fft_size());
const read=(ptr,n)=>Array.from(new Float32Array(d.memory.buffer,ptr,n));
let hits=0,checked=0;
// A 120 BPM kick with a hi-hat in between, over a quiet 440 Hz tone.
for(let frame=0;frame<400;frame++){
 for(let i=0;i<512;i++){
  const t=(frame*256-512+i)/16000,beat=t%.5,hat=(t+.25)%.5;
  input[i]=.05*Math.sin(2*Math.PI*440*t)+(beat<.08?.6*Math.exp(-beat*40)*Math.sin(2*Math.PI*60*t):0)+(hat<.02?.2*Math.sin(2*Math.PI*5000*t)*Math.exp(-hat*200):0);
 }
 d.new_process(512,256/16000,25,210,gate,1,gain,compression,900,0);
 const raw=read(d.new_raw_ptr(),16),targets=read(d.new_targets_ptr(),16),metrics=read(d.new_metrics_ptr(),10);
 const ref=Math.max(.003,metrics[5]);
 for(let b=0;b<16;b++){assert(Math.abs(targets[b]-levelOut(raw[b],gate,gain,compression,ref))<1e-5,`target ${b} frame ${frame}`);checked++;}
 const thresholds=read(d.new_thresholds_ptr(),3),events=read(d.new_events_ptr(),3);
 for(let g=0;g<3;g++)if(events[g]){hits++;assert(metrics[g]>thresholds[g],`hit above threshold, group ${g}`);}
 assert(thresholds.every(v=>v>=.07),'threshold has its 0.07 base');
}
assert(hits>=10,`kicks fire hits (${hits})`);
// Floors are learned per band and stay finite.
assert(read(d.new_floor_ptr(),16).every(v=>Number.isFinite(v)&&v>=0),'finite floors');
d.reset_dsp();
assert(read(d.new_targets_ptr(),16).every(v=>v===0)&&read(d.new_thresholds_ptr(),3).every(v=>v===0),'reset clears the view signals');
console.log(`PASS DSP view: ${checked} targets follow the drawn level curve, ${hits} hits above the exported threshold`);
