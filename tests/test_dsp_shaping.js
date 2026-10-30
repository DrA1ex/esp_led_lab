// Analyzer settings beyond new_process()'s arguments: spectral tilt, band
// balance, band groups, per-group onsets, tempo range, expansion, the FFT
// window, group trims, band smoothing, peak hold, onset memory, and the beat
// pulse on a hit just before the predicted beat. Defaults reproduce the
// fixed values they replace (test_dsp_view.js and the other DSP tests).
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const module_=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')));
const source=fs.readFileSync(path.join(__dirname,'../web/js/dsp-view.js'),'utf8');
const levelOut=new Function(source.match(/function levelOut[\s\S]*?\n}\n/)[0]+'return levelOut;')();
const read=(d,ptr,n)=>Array.from(new Float32Array(d.memory.buffer,ptr,n));
const n=512,hop=256,rate=16000;
function fresh(){const d=new WebAssembly.Instance(module_).exports;d.set_sample_rate(rate);d.set_frequency_range(40,8000);d.reset_dsp();return d;}
// A 120 BPM kick over a quiet 440 Hz tone, with a hi-hat between the kicks.
const music=t=>{const beat=t%.5,hat=(t+.25)%.5;
 return .05*Math.sin(2*Math.PI*440*t)+(beat<.1?.6*Math.exp(-beat*24)*Math.sin(2*Math.PI*59*t):0)+(hat<.02?.2*Math.sin(2*Math.PI*5000*t)*Math.exp(-hat*200):0);};
function run(d,frames,signal,args=[25,210,.008,1,1.6,.82,900,0],each=()=>{}){
 const input=new Float32Array(d.memory.buffer,d.new_input_ptr(),n);
 for(let f=0;f<frames;f++){
  for(let i=0;i<n;i++)input[i]=signal((f*hop-n+i)/rate);
  d.new_process(n,hop/rate,...args);each(f);
 }
}

// Tilt: every band's gain is (center / 1 kHz) ^ (dB per octave / 6.02).
{
 const d=fresh();d.set_spectral_tilt(4.5);
 const tilt=read(d,d.new_tilt_ptr(),16);
 for(let b=0;b<16;b++){
  const fc=Math.sqrt(40*Math.pow(200,b/16)*40*Math.pow(200,(b+1)/16)),want=Math.pow(fc/1000,4.5/(20*Math.log10(2)));
  assert(Math.abs(tilt[b]/want-1)<1e-4,`tilt band ${b}: ${tilt[b]} vs ${want}`);
 }
 // The raw band levels carry it: a 4 kHz tone's band is lifted by its center's gain.
 const flat=fresh(),lifted=fresh();lifted.set_spectral_tilt(6);
 const tone=t=>.1*Math.sin(2*Math.PI*4000*t);
 run(flat,20,tone);run(lifted,20,tone);
 const b=Math.floor(16*Math.log(4000/40)/Math.log(200)),ratio=read(lifted,lifted.new_raw_ptr(),16)[b]/read(flat,flat.new_raw_ptr(),16)[b];
 const centre=Math.sqrt(40*Math.pow(200,b/16)*40*Math.pow(200,(b+1)/16));
 assert(Math.abs(ratio/Math.pow(centre/1000,6/(20*Math.log10(2)))-1)<1e-3,`4 kHz band lifted by the tilt (${ratio})`);
 d.set_spectral_tilt(0);assert(read(d,d.new_tilt_ptr(),16).every(v=>v===1),'tilt 0 is exactly flat');
}

// Band balance: each band's reference moves to its own average (within 18 dB
// of the global one) and the targets follow the drawn curve with it.
{
 const d=fresh();d.set_band_balance(1);
 let checked=0;
 run(d,500,music,undefined,f=>{
  if(f<300)return;
  const raw=read(d,d.new_raw_ptr(),16),targets=read(d,d.new_targets_ptr(),16),bandRef=read(d,d.new_band_ref_ptr(),16),ref=Math.max(.003,read(d,d.new_metrics_ptr(),10)[5]);
  for(let b=0;b<16;b++){
   assert(Math.abs(targets[b]-levelOut(raw[b],.008,1.6,.82,bandRef[b]))<1e-5,`balanced target ${b}`);
   assert(bandRef[b]>=ref*.125*.999&&bandRef[b]<=ref*8*1.001,`band ${b} reference within 18 dB`);
   checked++;
  }
 });
 // A loud bass over a quiet, moving 5 kHz tone, never silent (the band
 // averages are gated like the AGC); no noise floor or compression, so only
 // the reference differs: balance lifts the high band.
 const steady=t=>.25*Math.sin(2*Math.PI*80*t)*(1+.5*Math.sin(2*Math.PI*2*t))+.012*Math.sin(2*Math.PI*5000*t)*(1+.8*Math.sin(2*Math.PI*3*t));
 const A=fresh(),B=fresh(),high=Math.floor(16*Math.log(5000/40)/Math.log(200)),args=[25,210,0,1,1.6,0,900,0];A.set_band_balance(1);
 let litBalanced=0,litPlain=0;
 run(A,900,steady,args,f=>{if(f>=600)litBalanced+=read(A,A.new_bands_ptr(),16)[high];});
 run(B,900,steady,args,f=>{if(f>=600)litPlain+=read(B,B.new_bands_ptr(),16)[high];});
 const refs=read(A,A.new_band_ref_ptr(),16);
 assert(refs[0]/refs[high]>4,`references differ per band with full balance (${refs[0]} / ${refs[high]})`);
 assert(litBalanced>litPlain*1.8,`balance lifts the quiet high band (${(litBalanced/300).toFixed(2)} vs ${(litPlain/300).toFixed(2)})`);
 console.log(`PASS tilt gains, tilted raw bands, band balance: ${checked} targets on the per-band curve`);
}

