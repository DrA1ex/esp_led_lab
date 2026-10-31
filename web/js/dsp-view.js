'use strict';
// DSP view: on the Analyzer tab the stage can show, instead of the LEDs, what
// the analyzer settings do to the captured signal. Each panel draws the curve
// or response a group of settings sets up and the live signal going through
// it; the curves mirror new_process() in src/dsp.cpp.
const STAGE_MODE_KEY='esp-led-lab.stage-mode',DSP_PANEL_KEY='esp-led-lab.dsp-panel',DSP_GROUP_KEY='esp-led-lab.dsp-group';
// One panel per group of settings, then views across all of them.
const DSP_SETTING_PANELS=['resolution','bands','level','envelope','onsets','tempo','noise'],DSP_PANELS=[...DSP_SETTING_PANELS,'spectrogram','notes','chain','map','ab'];
const DSP_GROUP_PANELS=['envelope','onsets','chain','ab'];
// The panel that shows an analyzer control; touching the control opens it.
const DSP_CONTROL_PANEL={fft:'resolution','sample-rate':'resolution',window:'resolution','freq-min':'resolution','freq-max':'resolution',
 tilt:'bands','eq-bass':'bands','eq-mid':'bands','eq-high':'bands',balance:'bands',smoothing:'bands','split-mid':'bands','split-high':'bands',
 gain:'level',compression:'level',agc:'level',attack:'envelope',release:'envelope','peak-hold':'envelope',transient:'onsets','onset-memory':'onsets',
 'bpm-min':'tempo','bpm-max':'tempo','noise-db':'noise','adaptive-db':'noise','floor-rise':'noise','floor-fall':'noise'};
for(let g=0;g<3;g++)for(const k of ['onset-trim','holdoff','flash'])DSP_CONTROL_PANEL[`${k}-${g}`]='onsets';
const GROUP_NAMES=['Bass','Mid','High'],GROUP_COLORS=['#ff9161','#ffd166','#6fd3ff'];
// The bands of the bass / mid / high groups as the running DSP has them (Groups).
function groupBands(d=STATE.modules.dsp.exports){const m=d.group_first_band(1),h=d.group_first_band(2);return [[0,m],[m,h],[h,16]];}
const bandGroup=(k,gb)=>k<gb[1][0]?0:k<gb[2][0]?1:2;
const DSP_COLORS={grid:'#1d222c',axis:'#2c3240',text:'#8a93a3',text2:'#bcc4d0',accent:'#8e9bff',live:'#5ad1a0',warn:'#f0b45a'};
const DSP_STEP=.016,DSP_LEN=320; // history: 16 ms steps, about 5 s
const SPEC_ROWS=128,HIT_LOG=64; // spectrogram rows (log frequency); hits kept per group for their intervals
// dsp.cpp: the tempo tracker's novelty step and window, its acceptance and beat thresholds.
const NOVELTY_STEP=.016,NOVELTY_WINDOW=192,TEMPO_ACCEPT=.17,BEAT_CONFIDENCE=.21,BEAT_LOCK=.18;

function storedChoice(key,allowed,fallback){
 try{const v=localStorage.getItem(key);if(allowed.includes(v))return v;}catch(_){}
 return fallback;
}
const DSP={mode:storedChoice(STAGE_MODE_KEY,['leds','dsp'],'dsp'),panel:storedChoice(DSP_PANEL_KEY,DSP_PANELS,'level'),
 group:+storedChoice(DSP_GROUP_KEY,['0','1','2'],'0'),caption:'',captionAt:0,ab:null};
const dspSeries=()=>[0,1,2].map(()=>new Float32Array(DSP_LEN));
const DSP_HIST={pos:0,filled:0,elapsed:0,peakFlux:[0,0,0],hit:[0,0,0],time:0,beatHit:0,hits:[[],[],[]],
 target:dspSeries(),output:dspSeries(),flux:dspSeries(),threshold:dspSeries(),event:dspSeries(),pulse:dspSeries(),
 average:new Float32Array(DSP_LEN),ref:new Float32Array(DSP_LEN),
 raw:dspSeries(),cut:dspSeries(),bands:new Float32Array(16*DSP_LEN),rawBands:new Float32Array(16*DSP_LEN),
 beat:new Float32Array(DSP_LEN),bpm:new Float32Array(DSP_LEN),confidence:new Float32Array(DSP_LEN),
 spec:new Float32Array(SPEC_ROWS*DSP_LEN).fill(-140),chroma:new Float32Array(12*DSP_LEN),
 abHit:[0,0,0],abOutput:dspSeries(),abEvent:dspSeries(),abBands:new Float32Array(16*DSP_LEN)};

// Spectrogram rows: logarithmic from 20 Hz to the analysed Nyquist. A row
// takes the loudest bin whose center lies in it, or interpolates between the
// two nearest bins where it is narrower than a bin.
const SPEC={key:'',rows:[],ny:8000};
function specPlan(n){
 const ny=analysisNyquist(),key=[n,fs,ny].join(':');
 if(SPEC.key===key)return SPEC;
 const step=fs/n;
 SPEC.rows=Array.from({length:SPEC_ROWS},(_,r)=>{
  const f0=20*Math.pow(ny/20,r/SPEC_ROWS),f1=20*Math.pow(ny/20,(r+1)/SPEC_ROWS),k0=Math.max(1,Math.ceil(f0/step)),k1=Math.min(n/2-1,Math.ceil(f1/step)-1);
  return k1>=k0?{k0,k1}:{x:Math.sqrt(f0*f1)/step};
 });
 SPEC.key=key;SPEC.ny=ny;DSP_HIST.spec.fill(-140); // the old rows meant other frequencies
 return SPEC;
}
function recordSpectrum(d,n,i){
 const spectrum=new Float32Array(d.memory.buffer,d.new_spectrum_ptr(),n/2),plan=specPlan(n);
 for(let r=0;r<SPEC_ROWS;r++){
  const p=plan.rows[r];let v=0;
  if(p.k0!==undefined)for(let k=p.k0;k<=p.k1;k++)v=Math.max(v,spectrum[k]);
  else{const k=Math.max(1,Math.min(n/2-2,Math.floor(p.x))),f=Math.max(0,Math.min(1,p.x-k));v=spectrum[k]*(1-f)+spectrum[k+1]*f;}
  DSP_HIST.spec[r*DSP_LEN+i]=toDb(v);
 }
}

// Called after every new_process(): keeps ~5 s of the intermediate signals.
// The hop never exceeds 16 ms, so one step takes at most one sample per hop;
// flux keeps its peak and hits are kept when several hops share a step.
function recordDsp(d,hopSeconds,s,nowSample){
 const H=DSP_HIST,mem=d.memory.buffer,metrics=new Float32Array(mem,d.new_metrics_ptr(),10);
 H.time+=hopSeconds;
 for(let g=0;g<3;g++){
  H.peakFlux[g]=Math.max(H.peakFlux[g],metrics[g]);
  if(STATE.events[g]){H.hit[g]=1;const log=H.hits[g];log.push(H.time);if(log.length>HIT_LOG)log.shift();}
 }
 if(metrics[9]>=1)H.beatHit=1; // the beat pulse restarts at 1 on a predicted beat
 const ab=processCompare(nowSample);
 H.elapsed+=hopSeconds;
 if(H.elapsed+1e-6<DSP_STEP)return;
 H.elapsed=Math.max(0,H.elapsed-DSP_STEP);
 const raw=new Float32Array(mem,d.new_raw_ptr(),16),targets=new Float32Array(mem,d.new_targets_ptr(),16),thresholds=new Float32Array(mem,d.new_thresholds_ptr(),3),i=H.pos;
 const floor=new Float32Array(mem,d.new_floor_ptr(),16),gate=noiseGate(s),adaptive=adaptiveAmount(s),gb=groupBands(d);
 for(let k=0;k<16;k++){H.bands[k*DSP_LEN+i]=STATE.newSpectrum[k];H.rawBands[k*DSP_LEN+i]=raw[k];}
 H.beat[i]=H.beatHit;H.beatHit=0;H.bpm[i]=metrics[6];H.confidence[i]=metrics[7];
 recordSpectrum(d,s.fft,i);
 for(let k=0;k<12;k++)H.chroma[k*DSP_LEN+i]=STATE.chroma[k];
 for(let g=0;g<3;g++){
  const [a,b]=gb[g];let t=0,r=0,c=0;for(let k=a;k<b;k++){t+=targets[k];r+=raw[k];c+=gate+floor[k]*adaptive;}
  H.raw[g][i]=r/(b-a);H.cut[g][i]=c/(b-a);
  if(ab){H.abOutput[g][i]=ab.levels[g];H.abEvent[g][i]=H.abHit[g];H.abHit[g]=0;}
  H.target[g][i]=t/(b-a);H.output[g][i]=STATE.levels[g];H.flux[g][i]=H.peakFlux[g];H.threshold[g][i]=thresholds[g];
  H.event[g][i]=H.hit[g];H.pulse[g][i]=STATE.pulses[g];H.peakFlux[g]=H.hit[g]=0;
 }
 let sum=0;for(let k=0;k<16;k++)sum+=raw[k];
 H.average[i]=sum/16;H.ref[i]=metrics[5];
 if(ab)for(let k=0;k<16;k++)H.abBands[k*DSP_LEN+i]=ab.bands[k];
 H.pos=(i+1)%DSP_LEN;H.filled=Math.min(DSP_LEN,H.filled+1);
}
// A/B: a second DSP instance runs the pinned settings (A) on the same audio
// as the live one (B). Pinning copies the live instance's memory, so both
// start from the same state and differ only by what is changed afterwards.
const AB_KEYS=['fft','window','attack','release','peak-hold','noise-db','adaptive-db','floor-rise','floor-fall','gain','transient','onset-memory','agc','compression',
 'tilt','eq-bass','eq-mid','eq-high','balance','smoothing','split-mid','split-high',
 ...[0,1,2].flatMap(g=>[`onset-trim-${g}`,`holdoff-${g}`,`flash-${g}`]),'bpm-min','bpm-max'];
function pinCompare(){
 const main=STATE.modules.dsp.exports,s=settings();
 if(!STATE.modules.compare)STATE.modules.compare=new WebAssembly.Instance(STATE.modules.dspModule);
 const c=STATE.modules.compare.exports,pages=(main.memory.buffer.byteLength-c.memory.buffer.byteLength)/65536;
 if(pages>0)c.memory.grow(pages);
 new Uint8Array(c.memory.buffer).set(new Uint8Array(main.memory.buffer));
 DSP.ab={settings:Object.fromEntries(AB_KEYS.map(k=>[k,s[k]])),range:frequencyRange(s),rate:fs};
 // Until A has its own history, it shares the live one.
 const H=DSP_HIST;H.abOutput.forEach((a,g)=>a.set(H.output[g]));H.abEvent.forEach((a,g)=>a.set(H.event[g]));H.abBands.set(H.bands);
 refreshStageMode();
}
function clearCompare(){DSP.ab=null;refreshStageMode();}
function resetCompare(){
 if(!DSP.ab||!STATE.modules.compare)return;
 const c=STATE.modules.compare.exports;c.reset_dsp();c.set_sample_rate(fs);c.set_frequency_range(DSP.ab.range.lo,DSP.ab.range.hi);DSP.ab.rate=fs;
}
// Runs A on the hop the live DSP just processed; returns its levels and bands.
function processCompare(now){
 const ab=DSP.ab;if(!ab||!STATE.modules.compare)return null;
 const c=STATE.modules.compare.exports,a=ab.settings,n=a.fft;
 if(ab.rate!==fs)resetCompare();
 const input=new Float32Array(c.memory.buffer,c.new_input_ptr(),c.max_fft_size());
 for(let j=0;j<n;j++)input[j]=sampleAt(now-n+j);
 applyDspSettings(c,a);
 c.new_process(n,hop/fs,a.attack,a.release,noiseGate(a),a.transient/10,a.gain/10,a.compression/100,a.agc,adaptiveAmount(a));
 const events=new Float32Array(c.memory.buffer,c.new_events_ptr(),3);
 for(let g=0;g<3;g++)if(events[g])DSP_HIST.abHit[g]=1;
 return {levels:new Float32Array(c.memory.buffer,c.new_levels_ptr(),3),bands:new Float32Array(c.memory.buffer,c.new_bands_ptr(),16)};
}

// History sample j of the H.filled kept ones, oldest first.
const histAt=(arr,j)=>arr[(DSP_HIST.pos-DSP_HIST.filled+j+DSP_LEN)%DSP_LEN];

// The band level → LED level curve of new_process(): noise floor subtracted,
// sensitivity over the band's reference (the AGC reference, or with Band
// balance partly its own), compression (> 0) or expansion (< 0), soft knee.
function levelOut(raw,gate,gain,compression,ref,floor=0){
 const n=Math.max(0,Math.max(0,raw-gate-floor)*gain/(ref*6.5));
 const c=compression>=0?(1-compression)*n+compression*Math.sqrt(n):(1+compression)*n-compression*n*n;
 return c/(.85+c);
}
const toDb=v=>20*Math.log10(Math.max(1e-7,v));
const dbNorm=(v,lo,hi)=>Math.max(0,Math.min(1,(toDb(v)-lo)/(hi-lo)));
const formatDb=v=>`${toDb(v)<0?'−':''}${Math.abs(Math.round(toDb(v)))} dB`;
const shortHz=hz=>hz>=1000?`${+(hz/1000).toFixed(hz>=10000?0:1)}k`:`${Math.round(hz)}`;
// A plot area; X/Y map 0..1 into it (Y upwards).
const plotBox=(x,y,w,h)=>({x,y,w,h,X:v=>x+v*w,Y:v=>y+(1-Math.max(0,Math.min(1,v)))*h});

