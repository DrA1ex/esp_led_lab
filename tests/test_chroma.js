'use strict';
// Chroma (src/dsp.cpp chroma_process): synthetic tones from A1 to B6 land in
// their pitch class at every analysis rate, a C-major chord in C, E and G, a
// tone with harmonics in its fundamental's class; white noise and silence
// stay dim; the chroma follows a change of note within half a second.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const w=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')))).exports;
const NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const STEP=.048; // the lab calls chroma_process every 48 ms
const midiHz=m=>440*Math.pow(2,(m-69)/12);
let seed=12345;
const noise=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296*2-1;};
// Runs `steps` analyses of the signal gen(t) (t in seconds) ending STEP apart; returns the chroma.
function run(rate,gen,{steps=20,reset=true,from=0}={}){
 if(reset){w.set_sample_rate(rate);w.reset_dsp();}
 const size=w.chroma_input_size(),buf=new Float32Array(w.memory.buffer,w.chroma_input_ptr(),size);
 for(let s=0;s<steps;s++){
  const end=(from+s+1)*STEP;
  for(let i=0;i<size;i++)buf[i]=gen(end+(i-size)/rate);
  w.chroma_process(STEP);
 }
 return Array.from(new Float32Array(w.memory.buffer,w.chroma_ptr(),12));
}
const sine=(f,a=.3)=>t=>a*Math.sin(2*Math.PI*f*t);
const sum=(...g)=>t=>g.reduce((v,f)=>v+f(t),0);
// A tone with 8 harmonics falling as 1/k (a soft sawtooth).
const rich=(f,a=.15)=>t=>{let v=0;for(let k=1;k<=8;k++)v+=Math.sin(2*Math.PI*f*k*t)/k;return a*v;};
const top=(c,n)=>c.map((v,i)=>[v,i]).sort((a,b)=>b[0]-a[0]).slice(0,n).map(x=>x[1]).sort((a,b)=>a-b);
const show=c=>c.map((v,i)=>`${NAMES[i]} ${v.toFixed(2)}`).join(', ');

for(const rate of [8000,11025,16000,22050,44100,48000]){
 w.set_sample_rate(rate);
 const info=new Float32Array(w.memory.buffer,w.chroma_info_ptr(),4);
 assert(info.length&&w.chroma_input_size()>=4096,`${rate}: at least 4096 samples`);
 // Single tones from A1 (55 Hz) to B6 (1976 Hz), every class, on and between bins.
 for(const midi of [33,36,41,46,50,54,57,59,62,67,69,71,76,80,85,90,95]){
  const c=run(rate,sine(midiHz(midi)),{steps:12}),pc=midi%12;
  assert(c[pc]>.9,`${rate} Hz rate, MIDI ${midi} (${NAMES[pc]}): ${show(c)}`);
  assert(c.every((v,i)=>i===pc||v<.1),`${rate} Hz rate, MIDI ${midi}: only ${NAMES[pc]}: ${show(c)}`);
 }
 const [lo,hi]=[run(rate,sine(midiHz(57)),{steps:12})[9],run(rate,sine(midiHz(57)*Math.pow(2,.45/12)),{steps:12})];
 assert(lo>.9&&hi[9]>hi[10],`${rate}: a tone 45 cents sharp of A still reads mostly A: ${show(hi)}`);
 // C major (C4 E4 G4): C, E and G, nothing else.
 const chord=run(rate,sum(sine(261.63,.2),sine(329.63,.2),sine(392,.2)));
 assert.deepEqual(top(chord,3),[0,4,7],`${rate}: C major ${show(chord)}`);
 assert([0,4,7].every(i=>chord[i]>.8)&&chord.every((v,i)=>[0,4,7].includes(i)||v<.1),`${rate}: C major ${show(chord)}`);
}
// Real timbres: harmonics add the fifth (3f) and the third (5f) above each note,
// but the chord's own notes stay on top: G2 alone, C major and A minor in 2nd / 3rd octave.
w.set_sample_rate(16000);
{
 const g=run(16000,rich(98));
 assert.equal(top(g,1)[0],7,`G2 with harmonics: ${show(g)}`);
 const cmaj=run(16000,sum(rich(130.81),rich(164.81),rich(196)));
 assert.deepEqual(top(cmaj,3),[0,4,7],`C major with harmonics: ${show(cmaj)}`);
 const amin=run(16000,sum(rich(220),rich(261.63),rich(329.63)));
 assert.deepEqual(top(amin,3),[0,4,9],`A minor with harmonics: ${show(amin)}`);
}
// Silence is 0; white noise stays dim; a tone 10 dB under the noise still stands out.
{
 assert(run(16000,()=>0).every(v=>v===0),'silence');
 const hiss=run(16000,()=>.3*noise(),{steps:30});
 assert(Math.max(...hiss)<.15,`white noise ${show(hiss)}`);
 const buried=run(16000,t=>.1*Math.sin(2*Math.PI*440*t)+.3*noise(),{steps:30});
 assert(top(buried,1)[0]===9&&buried[9]>3*Math.max(...buried.filter((_,i)=>i!==9)),`A4 under noise ${show(buried)}`);
}
// A change of note: A3 for a second, then E3. The chroma follows within 0.5 s
// (the window still holds a little of the A), all of it by 0.75 s; a fade to
// silence brings it down.
{
 const a=run(16000,sine(220),{steps:20});
 assert(a[9]>.9&&a[4]<.05);
 const e=run(16000,sine(164.81),{steps:10,reset:false,from:20}); // +0.48 s
 assert(e[4]>.9&&e[9]<.2,`A3 -> E3 after 0.48 s: ${show(e)}`);
 const later=run(16000,sine(164.81),{steps:5,reset:false,from:30}); // +0.72 s
 assert(later[4]>.9&&later[9]<.05,`A3 -> E3 after 0.72 s: ${show(later)}`);
 const quiet=run(16000,()=>0,{steps:15,reset:false,from:35});
 assert(Math.max(...quiet)<.05,`silence after the note: ${show(quiet)}`);
}
// The analysis window: ~0.5 s at about 8 kHz, ~2 Hz per bin at the default rate.
{
 w.set_sample_rate(16000);run(16000,sine(440),{steps:1});
 const [rate,n,d]=new Float32Array(w.memory.buffer,w.chroma_info_ptr(),4);
 assert.deepEqual([rate,n,d],[8000,4096,2]);
 assert.equal(w.chroma_input_size(),4096*2+48);
}
console.log('PASS chroma: tones A1..B6 at 8..48 kHz, C major and A minor (pure and with harmonics), noise, silence, note changes');