// Groups: the levels average the chosen bands; every group keeps a band.
{
 const d=fresh();
 for(const [m,h,em,eh] of [[3,10,3,10],[0,0,1,2],[15,15,14,15],[8,4,8,9]]){
  d.set_band_groups(m,h);
  assert.deepEqual([d.group_first_band(0),d.group_first_band(1),d.group_first_band(2),d.group_first_band(3)],[0,em,eh,16],`groups ${m},${h}`);
 }
 d.set_band_groups(3,10);
 run(d,60,music);
 const bands=read(d,d.new_bands_ptr(),16),levels=read(d,d.new_levels_ptr(),3),mean=(a,b)=>bands.slice(a,b).reduce((s,v)=>s+v,0)/(b-a);
 [[0,3],[3,10],[10,16]].forEach(([a,b],g)=>assert(Math.abs(levels[g]-mean(a,b))<1e-5,`group ${g} level`));
 console.log('PASS band groups: clamped splits, group levels average their bands');
}

// Onsets per group: hold-off spaces the hits, flash decay sets the fade,
// the trim raises the threshold.
{
 // Loud and quiet kicks in turn: a higher trim keeps only the loud ones.
 const accents=t=>{const beat=t%.5,loud=Math.floor(t/.5)%2===0;return .05*Math.sin(2*Math.PI*440*t)+(beat<.1?(loud?.6:.12)*Math.exp(-beat*24)*Math.sin(2*Math.PI*59*t):0);};
 const hits=(holdoff,trim=1,signal=music)=>{
  const d=fresh();d.set_onset_group(0,trim,holdoff,220);
  const times=[];run(d,600,signal,undefined,f=>{if(read(d,d.new_events_ptr(),3)[0])times.push(f*hop/rate);});
  return times;
 };
 const normal=hits(160),long=hits(700),strict=hits(160,3,accents),loose=hits(160,1,accents);
 // The trim scales the adaptive part of the threshold, the 0.07 base stays.
 {
  const a=fresh(),b=fresh();b.set_onset_group(1,2.5,85,130);
  run(a,1,music);run(b,1,music);
  const input=[a,b].map(d=>new Float32Array(d.memory.buffer,d.new_input_ptr(),n));
  for(let f=1;f<300;f++){
   for(let i=0;i<n;i++)input[0][i]=input[1][i]=music((f*hop-n+i)/rate);
   for(const d of [a,b])d.new_process(n,hop/rate,25,210,.008,1,1.6,.82,900,0);
   const ta=read(a,a.new_thresholds_ptr(),3)[1],tb=read(b,b.new_thresholds_ptr(),3)[1];
   assert(Math.abs((tb-.07)-2.5*(ta-.07))<1e-5,`mid threshold trimmed ×2.5 (${ta} → ${tb})`);
  }
 }
 for(let i=1;i<long.length;i++)assert(long[i]-long[i-1]>=.7-1e-6,`hold-off 700 ms keeps hits apart (${long[i]-long[i-1]})`);
 assert(normal.length>=15&&long.length<=normal.length*.6,`a long hold-off skips beats (${normal.length} → ${long.length})`);
 assert(strict.length<loose.length*.75,`a higher trim drops the quiet kicks (${loose.length} → ${strict.length})`);
 const d=fresh();d.set_onset_group(0,1,160,400);
 let after=null;
 run(d,600,music,undefined,()=>{
  const p=read(d,d.new_pulses_ptr(),3)[0],e=read(d,d.new_events_ptr(),3)[0];
  if(e)after=p;else if(after!==null&&p>0){assert(Math.abs(after-p-hop/rate/.4)<1e-5,`flash fades by hop / 400 ms (${after-p})`);after=p;}
 });
 console.log(`PASS per-group onsets: hold-off ${normal.length} → ${long.length} hits, trim ×3 ${loose.length} → ${strict.length}, threshold trim, flash decay rate`);
}

