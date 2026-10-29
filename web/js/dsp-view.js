'use strict';
// DSP view: on the Analyzer tab the stage can show, instead of the LEDs, what
// the analyzer settings do to the captured signal. Each panel draws the curve
// or response a group of settings sets up and the live signal going through
// it; the curves mirror new_process() in src/dsp.cpp.
const STAGE_MODE_KEY='esp-led-lab.stage-mode',DSP_PANEL_KEY='esp-led-lab.dsp-panel',DSP_GROUP_KEY='esp-led-lab.dsp-group';
const DSP_PANELS=['resolution','level','envelope','onsets','noise'];
// The panel that shows an analyzer control; touching the control opens it.
const DSP_CONTROL_PANEL={fft:'resolution','sample-rate':'resolution','freq-min':'resolution','freq-max':'resolution',
 gain:'level',compression:'level',agc:'level',attack:'envelope',release:'envelope',transient:'onsets',noise:'noise','adaptive-floor':'noise'};
// Bands of the bass / mid / high groups and their refractory time after a hit (dsp.cpp).
const GROUP_BANDS=[[0,5],[5,12],[12,16]],GROUP_NAMES=['Bass','Mid','High'],GROUP_COLORS=['#ff9161','#ffd166','#6fd3ff'],GROUP_REFRACTORY=[.16,.085,.085];
const DSP_COLORS={grid:'#1d222c',axis:'#2c3240',text:'#8a93a3',text2:'#bcc4d0',accent:'#8e9bff',live:'#5ad1a0',warn:'#f0b45a'};
const DSP_STEP=.016,DSP_LEN=320; // history: 16 ms steps, about 5 s

function storedChoice(key,allowed,fallback){
 try{const v=localStorage.getItem(key);if(allowed.includes(v))return v;}catch(_){}
 return fallback;
}
const DSP={mode:storedChoice(STAGE_MODE_KEY,['leds','dsp'],'dsp'),panel:storedChoice(DSP_PANEL_KEY,DSP_PANELS,'level'),
 group:+storedChoice(DSP_GROUP_KEY,['0','1','2'],'0'),caption:'',captionAt:0};
const dspSeries=()=>[0,1,2].map(()=>new Float32Array(DSP_LEN));
const DSP_HIST={pos:0,filled:0,elapsed:0,peakFlux:[0,0,0],hit:[0,0,0],
 target:dspSeries(),output:dspSeries(),flux:dspSeries(),threshold:dspSeries(),event:dspSeries(),pulse:dspSeries(),
 average:new Float32Array(DSP_LEN),ref:new Float32Array(DSP_LEN)};

// Called after every new_process(): keeps ~5 s of the intermediate signals.
// The hop never exceeds 16 ms, so one step takes at most one sample per hop;
// flux keeps its peak and hits are kept when several hops share a step.
function recordDsp(d,hopSeconds){
 const H=DSP_HIST,mem=d.memory.buffer,metrics=new Float32Array(mem,d.new_metrics_ptr(),10);
 for(let g=0;g<3;g++){H.peakFlux[g]=Math.max(H.peakFlux[g],metrics[g]);if(STATE.events[g])H.hit[g]=1;}
 H.elapsed+=hopSeconds;
 if(H.elapsed+1e-6<DSP_STEP)return;
 H.elapsed=Math.max(0,H.elapsed-DSP_STEP);
 const raw=new Float32Array(mem,d.new_raw_ptr(),16),targets=new Float32Array(mem,d.new_targets_ptr(),16),thresholds=new Float32Array(mem,d.new_thresholds_ptr(),3),i=H.pos;
 for(let g=0;g<3;g++){
  const [a,b]=GROUP_BANDS[g];let t=0;for(let k=a;k<b;k++)t+=targets[k];
  H.target[g][i]=t/(b-a);H.output[g][i]=STATE.levels[g];H.flux[g][i]=H.peakFlux[g];H.threshold[g][i]=thresholds[g];
  H.event[g][i]=H.hit[g];H.pulse[g][i]=STATE.pulses[g];H.peakFlux[g]=H.hit[g]=0;
 }
 let sum=0;for(let k=0;k<16;k++)sum+=raw[k];
 H.average[i]=sum/16;H.ref[i]=metrics[5];
 H.pos=(i+1)%DSP_LEN;H.filled=Math.min(DSP_LEN,H.filled+1);
}
// History sample j of the H.filled kept ones, oldest first.
const histAt=(arr,j)=>arr[(DSP_HIST.pos-DSP_HIST.filled+j+DSP_LEN)%DSP_LEN];