function dspText(ctx,text,x,y,{align='left',color=DSP_COLORS.text,size=10.5,weight='',bg=false}={}){
 ctx.font=`${weight} ${size}px system-ui,sans-serif`;ctx.textAlign=align;
 if(bg){const w=ctx.measureText(text).width,x0=align==='right'?x-w:align==='center'?x-w/2:x;ctx.fillStyle='rgba(10,12,16,.82)';ctx.fillRect(x0-3,y-size,w+6,size+4);}
 ctx.fillStyle=color;ctx.fillText(text,x,y);
}
function dspFrame(ctx,b){ctx.strokeStyle=DSP_COLORS.axis;ctx.lineWidth=1;ctx.strokeRect(b.x+.5,b.y+.5,b.w-1,b.h-1);}
// Legend entries [color, label, dashed] in a row from (x, y).
function dspLegend(ctx,x,y,items){
 for(const [color,label,dashed] of items){
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.setLineDash(dashed?[4,3]:[]);
  ctx.beginPath();ctx.moveTo(x,y-3.5);ctx.lineTo(x+14,y-3.5);ctx.stroke();ctx.setLineDash([]);
  dspText(ctx,label,x+18,y,{color:DSP_COLORS.text2});
  x+=18+ctx.measureText(label).width+14;
 }
}
// Vertical lines every second of the history, newest at the right.
function timeGrid(ctx,b){
 ctx.strokeStyle=DSP_COLORS.grid;ctx.lineWidth=1;ctx.beginPath();
 for(let s=1;s*1/DSP_STEP<DSP_LEN;s++){const x=Math.round(b.x+b.w-s/DSP_STEP/(DSP_LEN-1)*b.w)+.5;ctx.moveTo(x,b.y);ctx.lineTo(x,b.y+b.h);}
 ctx.stroke();
}
function timeLabels(ctx,b){
 for(let s=0;s*1/DSP_STEP<DSP_LEN;s++)dspText(ctx,s?`−${s} s`:'now',b.x+b.w-s/DSP_STEP/(DSP_LEN-1)*b.w,b.y+b.h+12,{align:s?'center':'right'});
}
// A history series as a path; map turns a value into 0..1.
function seriesPath(ctx,b,arr,map){
 const n=DSP_HIST.filled,x0=b.x+(DSP_LEN-n)/(DSP_LEN-1)*b.w;
 ctx.beginPath();
 for(let j=0;j<n;j++){const x=b.x+(DSP_LEN-n+j)/(DSP_LEN-1)*b.w,y=b.Y(map(histAt(arr,j)));if(j)ctx.lineTo(x,y);else ctx.moveTo(x,y);}
 return x0;
}
function drawSeries(ctx,b,arr,map,{color,width=1.5,fill=null,dash=null}){
 if(DSP_HIST.filled<2)return;
 if(fill){const x0=seriesPath(ctx,b,arr,map);ctx.lineTo(b.x+b.w,b.y+b.h);ctx.lineTo(x0,b.y+b.h);ctx.closePath();ctx.fillStyle=fill;ctx.fill();}
 seriesPath(ctx,b,arr,map);ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.setLineDash(dash||[]);ctx.stroke();ctx.setLineDash([]);
}
// A round tick step (ms) that keeps labels about 60 px apart.
const tickStep=(spanMs,width)=>[1,2,5,10,20,50,100,200,500,1000,2000,5000].find(v=>spanMs/v<=Math.max(1,Math.floor(width/60)))||10000;
const waitingText=(ctx,b)=>{if(DSP_HIST.filled<2)dspText(ctx,'Play something to see the signal',b.x+b.w/2,b.y+b.h/2,{align:'center'});};

// The windows of dsp.cpp (generalized cosine: a0 - a1 cos x + a2 cos 2x - …)
// and a pure tone through each, ±12 bins around it in dB (±6 are drawn).
// Computed once per window from 256 samples; the shape in bins barely
// depends on the FFT size.
const WINDOW_COEFFS=[[.5,.5],[.54,.46],[.35875,.48829,.14128,.01168],[.21557895,.41663158,.277263158,.083578947,.006947368],[1]];
const WINDOW_NAMES=['Hann','Hamming','Blackman-Harris','flat-top','rectangular'],WINDOW_CACHE=[];
function windowResponse(type){
 if(WINDOW_CACHE[type])return WINDOW_CACHE[type];
 const N=256,c=WINDOW_COEFFS[type]||WINDOW_COEFFS[0],w=new Float64Array(N),STEPS=961,mag=new Float64Array(STEPS),db=new Float32Array(STEPS);
 for(let i=0;i<N;i++){const x=2*Math.PI*i/(N-1);let v=0;c.forEach((a,k)=>{v+=(k%2?-a:a)*Math.cos(k*x);});w[i]=v;}
 let peak=0;
 for(let j=0;j<STEPS;j++){
  const f=-12+24*j/(STEPS-1);let re=0,im=0;
  for(let i=0;i<N;i++){const ph=-2*Math.PI*f*i/N;re+=w[i]*Math.cos(ph);im+=w[i]*Math.sin(ph);}
  mag[j]=Math.hypot(re,im);peak=Math.max(peak,mag[j]);
 }
 for(let j=0;j<STEPS;j++)db[j]=20*Math.log10(Math.max(1e-9,mag[j]/peak));
 // Main lobe: past −6 dB (flat-top ripples at its top) out to the first
 // minimum; leakage: the highest side lobe beyond it.
 const mid=(STEPS-1)/2;let edge=mid;while(edge<STEPS-1&&db[edge]>-6)edge++;while(edge<STEPS-1&&db[edge+1]<db[edge])edge++;
 let side=-200;for(let j=edge;j<STEPS;j++)side=Math.max(side,db[j]);
 return WINDOW_CACHE[type]={db,side,lobe:24*(edge-mid)/(STEPS-1)};
}

// Resolution: the FFT bins of the live spectrum on a frequency axis, the 16
// bands inside the frequency range, and the windows of consecutive frames.
function drawResolution(ctx,W,H,s,d){
 const n=s.fft,step=fs/n,nyquist=analysisNyquist(),{lo,hi}=frequencyRange(s),win=n/fs,hopS=hop/fs;
 const timeH=Math.max(64,Math.min(120,H*.3)),spec=plotBox(12,22,W-24,Math.max(40,H-timeH-22-62));
 const F=f=>spec.x+Math.log(Math.max(20,f)/20)/Math.log(nyquist/20)*spec.w;
 const wide=W>=520,gb=groupBands(d);
 dspText(ctx,wide?`Spectrum · ${n} FFT bins of ${step.toFixed(1)} Hz`:`Bins of ${step.toFixed(1)} Hz`,spec.x,13,{color:DSP_COLORS.text2,weight:600});
 ctx.strokeStyle=DSP_COLORS.grid;ctx.beginPath();
 for(const f of [50,100,200,500,1000,2000,5000,10000,20000])if(f<nyquist){const x=Math.round(F(f))+.5;ctx.moveTo(x,spec.y);ctx.lineTo(x,spec.y+spec.h);}
 ctx.stroke();
 const spectrum=new Float32Array(d.memory.buffer,d.new_spectrum_ptr(),n/2);
 for(let k=1;k<n/2;k++){
  const f=k*step;if(f-step/2>nyquist)break;
  const x0=F(f-step/2),x1=F(Math.min(nyquist,f+step/2)),y=spec.Y(dbNorm(spectrum[k],-96,-6));
  ctx.fillStyle=f>=lo&&f<=hi?'rgba(142,155,255,.75)':'rgba(138,147,163,.3)';
  ctx.fillRect(x0,y,Math.max(.6,x1-x0-(x1-x0>4?1:0)),spec.y+spec.h-y);
 }
 ctx.fillStyle='rgba(7,8,11,.62)';
 ctx.fillRect(spec.x,spec.y,F(lo)-spec.x,spec.h);ctx.fillRect(F(hi),spec.y,spec.x+spec.w-F(hi),spec.h);
 if(F(lo)-spec.x>50)dspText(ctx,'ignored',(spec.x+F(lo))/2,spec.y+14,{align:'center'});
 if(spec.x+spec.w-F(hi)>50)dspText(ctx,'ignored',(F(hi)+spec.x+spec.w)/2,spec.y+14,{align:'center'});
 dspFrame(ctx,spec);
 // The 16 bands; a band narrower than a bin cannot move on its own.
 const strip=plotBox(spec.x,spec.y+spec.h+6,spec.w,12);let unresolved=0;
 for(let b=0;b<16;b++){
  const f0=lo*Math.pow(hi/lo,b/16),f1=lo*Math.pow(hi/lo,(b+1)/16),narrow=f1-f0<step,g=bandGroup(b,gb);
  if(narrow)unresolved++;
  ctx.globalAlpha=b%2?.55:.9;ctx.fillStyle=narrow?DSP_COLORS.text:GROUP_COLORS[g];
  ctx.fillRect(F(f0)+.5,strip.y,Math.max(1,F(f1)-F(f0)-1),strip.h);ctx.globalAlpha=1;
  if(narrow){ctx.strokeStyle=DSP_COLORS.warn;ctx.lineWidth=1;ctx.strokeRect(F(f0)+.5,strip.y+.5,Math.max(1,F(f1)-F(f0)-1),strip.h-1);}
 }
 for(const f of [50,100,200,500,1000,2000,5000,10000,20000])if(f<nyquist)dspText(ctx,formatHz(f),F(f),strip.y+strip.h+12,{align:'center'});
 dspText(ctx,unresolved?(wide?`${unresolved} of 16 bands are narrower than one bin`:`${unresolved}/16 bands < 1 bin`):'16 bands · bass, mid, high',spec.x+spec.w,13,{align:'right',color:unresolved?DSP_COLORS.warn:DSP_COLORS.text});
 // Frames in time: each one hears the last window, a new one starts every hop.
 const span=win+4*hopS,time=plotBox(12,H-timeH+8,wide?W*.58-24:W-24,timeH-26),T=t=>time.x+t/span*time.w,rows=5,rowH=Math.min(14,(time.h-4)/rows-3);
 dspText(ctx,`Frames · ${+(win*1000).toFixed(1)} ms window, a new frame every ${+(hopS*1000).toFixed(1)} ms`,time.x,time.y-4,{color:DSP_COLORS.text2,weight:600});
 for(let i=0;i<rows;i++){
  const y=time.y+4+i*(rowH+3);
  ctx.fillStyle=i===rows-1?'rgba(142,155,255,.8)':`rgba(142,155,255,${.18+i*.08})`;
  ctx.fillRect(T(i*hopS),y,Math.max(1,T(i*hopS+win)-T(i*hopS)),rowH);
 }
 const lastY=time.y+4+(rows-1)*(rowH+3)+rowH/2+3.5;
 if(T(4*hopS)-time.x>56)dspText(ctx,'newest frame',T(4*hopS)-6,lastY,{align:'right'});
 ctx.strokeStyle=DSP_COLORS.axis;ctx.beginPath();ctx.moveTo(time.x,time.y+time.h+.5);ctx.lineTo(time.x+time.w,time.y+time.h+.5);ctx.stroke();
 const tick=tickStep(span*1000,time.w);
 for(let t=0;t<=span*1000+1e-6;t+=tick)dspText(ctx,`${t} ms`,T(t/1000),time.y+time.h+12,{align:t?'center':'left'});
 // A pure tone through the window: the main lobe and how much leaks beside it.
 const R=windowResponse(s.window);
 if(wide){
  const wb=plotBox(W*.58+8,H-timeH+8,W*.42-20,timeH-26),X=f=>wb.x+(f+6)/12*wb.w,Y=db=>wb.Y((db+110)/110),last=R.db.length-1,F0=last/4,F1=last*3/4,fAt=j=>-12+24*j/last;
  dspText(ctx,`A pure tone through the ${WINDOW_NAMES[s.window]} window`,wb.x,wb.y-4,{color:DSP_COLORS.text2,weight:600});
  ctx.strokeStyle=DSP_COLORS.grid;ctx.beginPath();for(const f of [-3,0,3]){const x=Math.round(X(f))+.5;ctx.moveTo(x,wb.y);ctx.lineTo(x,wb.y+wb.h);}ctx.stroke();
  ctx.beginPath();ctx.moveTo(wb.x,wb.y+wb.h);for(let j=F0;j<=F1;j++)ctx.lineTo(X(fAt(j)),Y(R.db[j]));ctx.lineTo(wb.x+wb.w,wb.y+wb.h);ctx.closePath();ctx.fillStyle='rgba(142,155,255,.2)';ctx.fill();
  ctx.beginPath();for(let j=F0;j<=F1;j++){const x=X(fAt(j)),y=Y(R.db[j]);if(j>F0)ctx.lineTo(x,y);else ctx.moveTo(x,y);}ctx.strokeStyle=DSP_COLORS.accent;ctx.lineWidth=1.5;ctx.stroke();ctx.lineWidth=1;
  const sy=Math.round(Y(R.side))+.5;
  ctx.strokeStyle=DSP_COLORS.warn;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(wb.x,sy);ctx.lineTo(wb.x+wb.w,sy);ctx.stroke();ctx.setLineDash([]);
  dspText(ctx,`leakage −${Math.abs(Math.round(R.side))} dB`,wb.x+wb.w-4,Math.max(wb.y+11,sy-4),{align:'right',color:DSP_COLORS.warn,size:9.5,bg:true});
  dspFrame(ctx,wb);
  for(const f of [-6,-3,0,3,6])dspText(ctx,f>0?`+${f}`:f<0?`−${-f}`:'0',X(f),wb.y+wb.h+12,{align:f===-6?'left':f===6?'right':'center'});
  dspText(ctx,'bins',X(4.5),wb.y+wb.h+12,{align:'center'});
 }
 return {unresolved,side:R.side,lobe:R.lobe};
}