// Expansion: negative compression blends toward the square; the targets follow.
{
 const d=fresh();let checked=0,expandedSum=0,linearSum=0;
 const lin=fresh();
 run(d,300,music,[25,210,.008,1,1.6,-.7,900,0],()=>{
  const raw=read(d,d.new_raw_ptr(),16),targets=read(d,d.new_targets_ptr(),16),ref=Math.max(.003,read(d,d.new_metrics_ptr(),10)[5]);
  for(let b=0;b<16;b++){assert(Math.abs(targets[b]-levelOut(raw[b],.008,1.6,-.7,ref))<1e-5,`expanded target ${b}`);checked++;expandedSum+=targets[b];}
 });
 run(lin,300,music,[25,210,.008,1,1.6,0,900,0],()=>{for(const v of read(lin,lin.new_targets_ptr(),16))linearSum+=v;});
 assert(expandedSum<linearSum,'expansion darkens the average level');
 console.log(`PASS expansion: ${checked} targets on the expanded curve`);
}

// Tempo range: the search lags follow it; the tempo stays inside it.
{
 const d=fresh();
 run(d,320,music);
 assert.deepEqual(read(d,d.new_tempo_info_ptr(),4).slice(0,2),[21,58],'default 65–180 BPM searches lags 21..58');
 const bpm=dd=>read(dd,dd.new_metrics_ptr(),10)[6];
 assert(bpm(d)>115&&bpm(d)<125,`120 BPM in the default range (${bpm(d)})`);
 const scores=read(d,d.new_tempo_scores_ptr(),128),info=read(d,d.new_tempo_info_ptr(),4);
 assert(Math.abs(scores[info[2]]-info[3])<1e-6&&scores.every((v,i)=>i>=21&&i<=58||v===0),'scores exported for the searched lags only');
 // Every multiple of the beat is periodic too: a range without 120 picks one.
 const slow=fresh();slow.set_tempo_range(50,100);run(slow,320,music);
 assert(bpm(slow)>55&&bpm(slow)<65,`a 50–100 range finds the half tempo (${bpm(slow)})`);
 // A hit just before the predicted beat still pulses: one pulse per beat.
 const p=fresh();let pulses=0;
 run(p,620,music,undefined,f=>{if(f>=320&&read(p,p.new_metrics_ptr(),10)[9]>=1)pulses++;});
 const beats=300*hop/rate/.5;
 assert(Math.abs(pulses-beats)<=1.5,`beat pulses ${pulses} for ${beats.toFixed(1)} beats`);
 console.log(`PASS tempo range: lags 21..58 by default, ${bpm(slow).toFixed(1)} BPM in 50–100, ${pulses} beat pulses for ${beats.toFixed(1)} beats`);
}

// Window: every window reads an on-bin tone at its amplitude (the spectrum is
// divided by the window's mean); between bins flat-top stays exact while the
// rectangle loses most; Blackman-Harris leaks least, the rectangle most.
{
 const tone=hz=>t=>.1*Math.sin(2*Math.PI*hz*t),bin=rate/n,k=32;
 const peak=(type,hz)=>{const d=fresh();d.set_window(type);run(d,4,tone(hz));const sp=read(d,d.new_spectrum_ptr(),n/2);return {sp,max:Math.max(...sp.slice(k-3,k+4))};};
 const onBin=[0,1,2,3,4].map(w=>peak(w,k*bin));
 onBin.forEach(({max},w)=>assert(Math.abs(max/.1-1)<.02,`window ${w} reads an on-bin tone at its level (${max})`));
 const half=[0,3,4].map(w=>peak(w,(k+.5)*bin).max/.1);
 assert(Math.abs(half[1]-1)<.02,`flat-top reads a tone between bins exactly (${half[1]})`);
 assert(half[0]>.8&&half[0]<.9&&half[2]<.7,`Hann and the rectangle lose between bins (${half[0]}, ${half[2]})`);
 const leak=[0,2,4].map(w=>peak(w,(k+.5)*bin).sp[k+6]/.1);
 assert(leak[1]<leak[0]/10&&leak[0]<leak[2]/10,`leakage 6 bins away: Blackman-Harris < Hann < rectangle (${leak.map(v=>v.toExponential(1))})`);
 // Hann is the default: setting it changes nothing.
 const a=fresh(),b=fresh();b.set_window(2);b.set_window(0);run(a,40,music);run(b,40,music);
 assert.deepEqual(read(b,b.new_bands_ptr(),16),read(a,a.new_bands_ptr(),16),'Hann set explicitly is the default');
 console.log(`PASS window: on-bin level in all 5, between bins Hann ${half[0].toFixed(2)} / flat-top ${half[1].toFixed(3)} / rectangle ${half[2].toFixed(2)}`);
}