// The band level → LED level curve of new_process(): noise floor subtracted,
// sensitivity over the AGC reference, compression, soft knee.
function levelOut(raw,gate,gain,compression,ref,floor=0){
 const n=Math.max(0,Math.max(0,raw-gate-floor)*gain/(ref*6.5));
 const c=(1-compression)*n+compression*Math.sqrt(n);
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

// Resolution: the FFT bins of the live spectrum on a frequency axis, the 16
// bands inside the frequency range, and the windows of consecutive frames.
function drawResolution(ctx,W,H,s,d){
 const n=s.fft,step=fs/n,nyquist=analysisNyquist(),{lo,hi}=frequencyRange(s),win=n/fs,hopS=hop/fs;
 const timeH=Math.max(64,Math.min(120,H*.3)),spec=plotBox(12,22,W-24,Math.max(40,H-timeH-22-62));
 const F=f=>spec.x+Math.log(Math.max(20,f)/20)/Math.log(nyquist/20)*spec.w;
 const wide=W>=520;
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
  const f0=lo*Math.pow(hi/lo,b/16),f1=lo*Math.pow(hi/lo,(b+1)/16),narrow=f1-f0<step,g=b<5?0:b<12?1:2;
  if(narrow)unresolved++;
  ctx.globalAlpha=b%2?.55:.9;ctx.fillStyle=narrow?DSP_COLORS.text:GROUP_COLORS[g];
  ctx.fillRect(F(f0)+.5,strip.y,Math.max(1,F(f1)-F(f0)-1),strip.h);ctx.globalAlpha=1;
  if(narrow){ctx.strokeStyle=DSP_COLORS.warn;ctx.lineWidth=1;ctx.strokeRect(F(f0)+.5,strip.y+.5,Math.max(1,F(f1)-F(f0)-1),strip.h-1);}
 }
 for(const f of [50,100,200,500,1000,2000,5000,10000,20000])if(f<nyquist)dspText(ctx,formatHz(f),F(f),strip.y+strip.h+12,{align:'center'});
 dspText(ctx,unresolved?(wide?`${unresolved} of 16 bands are narrower than one bin`:`${unresolved}/16 bands < 1 bin`):'16 bands · bass, mid, high',spec.x+spec.w,13,{align:'right',color:unresolved?DSP_COLORS.warn:DSP_COLORS.text});
 // Frames in time: each one hears the last window, a new one starts every hop.
 const span=win+4*hopS,time=plotBox(12,H-timeH+8,W-24,timeH-26),T=t=>time.x+t/span*time.w,rows=5,rowH=Math.min(14,(time.h-4)/rows-3);
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
 return {unresolved};
}

