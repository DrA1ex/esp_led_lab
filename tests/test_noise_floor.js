'use strict';
// Adaptive floor timing (set_noise_floor_timing) and strength, and the dB
// noise floor slider of the page (noiseGate in web/js/state.js).
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')));
const rate=16000,n=512,hop=256;
let seed=1;
const rand=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return ((seed>>>0)/4294967295)*2-1;};
// Learned background after `seconds` of quiet noise, then of 8x louder noise.
function learn(rise,fall,adaptive=1){
 const d=new WebAssembly.Instance(mod).exports;d.set_sample_rate(rate);d.set_frequency_range(40,rate/2);d.reset_dsp();
 d.set_noise_floor_timing(rise,fall);
 const input=new Float32Array(d.memory.buffer,d.new_input_ptr(),d.max_fft_size()),floor=()=>Array.from(new Float32Array(d.memory.buffer,d.new_floor_ptr(),16));
 const run=(amp,seconds)=>{for(let f=0;f<Math.ceil(seconds*rate/hop);f++){for(let i=0;i<n;i++)input[i]=amp*rand();d.new_process(n,hop/rate,25,210,0,1,1.6,.82,900,adaptive);}};
 run(.02,6);const quiet=floor();
 run(.16,2);const loud=floor(),bands=Array.from(new Float32Array(d.memory.buffer,d.new_bands_ptr(),16));
 run(.02,.3);const back=floor();
 const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
 return {quiet:mean(quiet),loud:mean(loud),back:mean(back),bands:mean(bands)};
}
const slow=learn(30,.1),fast=learn(1,.1);
// A short learn time follows a louder background within 2 s; a long one moves far less.
assert(fast.loud>fast.quiet*4,`fast rise ${fast.quiet} -> ${fast.loud}`);
assert(fast.loud>slow.loud*3,`learn time 1 s ${fast.loud} vs 30 s ${slow.loud}`);
// Dropping is set separately: 0.1 s returns within 0.3 s, 3 s does not.
const stay=learn(1,3);
assert(fast.back<fast.loud*.3,`fast drop ${fast.loud} -> ${fast.back}`);
assert(stay.back>stay.loud*.7,`slow drop ${stay.loud} -> ${stay.back}`);
// Strength above 100% cuts more of a steady background than 100%.
assert(learn(1,.1,2).bands<fast.bands,'200% leaves less than 100%');

// The page: 1 dB a step, the lowest position off.
const ctx={document:{getElementById:()=>null}};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/state.js'),'utf8')+';this.noiseGate=noiseGate;this.NOISE_OFF_DB=NOISE_OFF_DB;',ctx);
assert.equal(ctx.noiseGate({'noise-db':ctx.NOISE_OFF_DB}),0);
assert(Math.abs(ctx.noiseGate({'noise-db':-42})-.00794)<1e-4);
assert(Math.abs(ctx.noiseGate({'noise-db':-61})/ctx.noiseGate({'noise-db':-60})-Math.pow(10,-1/20))<1e-9);
console.log('PASS adaptive floor learn / drop times and strength, dB noise floor');