// Level: the curve from a band's level to its LED level, the 16 bands on it
// right now, and the AGC reference following the music's average level.
function drawLevel(ctx,W,H,s,d){
 const mem=d.memory.buffer,ref=Math.max(.003,new Float32Array(mem,d.new_metrics_ptr(),10)[5]),gate=noiseGate(s),gain=s.gain/10,comp=s.compression/100;
 const LO=-72,HI=0,stripH=Math.max(40,Math.min(80,H*.2));
 const b=plotBox(40,24,W-54,Math.max(60,H-24-stripH-46)),strip=plotBox(40,H-stripH-8,W-54,stripH-10);
 const xOf=raw=>b.X(dbNorm(raw,LO,HI)),rawAt=x=>Math.pow(10,(LO+(x-b.x)/b.w*(HI-LO))/20);
 dspText(ctx,'Band level → LED level',b.x,13,{color:DSP_COLORS.text2,weight:600});
 dspLegend(ctx,Math.max(b.x+150,b.x+b.w-300),13,[[DSP_COLORS.accent,'now'],[DSP_COLORS.text,'no compression',true]]);
 ctx.strokeStyle=DSP_COLORS.grid;ctx.lineWidth=1;ctx.beginPath();
 for(let db=LO;db<=HI;db+=12){const x=Math.round(b.X((db-LO)/(HI-LO)))+.5;ctx.moveTo(x,b.y);ctx.lineTo(x,b.y+b.h);}
 for(const v of [.25,.5,.75]){const y=Math.round(b.Y(v))+.5;ctx.moveTo(b.x,y);ctx.lineTo(b.x+b.w,y);}
 ctx.stroke();
 for(let db=LO;db<=HI;db+=12)dspText(ctx,`${db<0?'−':''}${Math.abs(db)}`,b.X((db-LO)/(HI-LO)),b.y+b.h+12,{align:'center'});
 dspText(ctx,'dB',b.x+b.w,b.y+b.h+24,{align:'right'});
 for(const v of [0,.5,1])dspText(ctx,`${v*100}%`,b.x-5,b.Y(v)+3.5,{align:'right'});
 // Everything under the noise floor comes out as 0.
 const gx=xOf(gate);
 ctx.fillStyle='rgba(138,147,163,.1)';ctx.fillRect(b.x,b.y,gx-b.x,b.h);
 ctx.strokeStyle=DSP_COLORS.warn;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(Math.round(gx)+.5,b.y);ctx.lineTo(Math.round(gx)+.5,b.y+b.h);ctx.stroke();ctx.setLineDash([]);
 dspText(ctx,'noise floor',gx-5,b.y+13,{align:'right',color:DSP_COLORS.warn});
 for(const [c,color,dash,width] of [[0,DSP_COLORS.text,[4,3],1.5],[comp,DSP_COLORS.accent,[],2.2]]){
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);ctx.lineJoin='round';ctx.beginPath();
  for(let x=b.x;x<=b.x+b.w;x++){const y=b.Y(levelOut(rawAt(x),gate,gain,c,ref));if(x>b.x)ctx.lineTo(x,y);else ctx.moveTo(x,y);}
  ctx.stroke();ctx.setLineDash([]);
 }
 // The music's average level (the AGC reference) and where it lands.
 const rx=xOf(ref),ry=levelOut(ref,gate,gain,comp,ref);
 ctx.strokeStyle='rgba(90,209,160,.5)';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(rx,b.y+b.h);ctx.lineTo(rx,b.Y(ry));ctx.lineTo(b.x,b.Y(ry));ctx.stroke();ctx.setLineDash([]);
 ctx.strokeStyle=DSP_COLORS.live;ctx.lineWidth=2;ctx.beginPath();ctx.arc(rx,b.Y(ry),6,0,Math.PI*2);ctx.stroke();
 dspText(ctx,`average level → ${Math.round(ry*100)}%`,rx+(rx>b.x+b.w-150?-10:10),b.Y(ry)+(ry>.8?16:-9),{align:rx>b.x+b.w-150?'right':'left',color:DSP_COLORS.live,bg:true});
 // With Band balance a band has its own reference: its dot sits at the input
 // that gives the same output on this (global reference) curve.
 const raw=new Float32Array(mem,d.new_raw_ptr(),16),targets=new Float32Array(mem,d.new_targets_ptr(),16),bandRef=new Float32Array(mem,d.new_band_ref_ptr(),16),gb=groupBands(d);
 for(let k=0;k<16;k++){
  if(raw[k]<=0)continue;
  const x=raw[k]>gate?gate+(raw[k]-gate)*ref/Math.max(1e-6,bandRef[k]):raw[k];
  ctx.fillStyle=GROUP_COLORS[bandGroup(k,gb)];ctx.beginPath();ctx.arc(xOf(x),b.Y(targets[k]),3.6,0,Math.PI*2);ctx.fill();
 }
 dspFrame(ctx,b);
 // AGC: the reference follows the average band level with the AGC time.
 timeGrid(ctx,strip);
 let mn=Infinity,mx=-Infinity;
 for(let j=0;j<DSP_HIST.filled;j++)for(const v of [histAt(DSP_HIST.average,j),histAt(DSP_HIST.ref,j)]){const db=toDb(Math.max(1e-5,v));mn=Math.min(mn,db);mx=Math.max(mx,db);}
 if(!Number.isFinite(mn)){mn=-60;mx=-20;}
 const mid=(mn+mx)/2,half=Math.max(12,(mx-mn)/2+3),map=v=>(toDb(Math.max(1e-5,v))-(mid-half))/(2*half);
 drawSeries(ctx,strip,DSP_HIST.average,map,{color:'rgba(188,196,208,.55)',width:1});
 drawSeries(ctx,strip,DSP_HIST.ref,map,{color:DSP_COLORS.live,width:2});
 dspFrame(ctx,strip);
 dspLegend(ctx,strip.x,strip.y-5,[['rgba(188,196,208,.55)','average band level'],[DSP_COLORS.live,`AGC reference · ${s.agc} ms`]]);
 return {average:ry};
}

// Envelope: the selected group before and after attack/release, and the
// response to a sound that starts and stops (the same per-hop smoothing).
function stepResponse(s){
 const hopS=hop/fs,a=Math.max(.005,Math.min(1,hopS/Math.max(.005,s.attack/1000))),r=Math.max(.005,Math.min(1,hopS/Math.max(.015,s.release/1000))),holdS=s['peak-hold']/1000;
 const pre=.04,on=Math.max(.2,s.attack/1000*4),post=Math.max(.25,s.release/1000*4)+holdS,steps=Math.ceil((pre+on+post)/hopS);
 const out=[];let y=0,hold=0,rise63=null,rise90=null,fall=null,peak=0;
 for(let i=0;i<steps;i++){
  const t=i*hopS,x=t>=pre&&t<pre+on?1:0;
  // dsp.cpp envelope(): attack, or hold the peak, then release.
  if(x>y){y+=(x-y)*a;hold=holdS;}else if(hold>0)hold-=hopS;else y+=(x-y)*r;
  out.push(y);
  if(x){peak=y;if(rise63===null&&y>=.632)rise63=t+hopS-pre;if(rise90===null&&y>=.9)rise90=t+hopS-pre;}
  else if(t>=pre+on&&fall===null&&y<=peak*.368)fall=t+hopS-pre-on;
 }
 return {out,hopS,pre,on,total:steps*hopS,rise63,rise90,fall};
}
function drawEnvelope(ctx,W,H,s){
 const g=DSP.group,color=GROUP_COLORS[g],side=W>=560;
 const live=side?plotBox(12,24,W*.62-18,H-46):plotBox(12,24,W-24,H*.52-30);
 const stepOuter=side?plotBox(W*.62+14,24,W*.38-26,H-46):plotBox(12,H*.52+22,W-24,H*.48-44);
 // The readouts get their own strip above the response.
 const stepB=plotBox(stepOuter.x,stepOuter.y+36,stepOuter.w,stepOuter.h-36);
 dspText(ctx,`${GROUP_NAMES[g]} level · last 5 s`,live.x,13,{color:DSP_COLORS.text2,weight:600});
 timeGrid(ctx,live);
 drawSeries(ctx,live,DSP_HIST.output[g],v=>v,{color,width:2,fill:color+'2e'});
 drawSeries(ctx,live,DSP_HIST.target[g],v=>v,{color:'rgba(233,237,243,.6)',width:1});
 waitingText(ctx,live);dspFrame(ctx,live);timeLabels(ctx,live);
 dspLegend(ctx,live.x+8,live.y+16,[['rgba(233,237,243,.6)','level now'],[color,'after attack / release']]);
 // A sound that starts and stops.
 const R=stepResponse(s),T=t=>stepB.x+t/R.total*stepB.w;
 dspText(ctx,'A sound starts and stops',stepB.x,side?13:stepOuter.y-6,{color:DSP_COLORS.text2,weight:600});
 ctx.strokeStyle=DSP_COLORS.grid;ctx.beginPath();for(const v of [.368,.632]){const y=Math.round(stepB.Y(v))+.5;ctx.moveTo(stepB.x,y);ctx.lineTo(stepB.x+stepB.w,y);}ctx.stroke();
 dspText(ctx,'63%',stepB.x+stepB.w-3,stepB.Y(.632)-3,{align:'right'});dspText(ctx,'37%',stepB.x+stepB.w-3,stepB.Y(.368)-3,{align:'right'});
 ctx.strokeStyle=DSP_COLORS.text;ctx.lineWidth=1.2;ctx.setLineDash([4,3]);ctx.beginPath();
 ctx.moveTo(stepB.x,stepB.Y(0));ctx.lineTo(T(R.pre),stepB.Y(0));ctx.lineTo(T(R.pre),stepB.Y(1));ctx.lineTo(T(R.pre+R.on),stepB.Y(1));ctx.lineTo(T(R.pre+R.on),stepB.Y(0));ctx.lineTo(stepB.x+stepB.w,stepB.Y(0));
 ctx.stroke();ctx.setLineDash([]);
 // The output holds its value for a whole hop: drawn as steps.
 ctx.beginPath();ctx.moveTo(stepB.x,stepB.Y(0));
 R.out.forEach((v,i)=>{ctx.lineTo(T(i*R.hopS),stepB.Y(v));ctx.lineTo(T((i+1)*R.hopS),stepB.Y(v));});
 ctx.lineTo(stepB.x+stepB.w,stepB.Y(0));ctx.closePath();ctx.fillStyle=color+'2e';ctx.fill();
 ctx.beginPath();R.out.forEach((v,i)=>{const x0=T(i*R.hopS),x1=T((i+1)*R.hopS);if(i)ctx.lineTo(x0,stepB.Y(v));else ctx.moveTo(x0,stepB.Y(v));ctx.lineTo(x1,stepB.Y(v));});
 ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();
 const ms=t=>t===null?'—':`${Math.round(t*1000)} ms`;
 dspText(ctx,`↑ attack: 63% in ${ms(R.rise63)}, 90% in ${ms(R.rise90)}`,stepOuter.x+8,stepOuter.y+15,{color:DSP_COLORS.text2});
 dspText(ctx,`↓ release: ${s['peak-hold']?`holds ${s['peak-hold']} ms, `:''}down to 37% in ${ms(R.fall)}`,stepOuter.x+8,stepOuter.y+30,{color:DSP_COLORS.text2});
 dspFrame(ctx,stepOuter);
 const tick=tickStep(R.total*1000,stepB.w);
 for(let t=0;t<=R.total*1000;t+=tick)dspText(ctx,`${t} ms`,T(t/1000),stepB.y+stepB.h+12,{align:t?'center':'left'});
 return R;
}

// Onsets: the group's energy rise (flux) against its adaptive threshold, the
// hits it fired with their hold-off, the flash they trigger and, when there
// is room, how far apart the last hits were.
function hitIntervals(g){
 const log=DSP_HIST.hits[g],out=[];
 for(let i=1;i<log.length;i++){const d=log[i]-log[i-1];if(d>0&&d<2)out.push(d);} // a pause or a seek is not an interval
 return out;
}
function drawOnsets(ctx,W,H,s){
 const g=DSP.group,color=GROUP_COLORS[g],H_=DSP_HIST,flashH=Math.max(26,Math.min(60,H*.16)),side=W>=640?Math.min(280,W*.3):0;
 const b=plotBox(12,24,W-24-side,H-24-flashH-40),flash=plotBox(12,b.y+b.h+22,W-24-side,flashH);
 let maxFlux=0,maxThr=0,hits=0;
 for(let j=0;j<H_.filled;j++){maxFlux=Math.max(maxFlux,histAt(H_.flux[g],j));maxThr=Math.max(maxThr,histAt(H_.threshold[g],j));hits+=histAt(H_.event[g],j);}
 // Spikes may leave the top so the threshold stays readable.
 const top=Math.max(.2,maxThr*1.6,Math.min(maxFlux,maxThr*3))*1.05,map=v=>v/top,holdoff=s[`holdoff-${g}`]/1000;
 dspText(ctx,`${GROUP_NAMES[g]} onsets · last 5 s`,b.x,13,{color:DSP_COLORS.text2,weight:600});
 dspText(ctx,`${hits} hit${hits===1?'':'s'}`,b.x+b.w,13,{align:'right',color});
 timeGrid(ctx,b);
 ctx.save();ctx.beginPath();ctx.rect(b.x,b.y,b.w,b.h);ctx.clip();
 const dx=b.w/(DSP_LEN-1),refractory=holdoff/DSP_STEP*dx;
 for(let j=0;j<H_.filled;j++)if(histAt(H_.event[g],j)){
  const x=b.x+(DSP_LEN-H_.filled+j)*dx;
  ctx.fillStyle='rgba(138,147,163,.12)';ctx.fillRect(x,b.y,refractory,b.h);
 }
 drawSeries(ctx,b,H_.flux[g],map,{color,width:1.5,fill:color+'38'});
 drawSeries(ctx,b,H_.threshold[g],map,{color:DSP_COLORS.warn,width:1.5,dash:[5,3]});
 for(let j=0;j<H_.filled;j++)if(histAt(H_.event[g],j)){
  const x=Math.round(b.x+(DSP_LEN-H_.filled+j)*dx)+.5;
  ctx.strokeStyle=DSP_COLORS.text2;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(x,b.y);ctx.lineTo(x,b.y+b.h);ctx.stroke();
  ctx.fillStyle=DSP_COLORS.text2;ctx.beginPath();ctx.arc(x,b.y+5,3.5,0,Math.PI*2);ctx.fill();
 }
 ctx.restore();
 waitingText(ctx,b);dspFrame(ctx,b);
 if(b.w>=420)dspLegend(ctx,b.x+150,13,[[color,'energy rise (flux)'],[DSP_COLORS.warn,'threshold',true],[DSP_COLORS.text2,'hit']]);
 dspText(ctx,'Flash it triggers',flash.x,flash.y-5,{color:DSP_COLORS.text2,weight:600});
 timeGrid(ctx,flash);
 drawSeries(ctx,flash,H_.pulse[g],v=>v,{color,width:1.5,fill:color+'55'});
 dspFrame(ctx,flash);timeLabels(ctx,flash);
 // Time between hits: a pile-up at the hold-off means it cuts real hits,
 // a cluster far below the beat means double triggers.
 const intervals=hitIntervals(g),[median]=quantiles(intervals,[.5]);
 if(side){
  const ib=plotBox(W-12-side+18,24,side-18,b.h),BIN=.025,MAX=1,bins=new Array(MAX/BIN).fill(0);
  for(const v of intervals)bins[Math.min(bins.length-1,Math.floor(v/BIN))]++;
  const peak=Math.max(1,...bins),X=t=>ib.x+Math.min(1,t/MAX)*ib.w;
  dspText(ctx,'Time between hits',ib.x,13,{color:DSP_COLORS.text2,weight:600});
  ctx.fillStyle='rgba(138,147,163,.12)';ctx.fillRect(ib.x,ib.y,X(holdoff)-ib.x,ib.h);
  bins.forEach((c,i)=>{if(!c)return;const h=c/peak*(ib.h-18);ctx.fillStyle=color;ctx.fillRect(X(i*BIN)+.5,ib.y+ib.h-h,Math.max(1,ib.w*BIN/MAX-1),h);});
  ctx.strokeStyle=DSP_COLORS.warn;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(Math.round(X(holdoff))+.5,ib.y);ctx.lineTo(Math.round(X(holdoff))+.5,ib.y+ib.h);ctx.stroke();ctx.setLineDash([]);
  dspText(ctx,`hold-off ${Math.round(holdoff*1000)} ms`,X(holdoff)+4,ib.y+13,{color:DSP_COLORS.warn,size:9.5});
  if(intervals.length){const mx=Math.round(X(median))+.5;ctx.strokeStyle=DSP_COLORS.text2;ctx.beginPath();ctx.moveTo(mx,ib.y+18);ctx.lineTo(mx,ib.y+ib.h);ctx.stroke();}
  dspFrame(ctx,ib);
  for(const t of [0,250,500,750,1000])dspText(ctx,t?`${t}`:'0 ms',X(t/1000),ib.y+ib.h+12,{align:t?t===1000?'right':'center':'left'});
  dspText(ctx,intervals.length?`median ${Math.round(median*1000)} ms · ${Math.round(60/median)} per min`:'no intervals yet',ib.x,flash.y+12,{color:DSP_COLORS.text2});
  if(intervals.length)dspText(ctx,`from the last ${intervals.length+1} hits`,ib.x,flash.y+28);
 }
 return {hits,median:intervals.length?median:0,count:side?intervals.length:0};
}