// Level: the curve from a band's level to its LED level, the 16 bands on it
// right now, and the AGC reference following the music's average level.
function drawLevel(ctx,W,H,s,d){
 const mem=d.memory.buffer,ref=Math.max(.003,new Float32Array(mem,d.new_metrics_ptr(),10)[5]),gate=s.noise/1000,gain=s.gain/10,comp=s.compression/100;
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
 const raw=new Float32Array(mem,d.new_raw_ptr(),16),targets=new Float32Array(mem,d.new_targets_ptr(),16);
 for(let k=0;k<16;k++){
  if(raw[k]<=0)continue;
  ctx.fillStyle=GROUP_COLORS[k<5?0:k<12?1:2];ctx.beginPath();ctx.arc(xOf(raw[k]),b.Y(targets[k]),3.6,0,Math.PI*2);ctx.fill();
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
 const hopS=hop/fs,a=Math.max(.005,Math.min(1,hopS/Math.max(.005,s.attack/1000))),r=Math.max(.005,Math.min(1,hopS/Math.max(.015,s.release/1000)));
 const pre=.04,on=Math.max(.2,s.attack/1000*4),post=Math.max(.25,s.release/1000*4),steps=Math.ceil((pre+on+post)/hopS);
 const out=[];let y=0,rise63=null,rise90=null,fall=null,peak=0;
 for(let i=0;i<steps;i++){
  const t=i*hopS,x=t>=pre&&t<pre+on?1:0;
  y+=(x-y)*(x>y?a:r);out.push(y);
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
 dspText(ctx,`↓ release: down to 37% in ${ms(R.fall)}`,stepOuter.x+8,stepOuter.y+30,{color:DSP_COLORS.text2});
 dspFrame(ctx,stepOuter);
 const tick=tickStep(R.total*1000,stepB.w);
 for(let t=0;t<=R.total*1000;t+=tick)dspText(ctx,`${t} ms`,T(t/1000),stepB.y+stepB.h+12,{align:t?'center':'left'});
 return R;
}

// Onsets: the group's energy rise (flux) against its adaptive threshold, the
// hits it fired with their refractory time, and the flash they trigger.
function drawOnsets(ctx,W,H,s){
 const g=DSP.group,color=GROUP_COLORS[g],H_=DSP_HIST,flashH=Math.max(26,Math.min(60,H*.16));
 const b=plotBox(12,24,W-24,H-24-flashH-40),flash=plotBox(12,b.y+b.h+22,W-24,flashH);
 let maxFlux=0,maxThr=0,hits=0;
 for(let j=0;j<H_.filled;j++){maxFlux=Math.max(maxFlux,histAt(H_.flux[g],j));maxThr=Math.max(maxThr,histAt(H_.threshold[g],j));hits+=histAt(H_.event[g],j);}
 // Spikes may leave the top so the threshold stays readable.
 const top=Math.max(.2,maxThr*1.6,Math.min(maxFlux,maxThr*3))*1.05,map=v=>v/top;
 dspText(ctx,`${GROUP_NAMES[g]} onsets · last 5 s`,b.x,13,{color:DSP_COLORS.text2,weight:600});
 dspText(ctx,`${hits} hit${hits===1?'':'s'}`,b.x+b.w,13,{align:'right',color});
 timeGrid(ctx,b);
 ctx.save();ctx.beginPath();ctx.rect(b.x,b.y,b.w,b.h);ctx.clip();
 const dx=b.w/(DSP_LEN-1),refractory=GROUP_REFRACTORY[g]/DSP_STEP*dx;
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
 return {hits};
}

// Noise: each band's level now with the noise floor (and the adaptive floor
// learned per band) that is subtracted before anything else.
function drawNoise(ctx,W,H,s,d){
 const mem=d.memory.buffer,raw=new Float32Array(mem,d.new_raw_ptr(),16),floor=new Float32Array(mem,d.new_floor_ptr(),16);
 const ref=Math.max(.003,new Float32Array(mem,d.new_metrics_ptr(),10)[5]),gate=s.noise/1000,adaptive=s['adaptive-floor']/100;
 const LO=-84,HI=-12,b=plotBox(40,24,W-52,H-24-34),Yd=v=>b.Y(dbNorm(v,LO,HI)),bw=b.w/16,{lo,hi}=frequencyRange(s);
 dspText(ctx,'Band levels now, dB',b.x,13,{color:DSP_COLORS.text2,weight:600});
 ctx.strokeStyle=DSP_COLORS.grid;ctx.lineWidth=1;ctx.beginPath();
 for(let db=LO;db<=HI;db+=12){const y=Math.round(b.Y((db-LO)/(HI-LO)))+.5;ctx.moveTo(b.x,y);ctx.lineTo(b.x+b.w,y);}
 ctx.stroke();
 for(let db=LO;db<=HI;db+=12)dspText(ctx,`${db<0?'−':''}${Math.abs(db)}`,b.x-5,b.Y((db-LO)/(HI-LO))+3.5,{align:'right'});
 let silent=0;
 for(let k=0;k<16;k++){
  const x=b.x+k*bw+Math.max(1,bw*.12),w=Math.max(2,bw*.76),cut=gate+floor[k]*adaptive,yRaw=Yd(raw[k]),yCut=Yd(cut),bottom=b.y+b.h;
  ctx.fillStyle='rgba(138,147,163,.35)';ctx.fillRect(x,Math.max(yRaw,yCut),w,bottom-Math.max(yRaw,yCut));
  if(raw[k]>cut){ctx.fillStyle=GROUP_COLORS[k<5?0:k<12?1:2];ctx.fillRect(x,yRaw,w,yCut-yRaw);}else silent++;
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
function dspCaption(s,info){
 const g=GROUP_NAMES[DSP.group].toLowerCase(),hopMs=+(hop/fs*1000).toFixed(1);
 switch(DSP.panel){
  case 'resolution':return `<b>FFT size</b> ${s.fft} at ${formatHz(fs)}: ${(fs/s.fft).toFixed(1)} Hz per bin (one step of the spectrum) and a ${+(s.fft*1000/fs).toFixed(1)} ms window — the stretch of sound one frame hears, which also delays the reaction. Larger separates nearby notes, smaller reacts faster.${info.unresolved?` Here ${info.unresolved} bands are narrower than a bin and move together.`:''} <b>Sample rate</b> sets the top frequency (half the rate). <b>Frequency range</b> is what is split into the 16 bands; the rest is ignored.`;
  case 'level':return `Each band's level (dots) goes through this curve to become LED brightness. <b>Sensitivity</b> ${(s.gain/10).toFixed(1)}× moves it left: everything reads louder. <b>Compression</b> ${s.compression}% bends it (dashed: none): quiet bands come up, loud ones are squeezed — less contrast. Left of the <b>noise floor</b> the output is 0. <b>Auto gain</b> keeps the curve anchored to the music's average level (green), following it in about ${s.agc} ms: short adapts fast but flattens drops and builds, long keeps the song's dynamics.`;
  case 'envelope':return `White: the ${g} level right now; filled: what the LEDs show. <b>Attack</b> ${s.attack} ms — how fast it climbs to a louder sound (63% of the jump in that time): short is punchy, long is soft. <b>Release</b> ${s.release} ms — how fast it falls back: short flickers with every note, long leaves trails and smooths the beat. The analysis updates every ${hopMs} ms, so shorter times act at once.`;
  case 'onsets':return `Flux: how much the ${g} energy rose since the previous frame. A hit fires when it crosses the threshold, which follows the recent average and spread of the flux, so it adapts to busy and calm parts. <b>Onset threshold</b> ${(s.transient/10).toFixed(1)}× scales that: higher — only strong hits, lower — more, smaller ones. After a hit the detector rests ${Math.round(GROUP_REFRACTORY[DSP.group]*1000)} ms (grey). Hits drive the flashes and the tempo estimate.`;
  case 'noise':return `The <b>noise floor</b> (${(s.noise/1000).toFixed(3)}) is subtracted from every band: a band under it counts as silence (grey)${info.silent?` — ${info.silent} of 16 now`:''}. Raise it until the bars stay grey in quiet parts or with nothing playing. <b>Adaptive floor</b> ${s['adaptive-floor']}% also subtracts that share of each band's own steady background (dotted, learned over about 8 s) — for a constant hum, fan or room noise.`;
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
 const info=({resolution:drawResolution,level:drawLevel,envelope:drawEnvelope,onsets:drawOnsets,noise:drawNoise})[DSP.panel](ctx,cssW,cssH,s,d)||{};
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
 $('dsp-groups').hidden=!['envelope','onsets'].includes(DSP.panel);
 $('dsp-canvas').setAttribute('aria-label',`DSP view: ${DSP.panel}`);
 DSP.captionAt=0;
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
 // Touching an analyzer control shows the panel that explains it.
 const follow=e=>{const panel=DSP_CONTROL_PANEL[e.target.id];if(e.isTrusted&&panel)setDspChoice('panel',DSP_PANEL_KEY,panel);};
 $('panel-analyzer').addEventListener('input',follow);$('panel-analyzer').addEventListener('focusin',follow);
 refreshStageMode();
}
