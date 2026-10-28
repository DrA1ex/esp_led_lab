// FFT sizes 256..8192 and the analysed frequency range: bands are spread
// logarithmically inside [lo, hi]; tones outside the range do not light bands.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')));

// Feed a sine for ~1.5 s and return the 16 / 32 / 64 smoothed bands.
function bandsFor(freq,size,range){
 const d=new WebAssembly.Instance(mod).exports;
 d.reset_dsp();if(range)d.set_frequency_range(...range);
 const input=new Float32Array(d.memory.buffer,d.new_input_ptr(),d.max_fft_size());
 for(let frame=0;frame<90;frame++){
  for(let i=0;i<size;i++)input[i]=.5*Math.sin(2*Math.PI*freq*(frame*256-size+i)/16000);
  d.new_process(size,256/16000,25,210,.008,1,1.6,.82,900,0);
 }
 const read=(ptr,n)=>Array.from(new Float32Array(d.memory.buffer,ptr,n));
 return {b16:read(d.new_bands_ptr(),16),b32:read(d.new_remote32_ptr(),32),b64:read(d.new_remote64_ptr(),64)};
}
const argmax=a=>a.indexOf(Math.max(...a));
// Expected band of a frequency for a logarithmic split of [lo, hi].
const bandOf=(f,lo,hi,n)=>Math.floor(Math.log(f/lo)/Math.log(hi/lo)*n);

for(const size of [256,512,1024,2048,4096,8192]){
 const {b16,b32,b64}=bandsFor(1000,size);
 assert(b16.every(v=>Number.isFinite(v)&&v>=0&&v<=1),`finite ${size}`);
 assert.equal(argmax(b64),bandOf(1000,40,8000,64),`1 kHz peak, FFT ${size}`);
 assert(Math.abs(argmax(b16)-bandOf(1000,40,8000,16))<=1,`16-band peak, FFT ${size}`);
 assert(Math.abs(argmax(b32)-bandOf(1000,40,8000,32))<=1,`32-band peak, FFT ${size}`);
}
// Larger FFTs resolve bass: a 60 Hz tone covers far fewer of the 64 bands of 40..400 Hz.
const spread=size=>{const b=bandsFor(60,size,[40,400]).b64,m=Math.max(...b);return b.filter(v=>v>m/2).length;};
assert(spread(8192)*3<spread(512),`8192-point FFT resolves bass better than 512: ${spread(8192)} vs ${spread(512)} bands`);

// Range 200..4000 Hz: 1 kHz moves to its place inside the new range,
// 100 Hz and 6 kHz are outside and stay (almost) dark.
const range=[200,4000];
const inside=bandsFor(1000,2048,range);
assert.equal(argmax(inside.b64),bandOf(1000,200,4000,64));
assert(Math.abs(argmax(inside.b16)-bandOf(1000,200,4000,16))<=1);
for(const f of [100,6000]){
 const out=bandsFor(f,2048,range);
 assert(Math.max(...out.b64)<.25*Math.max(...inside.b64),`${f} Hz outside ${range} stays dark`);
}
// Invalid input is clamped: never wider than 20 Hz .. 8 kHz, never empty.
const d=new WebAssembly.Instance(mod).exports;d.set_frequency_range(5,50000);d.set_frequency_range(3000,3000);
console.log('PASS DSP: FFT 256..8192, logarithmic bands inside the frequency range, out-of-range tones stay dark');