// Noise: each band's level now with the noise floor (and the adaptive floor
// learned per band) that is subtracted before anything else.
function drawNoise(ctx,W,H,s,d){
 const mem=d.memory.buffer,raw=new Float32Array(mem,d.new_raw_ptr(),16),floor=new Float32Array(mem,d.new_floor_ptr(),16);
 const ref=Math.max(.003,new Float32Array(mem,d.new_metrics_ptr(),10)[5]),gate=noiseGate(s),adaptive=adaptiveAmount(s);
 const LO=-84,HI=-12,b=plotBox(40,24,W-52,H-24-34),Yd=v=>b.Y(dbNorm(v,LO,HI)),bw=b.w/16,{lo,hi}=frequencyRange(s),gb=groupBands(d);
 dspText(ctx,'Band levels now, dB',b.x,13,{color:DSP_COLORS.text2,weight:600});
 ctx.strokeStyle=DSP_COLORS.grid;ctx.lineWidth=1;ctx.beginPath();
 for(let db=LO;db<=HI;db+=12){const y=Math.round(b.Y((db-LO)/(HI-LO)))+.5;ctx.moveTo(b.x,y);ctx.lineTo(b.x+b.w,y);}
 ctx.stroke();
 for(let db=LO;db<=HI;db+=12)dspText(ctx,`${db<0?'−':''}${Math.abs(db)}`,b.x-5,b.Y((db-LO)/(HI-LO))+3.5,{align:'right'});
 let silent=0;
 for(let k=0;k<16;k++){
  const x=b.x+k*bw+Math.max(1,bw*.12),w=Math.max(2,bw*.76),cut=gate+floor[k]*adaptive,yRaw=Yd(raw[k]),yCut=Yd(cut),bottom=b.y+b.h;
  ctx.fillStyle='rgba(138,147,163,.35)';ctx.fillRect(x,Math.max(yRaw,yCut),w,bottom-Math.max(yRaw,yCut));
  if(raw[k]>cut){ctx.fillStyle=GROUP_COLORS[bandGroup(k,gb)];ctx.fillRect(x,yRaw,w,yCut-yRaw);}else silent++;
  // The background this band has learned; Adaptive floor removes that share of it.
  ctx.strokeStyle='rgba(233,237,243,.55)';ctx.setLineDash([2,2]);ctx.beginPath();ctx.moveTo(x,Math.round(Yd(floor[k]))+.5);ctx.lineTo(x+w,Math.round(Yd(floor[k]))+.5);ctx.stroke();ctx.setLineDash([]);
  if(adaptive>0){ctx.strokeStyle=DSP_COLORS.warn;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x-1,yCut);ctx.lineTo(x+w+1,yCut);ctx.stroke();ctx.lineWidth=1;}
  if(bw>=30||k%2===0)dspText(ctx,shortHz(lo*Math.pow(hi/lo,(k+.5)/16)),x+w/2,bottom+12,{align:'center'});
 }
 dspText(ctx,'Hz',b.x+b.w,b.y+b.h+24,{align:'right'});
 const gy=Math.round(Yd(gate))+.5;
 ctx.strokeStyle=DSP_COLORS.warn;ctx.lineWidth=1.5;ctx.setLineDash([5,3]);ctx.beginPath();ctx.moveTo(b.x,gy);ctx.lineTo(b.x+b.w,gy);ctx.stroke();ctx.setLineDash([]);
 dspText(ctx,`noise floor ${formatDb(gate)}`,b.x+b.w-4,gy-5,{align:'right',color:DSP_COLORS.warn,bg:true});
 const ay=Math.round(Yd(ref))+.5;
 ctx.strokeStyle='rgba(90,209,160,.7)';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(b.x,ay);ctx.lineTo(b.x+b.w,ay);ctx.stroke();ctx.setLineDash([]);
 dspText(ctx,'average level (AGC)',b.x+4,ay-5,{color:DSP_COLORS.live,bg:true});
 dspFrame(ctx,b);
 dspLegend(ctx,Math.max(b.x+120,b.x+b.w-330),13,[['rgba(233,237,243,.55)','learned background',true],...(adaptive>0?[[DSP_COLORS.warn,'cut with adaptive floor']]:[])]);
 return {silent};
}
// Helpers of the views across settings: history as an array, its quantiles,
// a quantile range drawn as a bar, wrapped text.
function histValues(arr){const n=DSP_HIST.filled,out=new Float32Array(n);for(let j=0;j<n;j++)out[j]=histAt(arr,j);return out;}
function quantiles(values,qs){
 if(!values.length)return qs.map(()=>0);
 const v=Float32Array.from(values).sort();return qs.map(q=>v[Math.min(v.length-1,Math.floor(q*(v.length-1)))]);
}
const pct=v=>`${Math.round(v*100)}%`;
function rangeBar(ctx,x,b,lo,hi,color){
 ctx.fillStyle='rgba(138,147,163,.18)';ctx.fillRect(x,b.y,8,b.h);
 ctx.fillStyle=color;ctx.fillRect(x,b.Y(hi),8,Math.max(2,b.Y(lo)-b.Y(hi)));
}
function wrapText(ctx,text,x,y,width,lineH,opts){
 ctx.font=`${opts?.weight||''} ${opts?.size||10.5}px system-ui,sans-serif`;
 let line='';
 for(const word of text.split(' ')){
  const next=line?line+' '+word:word;
  if(ctx.measureText(next).width>width&&line){dspText(ctx,line,x,y,opts);y+=lineH;line=word;}else line=next;
 }
 if(line)dspText(ctx,line,x,y,opts);
 return y+lineH;
}
// A dB scale over the values of the window, at most `span` dB tall.
function dbWindow(arrays,span){
 let mx=-Infinity,mn=Infinity;
 for(const a of arrays)for(let j=0;j<DSP_HIST.filled;j++){const v=toDb(Math.max(1e-6,histAt(a,j)));mx=Math.max(mx,v);mn=Math.min(mn,v);}
 if(!Number.isFinite(mx)){mx=-24;mn=-72;}
 const hi=mx+3,lo=Math.max(mn-3,hi-span);
 return v=>(toDb(Math.max(1e-6,v))-lo)/Math.max(12,hi-lo);
}

// Chain: one group's signal after every stage, on one time axis; the bar at
// the right is the range the stage uses (5–95 % of the time).
function drawChain(ctx,W,H,s){
 const g=DSP.group,color=GROUP_COLORS[g],Hs=DSP_HIST,statW=W>=480?96:0,gap=16,top=24,laneH=Math.max(30,(H-top-18-gap*3)/4);
 const lane=i=>plotBox(12,top+i*(laneH+gap),W-24-statW,laneH),sx=W-12-statW+12;
 dspText(ctx,`${GROUP_NAMES[g]} through the analyzer · last 5 s`,12,13,{color:DSP_COLORS.text2,weight:600});
 const stat=(b,title,value)=>{if(!statW)return;dspText(ctx,title,sx+14,b.y+10);dspText(ctx,value,sx+14,b.y+24,{color:DSP_COLORS.text2,weight:600});};
 // Narrow: short names with the readout instead of the column.
 const label=(b,[long,short],extra)=>dspText(ctx,statW?long:`${short} · ${extra}`,b.x+6,b.y+13,{color:DSP_COLORS.text2,bg:true});
 // 1. Input against the noise floor that is subtracted from it.
 const L1=lane(0),map1=dbWindow([Hs.raw[g],Hs.cut[g]],60);
 timeGrid(ctx,L1);
 drawSeries(ctx,L1,Hs.raw[g],map1,{color,width:1.5,fill:color+'22'});
 drawSeries(ctx,L1,Hs.cut[g],map1,{color:DSP_COLORS.warn,width:1.5,dash:[5,3]});
 let above=0;for(let j=0;j<Hs.filled;j++)if(histAt(Hs.raw[g],j)>histAt(Hs.cut[g],j))above++;
 const aboveText=Hs.filled?pct(above/Hs.filled):'—';
 dspFrame(ctx,L1);label(L1,['1 · Input, dB — and the noise floor (dashed)','1 · Input'],`above floor ${aboveText}`);
 if(statW){rangeBar(ctx,sx,L1,0,Hs.filled?above/Hs.filled:0,DSP_COLORS.warn);stat(L1,'above floor',aboveText);}
 // 2–3. The level curve, then the envelope: what the LEDs show.
 for(const [i,arr,text] of [[1,Hs.target[g],['2 · After shaping and the level curve — Tilt, Balance, Sensitivity, Compression, AGC','2 · Level curve']],[2,Hs.output[g],['3 · After the envelope = LEDs — Attack, Release','3 · Envelope = LEDs']]]){
  const L=lane(i),[lo,mid,hi]=quantiles(histValues(arr),[.05,.5,.95]);
  timeGrid(ctx,L);drawSeries(ctx,L,arr,v=>v,{color,width:1.5,fill:color+(i===2?'44':'22')});
  dspFrame(ctx,L);label(L,text,`uses ${pct(lo)}–${pct(hi)}`);
  if(statW){rangeBar(ctx,sx,L,lo,hi,color);ctx.fillStyle=DSP_COLORS.text2;ctx.fillRect(sx-2,L.Y(mid)-1,12,2);stat(L,'range used',`${pct(lo)}–${pct(hi)}`);}
 }
 // 4. Hits and the flash they trigger.
 const L4=lane(3);let hits=0;
 timeGrid(ctx,L4);drawSeries(ctx,L4,Hs.pulse[g],v=>v,{color,width:1.5,fill:color+'55'});
 for(let j=0;j<Hs.filled;j++)if(histAt(Hs.event[g],j)){hits++;const x=Math.round(L4.x+(DSP_LEN-Hs.filled+j)/(DSP_LEN-1)*L4.w)+.5;ctx.strokeStyle=DSP_COLORS.text2;ctx.beginPath();ctx.moveTo(x,L4.y);ctx.lineTo(x,L4.y+L4.h);ctx.stroke();}
 dspFrame(ctx,L4);label(L4,['4 · Hits and flash — Onset threshold','4 · Hits'],`${hits} in 5 s`);timeLabels(ctx,L4);
 if(statW)stat(L4,'hits in 5 s',String(hits));
 waitingText(ctx,lane(1));
 return {hits};
}