// Group trims multiply the raw bands of their group, after the tilt.
{
 const a=fresh(),b=fresh();b.set_band_groups(5,12);b.set_group_gains(6,0,-6);
 run(a,20,music);run(b,20,music);
 const ra=read(a,a.new_raw_ptr(),16),rb=read(b,b.new_raw_ptr(),16);
 for(let i=0;i<16;i++){
  const want=Math.pow(10,(i<5?6:i<12?0:-6)/20);
  if(ra[i]>1e-6)assert(Math.abs(rb[i]/ra[i]/want-1)<1e-3,`band ${i} trimmed ×${want.toFixed(3)} (${rb[i]/ra[i]})`);
 }
 console.log('PASS group trims: +6 / 0 / −6 dB on the raw bands of bass, mid, high');
}

// Band smoothing blends each band's target with its neighbours before the
// envelope: on the first frame every band is attack × the smoothed target.
{
 const smooth=(t,k)=>t.map((here,b)=>(1-.5*k)*here+k*.25*((b?t[b-1]:here)+(b<15?t[b+1]:here)));
 const tone=t=>.2*Math.sin(2*Math.PI*1000*t);
 const d=fresh();d.set_band_smoothing(.6);run(d,1,tone);
 const targets=read(d,d.new_targets_ptr(),16),bands=read(d,d.new_bands_ptr(),16),want=smooth(targets,.6);
 const ratios=want.map((w,b)=>w>1e-4?bands[b]/w:null).filter(v=>v!==null);
 assert(ratios.length>2&&ratios.every(r=>Math.abs(r/ratios[0]-1)<1e-4),`bands follow the smoothed targets (${ratios.map(r=>r.toFixed(4))})`);
 const plain=fresh(),wide=fresh();wide.set_band_smoothing(1);run(plain,80,tone);run(wide,80,tone);
 const p=read(plain,plain.new_bands_ptr(),16),w=read(wide,wide.new_bands_ptr(),16),top=p.indexOf(Math.max(...p));
 assert(w[top]<p[top]&&w[top]>.4*p[top]&&w[top-1]+w[top+1]>p[top-1]+p[top+1],`smoothing spreads a tone to its neighbours (${p[top].toFixed(2)} → ${w[top].toFixed(2)})`);
 console.log(`PASS band smoothing: the envelope follows the smoothed targets, a tone spreads ${p[top].toFixed(2)} → ${w[top].toFixed(2)}`);
}

// Peak hold: after a burst the level stays at its peak for the hold time,
// then the release starts; without it the release starts at once.
{
 const burst=t=>t>=0&&t<.4?.2*Math.sin(2*Math.PI*1000*t):0;
 const flatFrames=ms=>{
  const d=fresh();d.set_peak_hold(ms);
  const vals=[];run(d,80,burst,[25,210,0,1,1.6,.82,900,0],()=>vals.push(Math.max(...read(d,d.new_bands_ptr(),16))));
  const top=vals.indexOf(Math.max(...vals));let same=0;
  while(top+same+1<vals.length&&vals[top+same+1]===vals[top])same++;
  return same;
 };
 const none=flatFrames(0),held=flatFrames(200),frames=Math.ceil(.2/(hop/rate));
 assert(none===0,`no hold: the release starts on the next frame (${none})`);
 assert(Math.abs(held-frames)<=1,`200 ms hold keeps the peak ${frames} frames (${held})`);
 console.log(`PASS peak hold: the peak stays ${held} frames at 200 ms, 0 without`);
}

// Onset memory: the threshold forgets a busy part faster with a short memory.
{
 const busyThenCalm=t=>{const beat=t%.125;return .05*Math.sin(2*Math.PI*440*t)+(t<6&&beat<.06?.5*Math.exp(-beat*40)*Math.sin(2*Math.PI*59*t):0);};
 const after=memory=>{const d=fresh();d.set_onset_memory(memory);let th=0;run(d,Math.round(6.8*rate/hop),busyThenCalm,undefined,()=>{th=read(d,d.new_thresholds_ptr(),3)[0];});return th-.07;};
 const short=after(.2),def=after(.7),long=after(4);
 assert(short<def&&def<long&&short<long*.3,`0.8 s after the busy part: ${short.toFixed(3)} < ${def.toFixed(3)} < ${long.toFixed(3)}`);
 console.log(`PASS onset memory: adaptive threshold 0.8 s later ${short.toFixed(3)} (0.2 s) / ${def.toFixed(3)} (0.7 s) / ${long.toFixed(3)} (4 s)`);
}
