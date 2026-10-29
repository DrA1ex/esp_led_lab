'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')));
const center=(i,rate,count)=>40*Math.pow((rate/2)/40,(i+.5)/count);
for(const rate of [8000,16000,22050,32000,44100,48000])for(const n of [64,128,512,2048,8192]){
 const d=new WebAssembly.Instance(mod).exports;d.set_sample_rate(rate);d.set_frequency_range(40,rate/2);d.reset_dsp();
 const input=new Float32Array(d.memory.buffer,d.new_input_ptr(),d.max_fft_size());
 const hop=Math.min(Math.round(rate*.016),n/2),tone=1500;
 for(let frame=0;frame<Math.ceil(rate*.8/hop);frame++){
  for(let i=0;i<n;i++)input[i]=.5*Math.sin(2*Math.PI*tone*(frame*hop-n+i)/rate);
  d.new_process(n,hop/rate,25,210,.008,1,1.6,.82,900,0);
 }
 for(const [count,ptr] of [[16,d.new_bands_ptr()],[32,d.new_remote32_ptr()],[64,d.new_remote64_ptr()]]){
  const bands=Array.from(new Float32Array(d.memory.buffer,ptr,count));
  assert(bands.every(v=>Number.isFinite(v)&&v>=0&&v<=1),`${rate}/${n}: finite ${count} bands`);
  const peak=Math.max(...bands),i=bands.indexOf(peak),hz=center(i,rate,count);
  assert(peak>.05,`${rate}/${n}: FFT did not process`);
  assert(Math.abs(hz-tone)<Math.max(rate/n*1.5,tone*.4),`${rate}/${n}: tone ${tone}, peak ${hz}`);
 }
 // Silence must not invent beats even at the shortest analysis hops.
 d.reset_dsp();input.fill(0);
 for(let i=0;i<Math.ceil(rate*3.5/hop);i++)d.new_process(n,hop/rate,25,210,.008,1,1.6,.82,900,0);
 const metrics=new Float32Array(d.memory.buffer,d.new_metrics_ptr(),10);
 assert.equal(metrics[6],0,`${rate}/${n}: false tempo on silence`);
 assert(metrics.every(Number.isFinite));
}
// The 16 ms tempo history must survive a shorter FFT hop at different rates.
for(const [rate,n] of [[8000,128],[48000,512]]){
 const d=new WebAssembly.Instance(mod).exports;d.set_sample_rate(rate);d.set_frequency_range(40,rate/2);d.reset_dsp();
 const input=new Float32Array(d.memory.buffer,d.new_input_ptr(),d.max_fft_size()),hop=Math.min(Math.round(rate*.016),n/2);
 for(let j=0;j<Math.ceil(rate*9/hop);j++){
  for(let i=0;i<n;i++){const t=(j*hop-n+i)/rate,b=((t%.5)+.5)%.5;input[i]=.55*Math.sin(2*Math.PI*(55*b+28*b*Math.exp(-b*20)))*Math.exp(-b*17)+.09*Math.sin(2*Math.PI*220*t);}
  d.new_process(n,hop/rate,25,210,.008,1,1.6,.82,900,0);
 }
 const metrics=new Float32Array(d.memory.buffer,d.new_metrics_ptr(),10);
 assert(metrics[6]>115&&metrics[6]<125,`${rate}/${n}: 120 BPM became ${metrics[6]}`);
}
console.log('PASS analysis rates 8/16/22.05/32/44.1/48 kHz: FFT 64..8192, correct tone bins, finite spectra, silence and 120 BPM');