// Map: all 16 bands over time before the analyzer (dB) and as the LEDs get
// them, and how often each LED level occurs.
const MAP_LUT=(()=>{
 const stops=[[0,[7,8,11]],[.22,[34,38,104]],[.45,[76,88,201]],[.7,[142,155,255]],[.88,[214,196,255]],[1,[255,255,255]]],lut=new Uint8ClampedArray(256*3);
 for(let i=0;i<256;i++){
  const t=i/255,k=stops.findIndex(([p])=>p>=t),[p1,c1]=stops[Math.max(1,k)],[p0,c0]=stops[Math.max(0,k-1)],f=p1>p0?(t-p0)/(p1-p0):0;
  for(let c=0;c<3;c++)lut[i*3+c]=c0[c]+(c1[c]-c0[c])*f;
 }
 return lut;
})();
const mapColor=v=>{const i=Math.max(0,Math.min(255,Math.round(v*255)))*3;return `rgb(${MAP_LUT[i]},${MAP_LUT[i+1]},${MAP_LUT[i+2]})`;};
function heatmap(ctx,b,data,map){
 const off=DSP.mapCanvas||(DSP.mapCanvas=Object.assign(document.createElement('canvas'),{width:DSP_LEN,height:16}));
 const octx=off.getContext('2d'),img=octx.createImageData(DSP_LEN,16),Hs=DSP_HIST;
 for(let k=0;k<16;k++)for(let x=0;x<DSP_LEN;x++){
  const j=x-(DSP_LEN-Hs.filled),o=((15-k)*DSP_LEN+x)*4;
  const v=j<0?0:map(data[k*DSP_LEN+(Hs.pos-Hs.filled+j+DSP_LEN)%DSP_LEN]),i=Math.max(0,Math.min(255,Math.round(v*255)))*3;
  img.data[o]=MAP_LUT[i];img.data[o+1]=MAP_LUT[i+1];img.data[o+2]=MAP_LUT[i+2];img.data[o+3]=255;
 }
 octx.putImageData(img,0,0);
 ctx.imageSmoothingEnabled=false;ctx.drawImage(off,b.x,b.y,b.w,b.h);ctx.imageSmoothingEnabled=true;
}
function drawMap(ctx,W,H,s){
 const Hs=DSP_HIST,wide=W>=600,{lo,hi}=frequencyRange(s),left=40;
 const mapsW=wide?W*.66-left:W-left-12,mapsH=wide?H-24-22:H*.58-24-12,mh=(mapsH-20)/2;
 const top=plotBox(left,24,mapsW,mh),bottom=plotBox(left,24+mh+20,mapsW,mh);
 let mx=-Infinity;for(let i=0;i<Hs.rawBands.length;i++)if(Hs.rawBands[i]>0)mx=Math.max(mx,toDb(Hs.rawBands[i]));
 if(!Number.isFinite(mx))mx=-24;
 heatmap(ctx,top,Hs.rawBands,v=>(toDb(Math.max(1e-6,v))-(mx-48))/48);
 heatmap(ctx,bottom,Hs.bands,v=>v);
 dspText(ctx,'Input, dB (top 48 dB of the window)',top.x,top.y-6,{color:DSP_COLORS.text2,weight:600});
 dspText(ctx,'LED level',bottom.x,bottom.y-6,{color:DSP_COLORS.text2,weight:600});
 for(const b of [top,bottom]){
  dspFrame(ctx,b);
  const gb=groupBands();
 for(const k of [0,gb[1][0],gb[2][0],15])dspText(ctx,shortHz(lo*Math.pow(hi/lo,(k+.5)/16)),b.x-5,b.y+(15.5-k)/16*b.h+3.5,{align:'right'});
 }
 timeLabels(ctx,bottom);
 // How often each LED level occurs (every band, every step of the window).
 const values=Hs.bands.length&&Hs.filled?(()=>{const out=new Float32Array(16*Hs.filled);let n=0;for(let k=0;k<16;k++)for(let j=0;j<Hs.filled;j++)out[n++]=Hs.bands[k*DSP_LEN+(Hs.pos-Hs.filled+j+DSP_LEN)%DSP_LEN];return out;})():new Float32Array(0);
 const bins=new Array(20).fill(0);for(const v of values)bins[Math.min(19,Math.floor(Math.max(0,v)*20))]++;
 const peak=Math.max(1,...bins),hb=wide?plotBox(W*.66+18,24,W*.34-30,H*.55):plotBox(left,H*.58+18,W*.5-left,H*.42-50);
 dspText(ctx,'How often each LED level occurs',hb.x,hb.y-6,{color:DSP_COLORS.text2,weight:600});
 // Bars keep the map's colors, lifted so the darkest stay visible.
 bins.forEach((c,i)=>{const x=hb.x+i/20*hb.w,h=c/peak*hb.h;ctx.fillStyle=mapColor(.3+.7*(i+.5)/20);ctx.fillRect(x+.5,hb.y+hb.h-h,hb.w/20-1,h);});
 dspFrame(ctx,hb);
 for(const v of [0,.5,1])dspText(ctx,pct(v),hb.X(v),hb.y+hb.h+12,{align:v?v===1?'right':'center':'left'});
 let dark=0,bright=0;for(const v of values){if(v<.05)dark++;else if(v>.6)bright++;}
 const [q5,q50,q95]=quantiles(values,[.05,.5,.95]),n=Math.max(1,values.length);
 const lines=values.length?[`dark (< 5%): ${pct(dark/n)} of the time`,`bright (> 60%): ${pct(bright/n)}`,`median ${pct(q50)} · 5–95%: ${pct(q5)}–${pct(q95)}`]:['Play something to see the levels'];
 const tx=wide?hb.x:W*.5+12,ty=wide?hb.y+hb.h+34:hb.y+8;
 lines.forEach((t,i)=>dspText(ctx,t,tx,ty+i*16,{color:i?DSP_COLORS.text2:DSP_COLORS.text2}));
 return {dark:dark/n,bright:bright/n,count:values.length};
}

// Bands: for each band, its average input against the reference it is
// normalised to (Tilt and Band balance move it) and the LED levels it used.
function drawBands(ctx,W,H,s,d){
 const mem=d.memory.buffer,Hs=DSP_HIST,n=Hs.filled,gb=groupBands(d),{lo,hi}=frequencyRange(s),plan=specPlan(s.fft),ny=plan.ny;
 const tilt=new Float32Array(mem,d.new_tilt_ptr(),16),bandRef=new Float32Array(mem,d.new_band_ref_ptr(),16),ref=Math.max(.003,new Float32Array(mem,d.new_metrics_ptr(),10)[5]);
 const left=40,right=W>=420?34:12,topH=Math.max(56,(H-24-76)*.42),top=plotBox(left,24,W-left-right,topH),bot=plotBox(left,top.y+top.h+30,W-left-right,Math.max(50,H-(top.y+top.h+30)-46)),bw=top.w/16;
 const at=(k,j)=>(Hs.pos-n+j+DSP_LEN)%DSP_LEN+k*DSP_LEN,edgeHz=i=>lo*Math.pow(hi/lo,i/16);
 const splits=ctx2=>{ctx.strokeStyle=DSP_COLORS.axis;ctx.setLineDash([3,3]);ctx.beginPath();for(const i of [gb[1][0],gb[2][0]]){const x=Math.round(ctx2.x+i*bw)+.5;ctx.moveTo(x,ctx2.y);ctx.lineTo(x,ctx2.y+ctx2.h);}ctx.stroke();ctx.setLineDash([]);};
 // 1. The music's spectrum over the last 3 s (power average of the
 // spectrogram rows) before and after what shapes the bands: tilt and the
 // group trims (the fixed equalizer) and Band balance (adaptive, per band).
 const trim=[s['eq-bass'],s['eq-mid'],s['eq-high']],balanced=s.balance>0;
 const eqDb=b=>toDb(tilt[b])+trim[bandGroup(b,gb)],balDb=b=>balanced?toDb(ref/Math.max(1e-6,bandRef[b])):0;
 const FX=f=>top.x+Math.log(f/lo)/Math.log(hi/lo)*top.w,bandOf=f=>Math.max(0,Math.min(15,Math.floor(16*Math.log(f/lo)/Math.log(hi/lo))));
 const cols=Math.min(n,Math.round(3/DSP_STEP)),music=[];let peak=-200;
 for(let r=0;r<SPEC_ROWS&&cols>1;r++){
  const f=20*Math.pow(ny/20,(r+.5)/SPEC_ROWS);if(f<lo||f>hi)continue;
  let sum=0;for(let j=n-cols;j<n;j++)sum+=Math.pow(10,Hs.spec[at(r,j)]/10);
  const db=10*Math.log10(sum/cols+1e-14),b=bandOf(f),after=db+eqDb(b)+balDb(b);
  music.push([FX(f),db,after]);peak=Math.max(peak,db,after);
 }
 const DHI=peak>-130?Math.ceil((peak+4)/12)*12:-12,DLO=DHI-60,Yd=db=>top.Y((db-DLO)/(DHI-DLO)),Ye=db=>top.Y((db+24)/48);
 dspText(ctx,W>=520?'Spectrum and the equalizer · last 3 s':'Spectrum and EQ · 3 s',top.x,13,{color:DSP_COLORS.text2,weight:600});
 if(W>=620){
  ctx.font='10.5px system-ui,sans-serif';
  const items=[[DSP_COLORS.text,'music'],[DSP_COLORS.live,balanced?'after EQ and balance':'after EQ'],[DSP_COLORS.accent,'EQ, right axis',true]];
  const width=items.reduce((a,[,label])=>a+32+ctx.measureText(label).width,0)-14;
  dspLegend(ctx,top.x+top.w-width,13,items);
 }
 // Group regions with their band counts.
 for(let g=0;g<3;g++){
  const [a,b]=gb[g],x0=top.x+a*bw,x1=top.x+b*bw,label=`${GROUP_NAMES[g]} · ${b-a}`;
  ctx.fillStyle=GROUP_COLORS[g];ctx.globalAlpha=.07;ctx.fillRect(x0,top.y,x1-x0,top.h);ctx.globalAlpha=1;
  ctx.font='10px system-ui,sans-serif';
  if(ctx.measureText(label).width<x1-x0-8)dspText(ctx,label,x0+5,top.y+12,{color:GROUP_COLORS[g],size:10});
 }
 ctx.strokeStyle=DSP_COLORS.grid;ctx.lineWidth=1;ctx.beginPath();
 for(let db=DHI-12;db>DLO;db-=12){const y=Math.round(Yd(db))+.5;ctx.moveTo(top.x,y);ctx.lineTo(top.x+top.w,y);}
 for(const f of [50,100,200,500,1000,2000,5000,10000])if(f>lo*1.05&&f<hi/1.05){const x=Math.round(FX(f))+.5;ctx.moveTo(x,top.y);ctx.lineTo(x,top.y+top.h);}
 ctx.stroke();
 for(let db=DHI-12;db>DLO;db-=12)dspText(ctx,`${db<0?'−':''}${Math.abs(db)}`,top.x-5,Yd(db)+3.5,{align:'right'});
 splits(top);
 const line=(k,color,width,dash)=>{
  if(music.length<2)return;
  ctx.beginPath();music.forEach((m,i)=>{const y=Yd(m[k]);if(i)ctx.lineTo(m[0],y);else ctx.moveTo(m[0],y);});
  ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineJoin='round';ctx.setLineDash(dash||[]);ctx.stroke();ctx.setLineDash([]);ctx.lineWidth=1;
 };
 ctx.save();ctx.beginPath();ctx.rect(top.x,top.y,top.w,top.h);ctx.clip();
 line(1,'rgba(138,147,163,.7)',3);line(2,DSP_COLORS.live,1.5); // grey wider: it shows where both match
 // The equalizer per band on the right axis (±24 dB): dashed the fixed part,
 // dotted with the balance the analyzer applies right now.
 const steps=(fn,color,dash)=>{
  ctx.beginPath();
  for(let b=0;b<16;b++){const y=Math.round(Ye(fn(b)))+.5;if(b)ctx.lineTo(top.x+b*bw,y);else ctx.moveTo(top.x,y);ctx.lineTo(top.x+(b+1)*bw,y);}
  ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.setLineDash(dash);ctx.stroke();ctx.setLineDash([]);ctx.lineWidth=1;
 };
 steps(eqDb,DSP_COLORS.accent,[5,3]);
 if(balanced&&n>1)steps(b=>eqDb(b)+balDb(b),'rgba(142,155,255,.6)',[1.5,2.5]);
 ctx.restore();
 if(right>12)for(const db of [-12,0,12])dspText(ctx,`${db>0?'+':db<0?'−':''}${Math.abs(db)}`,top.x+top.w+5,Ye(db)+3.5,{color:DSP_COLORS.accent,size:9.5});
 waitingText(ctx,top);dspFrame(ctx,top);
 // 2. LED level per band: whiskers 5–95 %, box 25–75 %, median, now.
 dspText(ctx,'LED level per band · last 5 s',bot.x,bot.y-8,{color:DSP_COLORS.text2,weight:600});
 ctx.strokeStyle=DSP_COLORS.grid;ctx.beginPath();for(const v of [.25,.5,.75]){const y=Math.round(bot.Y(v))+.5;ctx.moveTo(bot.x,y);ctx.lineTo(bot.x+bot.w,y);}ctx.stroke();
 for(const v of [0,.5,1])dspText(ctx,pct(v),bot.x-5,bot.Y(v)+3.5,{align:'right'});
 splits(bot);
 let dead=0,pinned=0,flat=0;const last=(Hs.pos-1+DSP_LEN)%DSP_LEN,vals=new Float32Array(n);
 for(let k=0;k<16&&n>1;k++){
  for(let j=0;j<n;j++)vals[j]=Hs.bands[at(k,j)];
  const [q5,q25,q50,q75,q95]=quantiles(vals,[.05,.25,.5,.75,.95]),cx=bot.x+(k+.5)*bw,w=Math.max(3,bw*.56),color=GROUP_COLORS[bandGroup(k,gb)];
  if(q95<.1)dead++;else if(q5>.8)pinned++;else if(q95-q5<.15)flat++;
  ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(Math.round(cx)+.5,bot.Y(q95));ctx.lineTo(Math.round(cx)+.5,bot.Y(q5));ctx.stroke();
  ctx.fillStyle=color+'66';ctx.fillRect(cx-w/2,bot.Y(q75),w,Math.max(1.5,bot.Y(q25)-bot.Y(q75)));ctx.strokeRect(cx-w/2+.5,bot.Y(q75)+.5,w-1,Math.max(1,bot.Y(q25)-bot.Y(q75)-1));
  ctx.fillStyle='#e9edf3';ctx.fillRect(cx-w/2,Math.round(bot.Y(q50))-1,w,2);
  ctx.fillStyle=color;ctx.beginPath();ctx.arc(cx,bot.Y(Hs.bands[k*DSP_LEN+last]),2.6,0,Math.PI*2);ctx.fill();
  if(q95<.1){ctx.strokeStyle='rgba(240,180,90,.4)';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.strokeRect(Math.round(cx-w/2)-1.5,bot.y+2.5,Math.round(w)+3,bot.h-5);ctx.setLineDash([]);}
  ctx.lineWidth=1;
 }
 waitingText(ctx,bot);dspFrame(ctx,bot);
 const issues=[dead&&`${dead} never light`,pinned&&`${pinned} always bright`,flat&&`${flat} barely move`].filter(Boolean);
 dspText(ctx,n>1?(issues.length?issues.join(' · '):'every band moves'):'',bot.x+bot.w,bot.y-8,{align:'right',color:issues.length?DSP_COLORS.warn:DSP_COLORS.live});
 // The center of every band (every other one when narrow), then the groups.
 const every=bw>=26?1:bw>=13?2:4;
 for(let k=0;k<16;k+=every)dspText(ctx,shortHz(Math.sqrt(edgeHz(k)*edgeHz(k+1))),bot.x+(k+.5)*bw,bot.y+bot.h+11,{align:'center',size:9});
 for(let g=0;g<3;g++){
  const [a,b]=gb[g],x0=bot.x+a*bw+2,x1=bot.x+b*bw-2,y=bot.y+bot.h+18;
  ctx.fillStyle=GROUP_COLORS[g];ctx.fillRect(x0,y,Math.max(2,x1-x0),3);
  const long=`${GROUP_NAMES[g]} ${shortHz(edgeHz(a))}–${shortHz(edgeHz(b))} Hz`;
  ctx.font='10.5px system-ui,sans-serif';
  const label=ctx.measureText(long).width<x1-x0?long:ctx.measureText(GROUP_NAMES[g]).width<x1-x0?GROUP_NAMES[g]:'';
  if(label)dspText(ctx,label,(x0+x1)/2,y+16,{align:'center',color:GROUP_COLORS[g]});
 }
 return {dead,pinned,flat,filled:n>1};
}

