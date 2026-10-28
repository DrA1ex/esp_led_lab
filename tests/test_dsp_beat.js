'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const wasm=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')));
const d=new WebAssembly.Instance(wasm).exports;
const n=512,hop=256,rate=16000,dt=hop/rate;
const pcm=new Float32Array(d.memory.buffer,d.new_input_ptr(),1024);
const metrics=new Float32Array(d.memory.buffer,d.new_metrics_ptr(),10);
const bands=new Float32Array(d.memory.buffer,d.new_bands_ptr(),16);
function tick(signal,step){const pos=n+step*hop;for(let i=0;i<n;i++)pcm[i]=signal(pos-n+i);d.new_process(n,dt,25,210,.008,1,1.6,.82,900,0.25);assert(bands.every(x=>x>=0&&x<=1&&Number.isFinite(x)));}
d.reset_dsp();for(let j=0;j<300;j++)tick(()=>0,j);
assert(metrics[6]===0 && metrics[7]===0,`silence incorrectly yielded BPM ${metrics[6]}`);
d.reset_dsp();function kick(i){const t=i/rate,b=t%0.5;return .55*Math.sin(2*Math.PI*(55*b+28*b*Math.exp(-b*20)))*Math.exp(-b*17)+.09*Math.sin(2*Math.PI*220*t);}
for(let j=0;j<550;j++)tick(kick,j);
assert(metrics[6]>115&&metrics[6]<125,`120-BPM beat gave ${metrics[6]} BPM`);
assert(metrics[7]>.2,`beat confidence too low ${metrics[7]}`);
assert(metrics[8]>=0&&metrics[8]<1,`invalid beat phase ${metrics[8]}`);
console.log('PASS: stable FFT with adaptive noise, silence no false BPM, synthetic 120 BPM detected near',metrics[6].toFixed(2));