// Tempo: the onset strength the tracker hears, the periodicity it finds at
// every beat length of the tempo range, and the beat it predicts.
function drawTempo(ctx,W,H,s,d){
 const mem=d.memory.buffer,Hs=DSP_HIST,metrics=new Float32Array(mem,d.new_metrics_ptr(),10),bpm=metrics[6],conf=metrics[7],phase=metrics[8],pulse=metrics[9];
 const ring=new Float32Array(mem,d.new_novelty_ptr(),256),head=d.new_novelty_head(),scores=new Float32Array(mem,d.new_tempo_scores_ptr(),128),info=new Float32Array(mem,d.new_tempo_info_ptr(),4);
 const wide=W>=620,colW=wide?Math.round(W*.58):W;
 const nov=wide?plotBox(12,24,colW-24,(H-24-40)*.6):plotBox(12,24,W-24,Math.max(50,(H-24)*.32));
 const hist=wide?plotBox(12,nov.y+nov.h+40,colW-24,Math.max(30,H-(nov.y+nov.h+40)-20)):null;
 const per=wide?plotBox(colW+12,24,W-colW-24,(H-24-40)*.56):plotBox(12,nov.y+nov.h+30,W-24,Math.max(50,(H-24)*.3));
 const locked=bpm>0&&conf>BEAT_CONFIDENCE,lockColor=locked?DSP_COLORS.live:DSP_COLORS.text;
 // 1. Onset strength over the tracker's window (3 s), predicted beats, bass hits.
 const N=NOVELTY_WINDOW;let top=.05;for(let i=0;i<N;i++)top=Math.max(top,ring[(head-N+i)&255]);top*=1.1;
 dspText(ctx,'Onset strength the tempo tracker hears · last 3 s',nov.x,13,{color:DSP_COLORS.text2,weight:600});
 ctx.strokeStyle=DSP_COLORS.grid;ctx.beginPath();for(let t=1;t<3;t++){const x=Math.round(nov.x+nov.w-t/(N*NOVELTY_STEP)*nov.w)+.5;ctx.moveTo(x,nov.y);ctx.lineTo(x,nov.y+nov.h);}ctx.stroke();
 const X=i=>nov.x+i/(N-1)*nov.w;
 ctx.beginPath();ctx.moveTo(nov.x,nov.y+nov.h);for(let i=0;i<N;i++)ctx.lineTo(X(i),nov.Y(ring[(head-N+i)&255]/top));ctx.lineTo(nov.x+nov.w,nov.y+nov.h);ctx.closePath();
 ctx.fillStyle='rgba(142,155,255,.22)';ctx.fill();
 ctx.beginPath();for(let i=0;i<N;i++){const y=nov.Y(ring[(head-N+i)&255]/top);if(i)ctx.lineTo(X(i),y);else ctx.moveTo(X(i),y);}ctx.strokeStyle=DSP_COLORS.accent;ctx.lineWidth=1.5;ctx.stroke();
 const from=Math.max(0,Hs.filled-N);
 for(let j=from;j<Hs.filled;j++){
  const x=Math.round(X(N-(Hs.filled-j)))+.5;
  if(histAt(Hs.beat,j)){ctx.strokeStyle=DSP_COLORS.live;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,nov.y);ctx.lineTo(x,nov.y+nov.h);ctx.stroke();ctx.lineWidth=1;}
  if(histAt(Hs.event[0],j)){ctx.fillStyle=GROUP_COLORS[0];ctx.beginPath();ctx.arc(x,nov.y+nov.h-5,3,0,Math.PI*2);ctx.fill();}
 }
 waitingText(ctx,nov);dspFrame(ctx,nov);
 for(let t=0;t<=3;t++)dspText(ctx,t?`−${t} s`:'now',nov.x+nov.w-t/(N*NOVELTY_STEP)*nov.w,nov.y+nov.h+12,{align:t?t===3?'left':'center':'right'});
 if(nov.w>=440)dspLegend(ctx,nov.x+nov.w-210,13,[[DSP_COLORS.live,'predicted beat'],[GROUP_COLORS[0],'bass hit']]);
 // 2. Periodicity at every beat length searched, on a BPM axis.
 const lo=s['bpm-min'],hi=s['bpm-max'],XB=v=>per.x+(Math.max(40,Math.min(240,v))-40)/200*per.w,YS=v=>per.Y((v+.3)/1.3);
 dspText(ctx,'Periodicity by tempo',per.x,wide?13:per.y-8,{color:DSP_COLORS.text2,weight:600});
 ctx.fillStyle='rgba(7,8,11,.55)';ctx.fillRect(per.x,per.y,XB(lo)-per.x,per.h);ctx.fillRect(XB(hi),per.y,per.x+per.w-XB(hi),per.h);
 ctx.strokeStyle=DSP_COLORS.grid;ctx.beginPath();for(let v=60;v<=240;v+=30){const x=Math.round(XB(v))+.5;ctx.moveTo(x,per.y);ctx.lineTo(x,per.y+per.h);}const z=Math.round(YS(0))+.5;ctx.moveTo(per.x,z);ctx.lineTo(per.x+per.w,z);ctx.stroke();
 const ay=Math.round(YS(TEMPO_ACCEPT))+.5;
 ctx.strokeStyle=DSP_COLORS.warn;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(per.x,ay);ctx.lineTo(per.x+per.w,ay);ctx.stroke();ctx.setLineDash([]);
 const minLag=info[0]|0,maxLag=info[1]|0,bestLag=info[2]|0;
 if(maxLag>minLag){
  ctx.beginPath();ctx.moveTo(XB(60/(maxLag*NOVELTY_STEP)),YS(0));
  for(let lag=maxLag;lag>=minLag;lag--)ctx.lineTo(XB(60/(lag*NOVELTY_STEP)),YS(Math.max(-.3,Math.min(1,scores[lag]))));
  ctx.lineTo(XB(60/(minLag*NOVELTY_STEP)),YS(0));ctx.closePath();ctx.fillStyle='rgba(142,155,255,.25)';ctx.fill();
  ctx.beginPath();for(let lag=maxLag;lag>=minLag;lag--){const x=XB(60/(lag*NOVELTY_STEP)),y=YS(Math.max(-.3,Math.min(1,scores[lag])));if(lag===maxLag)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
  ctx.strokeStyle=DSP_COLORS.accent;ctx.lineWidth=1.5;ctx.stroke();
  if(bestLag){const bb=60/(bestLag*NOVELTY_STEP),x=XB(bb),y=YS(Math.min(1,info[3]));ctx.fillStyle=info[3]>TEMPO_ACCEPT?DSP_COLORS.live:DSP_COLORS.text;ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();
   dspText(ctx,`peak ${Math.round(bb)}`,x+(x>per.x+per.w-70?-7:7),Math.max(per.y+12,y-6),{align:x>per.x+per.w-70?'right':'left',color:DSP_COLORS.text2,bg:true});}
 }else wrapText(ctx,'Collecting 3 s of onsets…',per.x+8,per.y+per.h/2,per.w-16,14,{color:DSP_COLORS.text});
 // The tracked tempo and its octaves: a peak there means the range should exclude it.
 if(bpm>0)for(const [m,label] of [[1,''],[.5,'½×'],[2,'2×']]){
  const v=bpm*m;if(v<40||v>240)continue;const x=Math.round(XB(v))+.5;
  ctx.strokeStyle=m===1?lockColor:'rgba(188,196,208,.5)';ctx.setLineDash(m===1?[]:[3,3]);ctx.beginPath();ctx.moveTo(x,per.y);ctx.lineTo(x,per.y+per.h);ctx.stroke();ctx.setLineDash([]);
  if(label)dspText(ctx,label,x+3,per.y+per.h-5,{size:9.5});
 }
 dspFrame(ctx,per);
 for(let v=60;v<=240;v+=60)dspText(ctx,v===240?'240 BPM':String(v),XB(v),per.y+per.h+12,{align:v===240?'right':'center'});
 dspText(ctx,`accepted above ${TEMPO_ACCEPT}`,per.x+per.w-4,ay-4,{align:'right',color:DSP_COLORS.warn,size:9.5,bg:true});
 // 3. Tempo and confidence over the last 5 s.
 if(hist){
  timeGrid(ctx,hist);
  drawSeries(ctx,hist,Hs.confidence,v=>v,{color:'rgba(90,209,160,.5)',width:1,fill:'rgba(90,209,160,.12)'});
  const cy=Math.round(hist.Y(BEAT_CONFIDENCE))+.5;ctx.strokeStyle='rgba(90,209,160,.5)';ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(hist.x,cy);ctx.lineTo(hist.x+hist.w,cy);ctx.stroke();ctx.setLineDash([]);
  drawSeries(ctx,hist,Hs.bpm,v=>v>0?(v-lo)/Math.max(1,hi-lo):-1,{color:DSP_COLORS.text2,width:2});
  dspFrame(ctx,hist);timeLabels(ctx,hist);
  dspLegend(ctx,hist.x,hist.y-6,[[DSP_COLORS.text2,`tempo (${lo}–${hi} BPM)`],['rgba(90,209,160,.7)','confidence']]);
 }
 // 4. The beat phase: the pointer turns once per beat; bass hits inside the
 // shaded window re-sync it.
 const box=wide?{x:colW+12,y:per.y+per.h+28,w:W-colW-24,h:H-(per.y+per.h+28)-8}:{x:12,y:per.y+per.h+26,w:W-24,h:H-(per.y+per.h+26)-6};
 const r=Math.max(12,Math.min(46,box.h/2-6)),cx=box.x+r+6,cy=box.y+box.h/2,ang=p=>-Math.PI/2+p*Math.PI*2;
 ctx.fillStyle=GROUP_COLORS[0]+'30';ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,ang(-BEAT_LOCK),ang(BEAT_LOCK));ctx.closePath();ctx.fill();
 ctx.strokeStyle=DSP_COLORS.axis;ctx.lineWidth=2;ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.stroke();
 if(locked&&pulse>0){ctx.fillStyle=`rgba(90,209,160,${(pulse*.5).toFixed(3)})`;ctx.beginPath();ctx.arc(cx,cy,r-3,0,Math.PI*2);ctx.fill();}
 ctx.strokeStyle=lockColor;ctx.lineWidth=2.5;ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(ang(phase))*(r-4),cy+Math.sin(ang(phase))*(r-4));ctx.stroke();ctx.lineWidth=1;
 const tx=cx+r+16;
 dspText(ctx,bpm>0?`${bpm.toFixed(1)} BPM`:'— BPM',tx,cy-8,{size:18,weight:650,color:bpm>0?DSP_COLORS.text2:DSP_COLORS.text});
 dspText(ctx,`confidence ${pct(conf)} · ${locked?'beats on':`beats from ${pct(BEAT_CONFIDENCE)}`}`,tx,cy+10,{color:lockColor});
 const search=`search ${lo}–${hi} BPM over ${(N*NOVELTY_STEP).toFixed(1)} s`;
 if(box.h>=70&&(ctx.font='10.5px system-ui,sans-serif',ctx.measureText(search).width<=box.x+box.w-tx))dspText(ctx,search,tx,cy+26);
 return {bpm,conf,locked,best:bestLag?60/(bestLag*NOVELTY_STEP):0,score:info[3]};
}

// Spectrogram: the FFT over the last 5 s on a log frequency axis, with the
// analysed range, the group splits, the 16 bands and the hits of each group.
function drawSpectrogram(ctx,W,H,s,d){
 const Hs=DSP_HIST,plan=specPlan(s.fft),ny=plan.ny,{lo,hi}=frequencyRange(s),gb=groupBands(d),edgeHz=i=>lo*Math.pow(hi/lo,i/16);
 const left=40,stripW=14,hitsH=20,sp=plotBox(left,24,W-left-12-stripW-8,Math.max(60,H-24-hitsH-8-18));
 const strip=plotBox(sp.x+sp.w+6,sp.y,stripW,sp.h),hb=plotBox(sp.x,sp.y+sp.h+6,sp.w,hitsH);
 const Yf=f=>sp.y+sp.h-Math.log(Math.max(20,Math.min(ny,f))/20)/Math.log(ny/20)*sp.h;
 let mx=-140;for(let i=0;i<Hs.spec.length;i++)if(Hs.spec[i]>mx)mx=Hs.spec[i];
 const SPAN=72,top=Math.max(-100,mx),floorDb=top-SPAN;
 dspText(ctx,`Spectrogram · ${formatHz(20)}–${formatHz(Math.round(ny))}, top ${SPAN} dB · last 5 s`,sp.x,13,{color:DSP_COLORS.text2,weight:600});
 const off=DSP.specCanvas||(DSP.specCanvas=Object.assign(document.createElement('canvas'),{width:DSP_LEN,height:SPEC_ROWS}));
 const octx=off.getContext('2d'),img=octx.createImageData(DSP_LEN,SPEC_ROWS);
 for(let r=0;r<SPEC_ROWS;r++)for(let x=0;x<DSP_LEN;x++){
  const j=x-(DSP_LEN-Hs.filled),o=((SPEC_ROWS-1-r)*DSP_LEN+x)*4;
  const v=j<0?0:(Hs.spec[r*DSP_LEN+(Hs.pos-Hs.filled+j+DSP_LEN)%DSP_LEN]-floorDb)/SPAN,i=Math.max(0,Math.min(255,Math.round(v*255)))*3;
  img.data[o]=MAP_LUT[i];img.data[o+1]=MAP_LUT[i+1];img.data[o+2]=MAP_LUT[i+2];img.data[o+3]=255;
 }
 octx.putImageData(img,0,0);
 ctx.imageSmoothingEnabled=true;ctx.drawImage(off,sp.x,sp.y,sp.w,sp.h);
 // Outside the frequency range: ignored.
 ctx.fillStyle='rgba(7,8,11,.62)';ctx.fillRect(sp.x,sp.y,sp.w,Yf(hi)-sp.y);ctx.fillRect(sp.x,Yf(lo),sp.w,sp.y+sp.h-Yf(lo));
 // Group splits and names.
 for(const i of [gb[1][0],gb[2][0]]){
  const y=Math.round(Yf(edgeHz(i)))+.5;
  ctx.strokeStyle='rgba(233,237,243,.7)';ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(sp.x,y);ctx.lineTo(sp.x+sp.w,y);ctx.stroke();ctx.setLineDash([]);
  dspText(ctx,shortHz(edgeHz(i))+' Hz',sp.x+sp.w-4,y-4,{align:'right',size:9.5,color:DSP_COLORS.text2,bg:true});
 }
 for(let g=0;g<3;g++){const y0=Yf(edgeHz(gb[g][0])),y1=Yf(edgeHz(gb[g][1]));if(y0-y1>16)dspText(ctx,GROUP_NAMES[g],sp.x+6,(y0+y1)/2+4,{color:GROUP_COLORS[g],weight:600,bg:true});}
 dspFrame(ctx,sp);
 for(const f of [50,100,200,500,1000,2000,5000,10000,20000])if(f<ny)dspText(ctx,shortHz(f),sp.x-5,Yf(f)+3.5,{align:'right'});
 // The 16 bands, colored by group.
 for(let b=0;b<16;b++){const y0=Yf(edgeHz(b)),y1=Yf(edgeHz(b+1));ctx.fillStyle=GROUP_COLORS[bandGroup(b,gb)];ctx.globalAlpha=b%2?.5:.9;ctx.fillRect(strip.x,y1+.5,strip.w,Math.max(1,y0-y1-1));}
 ctx.globalAlpha=1;
 // Hits of each group under the spectrogram.
 const row=hb.h/3;
 for(let g=0;g<3;g++){
  ctx.strokeStyle=GROUP_COLORS[g];ctx.lineWidth=1.5;ctx.beginPath();
  for(let j=0;j<Hs.filled;j++)if(histAt(Hs.event[g],j)){const x=Math.round(hb.x+(DSP_LEN-Hs.filled+j)/(DSP_LEN-1)*hb.w)+.5;ctx.moveTo(x,hb.y+g*row+1);ctx.lineTo(x,hb.y+(g+1)*row-1);}
  ctx.stroke();ctx.lineWidth=1;
 }
 dspFrame(ctx,hb);timeLabels(ctx,hb);
 waitingText(ctx,sp);
 return {};
}

// Notes: the chroma (src/dsp.cpp chroma_process) over the last 5 s, C at the
// bottom, and the 12 pitch classes now. The colours go round the circle of
// fifths, as Chromatic Flow lays the notes on the palette by default.
const NOTE_NAMES=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const noteColor=(k,a=1)=>`hsla(${k*7%12*30},75%,62%,${a})`;
// The triad the three strongest classes form, when they stand out.
function chordName(c){
 const order=c.map((v,k)=>[v,k]).sort((a,b)=>b[0]-a[0]),top=order.slice(0,3).map(x=>x[1]);
 if(order[2][0]<.5||order[3][0]>.6*order[2][0])return '';
 for(const r of top)for(const [name,third] of [['major',4],['minor',3]])
  if(top.includes((r+third)%12)&&top.includes((r+7)%12))return `${NOTE_NAMES[r]} ${name}`;
 return '';
}
function drawNotes(ctx,W,H,s,d){
 const Hs=DSP_HIST,left=34,barsW=Math.min(200,Math.max(110,W*.24));
 const gram=plotBox(left,24,W-left-12-barsW-18,Math.max(60,H-24-26)),bars=plotBox(gram.x+gram.w+18,24,barsW,gram.h);
 const info=new Float32Array(d.memory.buffer,d.chroma_info_ptr(),4),[rate,n,dec,clarity]=info,c=STATE.chroma;
 dspText(ctx,`Notes · 12 pitch classes, octaves folded · last 5 s`,gram.x,13,{color:DSP_COLORS.text2,weight:600});
 const off=DSP.notesCanvas||(DSP.notesCanvas=Object.assign(document.createElement('canvas'),{width:DSP_LEN,height:12}));
 const octx=off.getContext('2d'),img=octx.createImageData(DSP_LEN,12);
 for(let k=0;k<12;k++)for(let x=0;x<DSP_LEN;x++){
  const j=x-(DSP_LEN-Hs.filled),o=((11-k)*DSP_LEN+x)*4;
  const v=j<0?0:Hs.chroma[k*DSP_LEN+(Hs.pos-Hs.filled+j+DSP_LEN)%DSP_LEN],i=Math.max(0,Math.min(255,Math.round(v*255)))*3;
  img.data[o]=MAP_LUT[i];img.data[o+1]=MAP_LUT[i+1];img.data[o+2]=MAP_LUT[i+2];img.data[o+3]=255;
 }
 octx.putImageData(img,0,0);
 ctx.imageSmoothingEnabled=false;ctx.drawImage(off,gram.x,gram.y,gram.w,gram.h);ctx.imageSmoothingEnabled=true;
 dspFrame(ctx,gram);timeLabels(ctx,gram);
 const row=gram.h/12;
 for(let k=0;k<12;k++)dspText(ctx,NOTE_NAMES[k],gram.x-6,gram.y+(11.5-k)*row+3.5,{align:'right',color:noteColor(k),size:row<11?8.5:10.5});
 // Now: one bar per class.
 let best=0;for(let k=1;k<12;k++)if(c[k]>c[best])best=k;
 for(let k=0;k<12;k++){
  const y=bars.y+(11-k)*row,w=Math.max(0,Math.min(1,c[k]))*bars.w;
  ctx.fillStyle=noteColor(k,k===best&&c[k]>0?.95:.55);ctx.fillRect(bars.x,y+row*.15,w,Math.max(1,row*.7));
 }
 dspFrame(ctx,bars);
 dspText(ctx,'now',bars.x,bars.y+bars.h+12);
 const chord=chordName(Array.from(c)),lit=c[best]>.05;
 dspText(ctx,lit?NOTE_NAMES[best]+(chord?` · ${chord}`:''):'—',bars.x+bars.w,13,{align:'right',size:12,weight:650,color:lit?noteColor(best):DSP_COLORS.text});
 if(Hs.filled<2)waitingText(ctx,gram);
 return {rate,n,dec,clarity,best:lit?best:-1,chord};
}

// A/B: the pinned settings (A) against the live ones (B) on the same audio.
const AB_LABELS={fft:['FFT',v=>v],attack:['Attack',v=>v+' ms'],release:['Release',v=>v+' ms'],'noise-db':['Noise floor',v=>v<=NOISE_OFF_DB?'off':`${v} dB`],
 'adaptive-db':['Adaptive floor',v=>v<=ADAPTIVE_OFF_DB?'off':v+' dB'],'floor-rise':['Floor learns in',v=>v+' s'],'floor-fall':['Floor drops in',v=>(v/1000).toFixed(2)+' s'],gain:['Sensitivity',v=>(v/10).toFixed(1)+'×'],transient:['Onset threshold',v=>(v/10).toFixed(1)+'×'],
 agc:['Auto gain',v=>v+' ms'],compression:['Compression',v=>v+'%'],tilt:['Tilt',v=>`${v/2} dB/oct`],balance:['Band balance',v=>v+'%'],
 'split-mid':['Mid from band',v=>v+1],window:['Window',v=>['Hann','Hamming','Blackman-Harris','Flat-top','Rectangular'][v]],
 'eq-bass':['Bass trim',v=>v+' dB'],'eq-mid':['Mid trim',v=>v+' dB'],'eq-high':['High trim',v=>v+' dB'],smoothing:['Band smoothing',v=>v+'%'],
 'peak-hold':['Peak hold',v=>v+' ms'],'onset-memory':['Onset memory',v=>(v/10).toFixed(1)+' s'],'split-high':['High from band',v=>v+1],'bpm-min':['Tempo from',v=>v+' BPM'],'bpm-max':['Tempo to',v=>v+' BPM']};
GROUP_NAMES.forEach((name,g)=>Object.assign(AB_LABELS,{[`onset-trim-${g}`]:[`${name} threshold`,v=>(v/10).toFixed(1)+'×'],
 [`holdoff-${g}`]:[`${name} hold-off`,v=>v+' ms'],[`flash-${g}`]:[`${name} flash decay`,v=>v+' ms']}));
function abDiffs(s){
 const ab=DSP.ab,out=[];
 for(const k of AB_KEYS)if(ab.settings[k]!==s[k]){const [name,f]=AB_LABELS[k];out.push(`${name} ${f(ab.settings[k])} → ${f(s[k])}`);}
 const r=frequencyRange(s);
 if(r.lo!==ab.range.lo||r.hi!==ab.range.hi)out.push(`Range ${formatHz(ab.range.lo)}–${formatHz(ab.range.hi)} → ${formatHz(r.lo)}–${formatHz(r.hi)}`);
 return out;
}
function drawAB(ctx,W,H,s){
 if(!DSP.ab){
  const w=Math.min(460,W-48);
  wrapText(ctx,'Pin the current settings as A, then change any analyzer setting. A keeps the pinned values, B follows the sliders; both run on the same audio, side by side, so every difference you see comes from what you changed.',(W-w)/2,H/2-30,w,17,{color:DSP_COLORS.text2,size:12});
  return {};
 }
 const g=DSP.group,color=GROUP_COLORS[g],Hs=DSP_HIST,diffs=abDiffs(s),A='rgba(233,237,243,.8)';
 const main=plotBox(12,44,W-24,Math.max(60,H*.5-44)),hitsB=plotBox(12,main.y+main.h+10,W-24,30),bars=plotBox(12,hitsB.y+hitsB.h+30,W-24,Math.max(30,H-(hitsB.y+hitsB.h+30)-8));
 wrapText(ctx,diffs.length?`A → B: ${diffs.join(' · ')}`:'A = B: change any analyzer setting to compare',12,13,W-24,14,{color:diffs.length?DSP_COLORS.text2:DSP_COLORS.text,weight:600});
 timeGrid(ctx,main);
 drawSeries(ctx,main,Hs.output[g],v=>v,{color,width:2,fill:color+'33'});
 drawSeries(ctx,main,Hs.abOutput[g],v=>v,{color:A,width:1.5,dash:[5,3]});
 dspFrame(ctx,main);
 const [a5,a95]=quantiles(histValues(Hs.abOutput[g]),[.05,.95]),[b5,b95]=quantiles(histValues(Hs.output[g]),[.05,.95]);
 dspLegend(ctx,main.x+8,main.y+15,[[A,`A pinned · ${pct(a5)}–${pct(a95)}`,true],[color,`B now · ${pct(b5)}–${pct(b95)}`]]);
 if(W>=560)dspText(ctx,`${GROUP_NAMES[g]} LED level · last 5 s`,main.x+main.w-6,main.y+15,{align:'right',bg:true});
 // Hits of A and B.
 const row=hitsB.h/2;let ha=0,hb=0;
 for(let j=0;j<Hs.filled;j++){
  const x=Math.round(hitsB.x+(DSP_LEN-Hs.filled+j)/(DSP_LEN-1)*hitsB.w)+.5;
  if(histAt(Hs.abEvent[g],j)){ha++;ctx.strokeStyle=A;ctx.beginPath();ctx.moveTo(x,hitsB.y+2);ctx.lineTo(x,hitsB.y+row-2);ctx.stroke();}
  if(histAt(Hs.event[g],j)){hb++;ctx.strokeStyle=color;ctx.beginPath();ctx.moveTo(x,hitsB.y+row+2);ctx.lineTo(x,hitsB.y+hitsB.h-2);ctx.stroke();}
 }
 dspFrame(ctx,hitsB);
 dspText(ctx,`A · ${ha} hits`,hitsB.x+4,hitsB.y+row-4,{size:9.5,bg:true});
 dspText(ctx,`B · ${hb} hits`,hitsB.x+4,hitsB.y+hitsB.h-4,{size:9.5,color,bg:true});
 timeLabels(ctx,hitsB);
 // All 16 bands now: A outlined, B filled.
 dspText(ctx,'All bands now · A outlined, B filled',bars.x,bars.y-6,{color:DSP_COLORS.text2,weight:600});
 const bw=bars.w/16,last=(Hs.pos-1+DSP_LEN)%DSP_LEN,gb=groupBands();
 for(let k=0;k<16;k++){
  const x=bars.x+k*bw+bw*.15,w=bw*.7,a=Hs.abBands[k*DSP_LEN+last],b=Hs.bands[k*DSP_LEN+last];
  ctx.fillStyle=GROUP_COLORS[bandGroup(k,gb)];ctx.globalAlpha=.75;ctx.fillRect(x,bars.Y(b),w,bars.y+bars.h-bars.Y(b));ctx.globalAlpha=1;
  ctx.strokeStyle=A;ctx.lineWidth=1.5;ctx.strokeRect(x+.75,bars.Y(a)+.75,w-1.5,Math.max(1,bars.y+bars.h-bars.Y(a)-1.5));ctx.lineWidth=1;
 }
 dspFrame(ctx,bars);
 return {diffs:diffs.length,ha,hb};
}

function dspCaption(s,info){
 const g=GROUP_NAMES[DSP.group].toLowerCase(),hopMs=+(hop/fs*1000).toFixed(1);
 switch(DSP.panel){
  case 'resolution':return `<b>FFT size</b> ${s.fft} at ${formatHz(fs)}: ${(fs/s.fft).toFixed(1)} Hz per bin (one step of the spectrum) and a ${+(s.fft*1000/fs).toFixed(1)} ms window — the stretch of sound one frame hears, which also delays the reaction. Larger separates nearby notes, smaller reacts faster.${info.unresolved?` Here ${info.unresolved} bands are narrower than a bin and move together.`:''} <b>Window</b> ${WINDOW_NAMES[s.window]}: the shape each frame is faded in and out with. A pure tone becomes a lobe ${info.lobe?`±${+info.lobe.toFixed(1)} bins wide`:''} with side lobes (leakage) up to −${Math.abs(Math.round(info.side))} dB, which spill a loud bass note into its neighbours: Hann is the balance, Blackman-Harris keeps the bands apart, flat-top reads levels exactly but blurs, rectangular is sharpest but leaks the most. <b>Sample rate</b> sets the top frequency (half the rate). <b>Frequency range</b> is what is split into the 16 bands; the rest is ignored.`;
  case 'level':return `Each band's level (dots) goes through this curve to become LED brightness. <b>Sensitivity</b> ${(s.gain/10).toFixed(1)}× moves it left: everything reads louder. <b>Compression</b> ${s.compression}% bends it (dashed: none): above 0 quiet bands come up and loud ones are squeezed — less contrast; below 0 it expands — quiet parts go dark and only the peaks light up.${s.balance?` With <b>Band balance</b> each dot is placed by its own reference.`:''} Left of the <b>noise floor</b> the output is 0. <b>Auto gain</b> keeps the curve anchored to the music's average level (green), following it in about ${s.agc} ms: short adapts fast but flattens drops and builds, long keeps the song's dynamics.`;
  case 'envelope':return `White: the ${g} level right now; filled: what the LEDs show. <b>Attack</b> ${s.attack} ms — how fast it climbs to a louder sound (63% of the jump in that time): short is punchy, long is soft. <b>Release</b> ${s.release} ms — how fast it falls back: short flickers with every note, long leaves trails and smooths the beat. <b>Peak hold</b> ${s['peak-hold']?`${s['peak-hold']} ms keeps every peak that long before the release starts`:'(off) can keep every peak for a while before the release starts'} — the flash stays bright, the fall stays smooth. The analysis updates every ${hopMs} ms, so shorter times act at once.`;
  case 'onsets':{const k=DSP.group;return `Flux: how much the ${g} energy rose since the previous frame. A hit fires when it crosses the threshold, which follows the average and spread of the flux over the last ${(s['onset-memory']/10).toFixed(1)} s (<b>Memory</b>), so it adapts to busy and calm parts: short follows the song section by section, long keeps one standard for the track. <b>Onset threshold</b> ${(s.transient/10).toFixed(1)}× scales it for every group, <b>${GROUP_NAMES[k]} threshold</b> ${(s[`onset-trim-${k}`]/10).toFixed(1)}× for this one: higher — only strong hits, lower — more, smaller ones. After a hit the detector rests for the <b>hold-off</b>, ${s[`holdoff-${k}`]} ms (grey); the flash fades in the <b>flash decay</b>, ${s[`flash-${k}`]} ms. ${info.count?`Time between hits: a pile-up at the hold-off line means it cuts real hits; a cluster far left of the median (${Math.round(info.median*1000)} ms) means double triggers.`:'Hits drive the flashes, the lamp\'s onset mask and the tempo estimate.'}`;}
  case 'bands':return `Top: the music's spectrum over the last 3 s (grey) and after what shapes the bands (green); the steps on the right axis are the equalizer per band. <b>Tilt</b> ${s.tilt?`${s.tilt>0?'+':''}${s.tilt/2} dB/oct`:'0'} lifts the highs (or, below 0, the lows): music loses energy toward the top, so without it the high bands sit low and barely light. <b>Bass</b>, <b>Mid</b> and <b>High</b> ${[s['eq-bass'],s['eq-mid'],s['eq-high']].map(v=>`${v>0?'+':v<0?'−':''}${Math.abs(v)}`).join(' / ')} dB trim each group on top. <b>Band balance</b> ${s.balance}% normalises each band to its own average over the last seconds (dotted) — every band moves through its range, but a quiet band reads as loud as a strong one. <b>Groups</b> choose the bands of bass, mid and high: their levels, hits and the tempo. Bottom: the LED levels each band used (box: the middle half, whiskers: 5–95 %); <b>Band smoothing</b> ${s.smoothing}% blends each band with its neighbours, so the bars move as a wave rather than one by one.${info.dead?` ${info.dead} band${info.dead===1?' never lights':'s never light'} (outlined).`:''}`;
  case 'tempo':return `Top: the onset strength the tempo tracker hears (bass and mid flux), the beats it predicts (green) and the bass hits. It compares the last 3 s with itself shifted by every beat length of the <b>Tempo range</b> (${s['bpm-min']}–${s['bpm-max']} BPM, the rest is dimmed): that is the periodicity curve. Its highest peak becomes the tempo when it scores above ${TEMPO_ACCEPT}; from ${pct(BEAT_CONFIDENCE)} confidence the beats run, and bass hits inside the shaded part of the dial pull them into phase. A peak at ½× or 2× nearly as high as the main one means the tempo can jump an octave — narrow the range to exclude it.`;
  case 'spectrogram':return `The FFT over the last 5 s on a log frequency axis — what the analyzer gets before the bands. Dimmed: outside the <b>Frequency range</b>; dashed: the <b>Groups</b> splits; right: the 16 bands. Kick drums sit around 40–100 Hz, the snare's body near 150–250 Hz with noise above, hi-hats above 5 kHz: put the splits between the sounds that should drive each group, and check that the hits under it (bass, mid, high) fall on them.`;
  case 'notes':return `How much of each note (pitch class C … B) sounds, octaves folded together: ${info.best>=0?`now mostly <b>${NOTE_NAMES[info.best]}</b>${info.chord?` (${info.chord})`:''}, `:''}each analysis is scaled so its strongest class is 100%, then smoothed. A separate analysis from the bands: the sound resampled to ${formatHz(Math.round(info.rate||8000))} and a ${info.n||4096}-point FFT — ${((info.n||4096)/(info.rate||8000)).toFixed(2)} s window, ${((info.rate||8000)/(info.n||4096)).toFixed(1)} Hz per bin, fine enough to tell semitones apart down to A1 (55 Hz); notes from 55 Hz to about 2 kHz count. Steady background between the peaks is subtracted, so noise and drums stay dim${info.clarity!==undefined?` (clarity now ${pct(Math.min(1,info.clarity))})`:''}. It reacts in about a quarter of a second — too slow for hits, right for harmony. <b>Chromatic Flow</b> colours the lamp from it, and lamps that list <b>chroma</b> receive it with every frame.`;
  case 'chain':return `The ${g} signal after every stage, on one time axis — read it top to bottom to see which setting shapes it. (1) the <b>noise floor</b> decides when the input counts at all; (2) <b>Sensitivity</b>, <b>Compression</b> and <b>Auto gain</b> map it to 0–100%; (3) <b>Attack</b> and <b>Release</b> smooth that into what the LEDs show; (4) <b>Onset threshold</b> picks the hits that flash. The bars on the right are the range each stage uses: a narrow range in 2 or 3 means little contrast on the lamp, a range stuck high means it is always bright.`;
  case 'map':return `Every band over the last 5 s: before the analyzer (top) and what the LEDs get (bottom), low frequencies at the bottom. Rows that stay dark never light the lamp — lower the <b>noise floor</b> or raise <b>Sensitivity</b>; a mostly bright map leaves no room for peaks — lower <b>Sensitivity</b> or <b>Compression</b>; smeared vertical stripes mean a long <b>Release</b>. The histogram shows how often each LED level occurs: a good setting spreads it out${info.count?` (now ${pct(info.dark)} dark, ${pct(info.bright)} bright)`:''}.`;
  case 'ab':return DSP.ab?`<b>A</b> is a copy of the analyzer with the settings you pinned, <b>B</b> follows the sliders; both hear the same audio${info.diffs?'':' and still match'}. Dashed: A, filled: B. Compare the range each one uses, the hits and the bands, then keep B or go back to A's values. The sample rate is shared.`:`Pin the analyzer as it is now, then change settings and watch the old (A) and the new (B) side by side on the same music.`;
  case 'noise':return `The <b>noise floor</b> (${noiseGate(s)?formatDb(noiseGate(s)):'off'}) is subtracted from every band: a band under it counts as silence (grey)${info.silent?` — ${info.silent} of 16 now`:''}. Raise it until the bars stay grey in quiet parts or with nothing playing. <b>Adaptive floor</b> (${adaptiveAmount(s)?formatShare(adaptiveAmount(s)):'off'}) also subtracts that share of each band's own steady background (dotted): it learns a louder background in ${s['floor-rise']} s and follows a quieter one in ${(s['floor-fall']/1000).toFixed(2)} s — for a constant hum, fan or room noise. Over 0 dB (100%) it also cuts what barely rises above that background.`;
 }
 return '';
}

function drawDspView(){
 if(!document.body.classList.contains('dsp-stage')||!STATE.ready)return;
 const canvas=$('dsp-canvas'),cssW=canvas.clientWidth,cssH=canvas.clientHeight;
 if(!cssW||!cssH)return;
 const dpi=Math.min(2,devicePixelRatio||1),cw=Math.round(cssW*dpi),ch=Math.round(cssH*dpi);
 if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
 const ctx=canvas.getContext('2d');ctx.setTransform(dpi,0,0,dpi,0,0);ctx.clearRect(0,0,cssW,cssH);
 const s=settings(),d=STATE.modules.dsp.exports;
 const info=({resolution:drawResolution,bands:drawBands,level:drawLevel,envelope:drawEnvelope,onsets:drawOnsets,tempo:drawTempo,noise:drawNoise,
  spectrogram:drawSpectrogram,notes:drawNotes,chain:drawChain,map:drawMap,ab:drawAB})[DSP.panel](ctx,cssW,cssH,s,d)||{};
 const now=performance.now();
 if(now-DSP.captionAt>250){
  DSP.captionAt=now;const text=dspCaption(s,info);
  if(text!==DSP.caption){DSP.caption=text;$('dsp-caption').innerHTML=text;}
 }
}

function refreshStageMode(){
 const analyzer=currentTab()==='analyzer',on=analyzer&&DSP.mode==='dsp';
 $('stage-mode').hidden=!analyzer;
 document.body.classList.toggle('dsp-stage',on);
 $('dsp-view').hidden=!on;
 for(const input of $('stage-mode').querySelectorAll('input'))input.checked=input.value===DSP.mode;
 for(const t of $('dsp-panels').querySelectorAll('[data-dsp]')){const sel=t.dataset.dsp===DSP.panel;t.setAttribute('aria-selected',String(sel));t.tabIndex=sel?0:-1;}
 for(const t of $('dsp-groups').querySelectorAll('[data-group]'))t.setAttribute('aria-pressed',String(+t.dataset.group===DSP.group));
 $('dsp-groups').hidden=!DSP_GROUP_PANELS.includes(DSP.panel);
 $('dsp-ab').hidden=DSP.panel!=='ab';$('dsp-unpin').hidden=!DSP.ab;$('dsp-pin').textContent=DSP.ab?'Pin again':'Pin as A';
 $('dsp-canvas').setAttribute('aria-label',`DSP view: ${DSP.panel}`);
 refreshOnsetGroups();
 DSP.captionAt=0;
}
// The Onsets section shows the selected group's settings (the same group as
// the DSP view's) and sums up the other two.
function refreshOnsetGroups(s=settings()){
 for(const el of document.querySelectorAll('[data-onset-group]'))el.hidden=+el.dataset.onsetGroup!==DSP.group;
 for(const b of $('onset-groups').querySelectorAll('[data-group]')){const on=+b.dataset.group===DSP.group;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}
 $('onset-summary').textContent=[0,1,2].filter(g=>g!==DSP.group).map(g=>`${GROUP_NAMES[g]}: ${(s[`onset-trim-${g}`]/10).toFixed(1)}×, hold-off ${s[`holdoff-${g}`]} ms, flash ${s[`flash-${g}`]} ms`).join(' · ');
}
function setDspChoice(key,storeKey,value){
 if(DSP[key]===value)return;
 DSP[key]=value;try{localStorage.setItem(storeKey,String(value));}catch(_){}
 refreshStageMode();
}
function initDspView(){
 for(const input of $('stage-mode').querySelectorAll('input'))input.addEventListener('change',()=>{if(input.checked)setDspChoice('mode',STAGE_MODE_KEY,input.value);});
 const tabs=$('dsp-panels');
 for(const t of tabs.querySelectorAll('[data-dsp]'))t.onclick=()=>setDspChoice('panel',DSP_PANEL_KEY,t.dataset.dsp);
 tabs.addEventListener('keydown',e=>{
  const i=DSP_PANELS.indexOf(DSP.panel),j={ArrowLeft:i-1,ArrowRight:i+1,Home:0,End:DSP_PANELS.length-1}[e.key];if(j===undefined)return;
  e.preventDefault();const name=DSP_PANELS[(j+DSP_PANELS.length)%DSP_PANELS.length];setDspChoice('panel',DSP_PANEL_KEY,name);tabs.querySelector(`[data-dsp="${name}"]`).focus();
 });
 for(const t of $('dsp-groups').querySelectorAll('[data-group]'))t.onclick=()=>setDspChoice('group',DSP_GROUP_KEY,+t.dataset.group);
 // The Onsets section's group buttons pick the same group and show its panel.
 for(const t of $('onset-groups').querySelectorAll('[data-group]'))t.onclick=()=>{
  setDspChoice('group',DSP_GROUP_KEY,+t.dataset.group);
  if(DSP_SETTING_PANELS.includes(DSP.panel))setDspChoice('panel',DSP_PANEL_KEY,'onsets');
 };
 $('dsp-pin').onclick=pinCompare;$('dsp-unpin').onclick=clearCompare;
 // Touching an analyzer control shows the panel that explains it; the views
 // across all settings (Chain, Map, A/B) stay while the settings are tuned.
 const follow=e=>{const panel=DSP_CONTROL_PANEL[e.target.id];if(e.isTrusted&&panel&&DSP_SETTING_PANELS.includes(DSP.panel))setDspChoice('panel',DSP_PANEL_KEY,panel);};
 $('panel-analyzer').addEventListener('input',follow);$('panel-analyzer').addEventListener('focusin',follow);
 refreshStageMode();
}
