'use strict';
// Settings → WASM renderers, canvas painting and live meters.
// Palette gamma setting (128 = 2.2, 0 = off) → the renderer's 256-entry LUT.
function writeGammaLut(m,setting){
 const lut=new Uint8Array(m.memory.buffer,m.gamma_lut_ptr(),256),gamma=2.2+(setting-128)/128;
 for(let k=0;k<256;k++){const v=setting===0?k:Math.floor(255*Math.pow(k/255,gamma));lut[k]=k>0&&v===0?1:v;}
}
function refreshLabels(){
 const s=settings(),g=currentGeometry();
 updateAnalysisHop();spectrumPlan();
 for(const id of ['speed','scale','light'])$(id+'-value').textContent=s[id];
 $('mix-value').textContent=s.mix+'%';
 for(const id of ['spectrum-shape','spectrum-onset','line-response'])$(id+'-value').textContent=s[id]+'%';
 $('audio-min-value').textContent=s['audio-min'];$('audio-max-value').textContent=s['audio-max'];
 $('agc-value').textContent=s.agc+' ms';$('compression-value').textContent=s.compression<0?`−${-s.compression}% · expands`:s.compression+'%';
 $('attack-value').textContent=s.attack+' ms';$('release-value').textContent=s.release+' ms';
 $('noise-value').textContent=(s.noise/1000).toFixed(3);$('adaptive-floor-value').textContent=s['adaptive-floor']+'%';
 $('gain-value').textContent=(s.gain/10).toFixed(1)+'×';$('transient-value').textContent=(s.transient/10).toFixed(1)+'×';
 $('tilt-value').textContent=s.tilt?`${s.tilt>0?'+':'−'}${Math.abs(s.tilt/2).toFixed(1)} dB/oct`:'0 dB/oct';$('balance-value').textContent=s.balance+'%';
 for(const id of ['eq-bass','eq-mid','eq-high'])$(id+'-value').textContent=s[id]?`${s[id]>0?'+':'−'}${Math.abs(s[id])} dB`:'0 dB';
 $('smoothing-value').textContent=s.smoothing+'%';$('peak-hold-value').textContent=s['peak-hold']?s['peak-hold']+' ms':'off';
 $('onset-memory-value').textContent=(s['onset-memory']/10).toFixed(1)+' s';
 for(let g=0;g<3;g++){$(`onset-trim-${g}-value`).textContent=(s[`onset-trim-${g}`]/10).toFixed(1)+'×';$(`holdoff-${g}-value`).textContent=s[`holdoff-${g}`]+' ms';$(`flash-${g}-value`).textContent=s[`flash-${g}`]+' ms';}
 $('bpm-min-value').textContent=s['bpm-min'];$('bpm-max-value').textContent=s['bpm-max'];
 $('matrix-label').textContent=geometryLabel(g);
 $('gamma-value').textContent=s.gamma===0?'off':(2.2+(s.gamma-128)/128).toFixed(2);
 $('master-brightness-value').textContent=s['master-brightness'];const range=frequencyRange(s);
 $('freq-min-value').textContent=formatHz(range.lo);$('freq-max-value').textContent=formatHz(range.hi);
 const {mid,high}=groupSplits(s),edge=i=>formatHz(roundHz(range.lo*Math.pow(range.hi/range.lo,i/16)));
 $('groups-value').textContent=`${mid} · ${high-mid} · ${16-high} bands`;
 $('groups-hint').innerHTML=`<b class="g-bass">Bass</b> ${edge(0)}–${edge(mid)} · <b class="g-mid">Mid</b> to ${edge(high)} · <b class="g-high">High</b> to ${edge(16)}`;
 refreshOnsetGroups(s);
 $('fft-display').textContent=`FFT ${s.fft} / ${formatHz(fs)} · ${formatHz(range.lo)}–${formatHz(range.hi)}`;
 for(const o of $('fft').options)o.textContent=`${o.value} · ${+(+o.value*1000/fs).toFixed(2)} ms`;
 $('fft-hint').textContent=`${(fs/s.fft).toFixed(1)} Hz per bin · ${(s.fft*1000/fs).toFixed(2)} ms window. Larger FFTs separate nearby frequencies better; smaller FFTs react faster.`;
 refreshAnalysisUi();
 if(STATE.ready){STATE.modules.dsp.exports.set_sample_rate(fs);STATE.modules.dsp.exports.set_frequency_range(range.lo,range.hi);}
 refreshGeometryUi(g);
 if(STATE.ready){
  const m=STATE.modules.new.exports;
  m.set_dimensions(g.w,g.h);m.set_palette(s.palette);
  writeGammaLut(m,s.gamma);m.apply_palette_gamma();
  m.set_reaction_tuning(s['spectrum-shape']/100,s['spectrum-onset']/100,s['line-response']/100,0);
  m.set_effects(s.color,s.brightness,s['audio-mode']);m.set_parameters(s.speed,s.scale,s.light,s.mix/100);m.set_audio_range(s['audio-min'],s['audio-max']);
  const curve=curveExponent(s);fillCurveTable(m,curve);
  m.set_audio_window(s['input-min'],s['input-max'],s['input-gate']?1:0,curve);
  m.set_visualization(+s['viz-color'],s['viz-mirror']?1:0,s['viz-decay']/100,s['viz-speed']/100,s['viz-auto']?1:0);m.set_origin(...originArgs(s,g.w));
  // Effect parameters of the running visualization (engine mode = audio mode - 13).
  const mode=s['audio-mode'];
  if(FX_MODES.includes(mode)){new Uint8Array(m.memory.buffer,m.viz_params_ptr(),FX_MAX).set(fxValues(s,mode));m.set_viz_params(mode-13);}
  else m.set_viz_params(-1);
 }
 refreshTuningUi(s,g);refreshFxUi(s,g);
 commitEditor(settings()); // after refreshTuningUi, which may narrow the start offset
 syncChoices();paintRanges();scheduleThumbs(s);scheduleSave();
 refreshEffective();
}
// Control source for parameter modes; the same source is sent to the ESP as
// config.param_source (see remote-ui.js).
function newControlSource(s=settings()){
 switch(s['param-source']){
  case 'spectral':return STATE.newParam;
  case 'bass':return STATE.levels[0];
  case 'mid':return STATE.levels[1];
  case 'high':return STATE.levels[2];
  case 'peak':return Math.max(...STATE.newSpectrum);
  case 'onset':return Math.max(...STATE.pulses);
  case 'beat':return STATE.beatConfidence*STATE.beatPulse;
  default:return STATE.newLoudness;
 }
}
function feedRender(m){
 const s=settings(),d=STATE.modules.dsp.exports,features=new Float32Array(m.memory.buffer,m.audio_features_ptr(),237);
 features.fill(0);
 for(let j=0;j<16;j++)features[j]=STATE.newSpectrum[j];
 for(let j=0;j<3;j++){features[16+j]=STATE.pulses[j];features[19+j]=STATE.events[j];}
 features[22]=STATE.newParam;
 features[23]=newControlSource(s);
 const history=remoteEnabled()&&RS.visual?RS.visual.newWave:new Float32Array(d.memory.buffer,d.new_wave_ptr(),128);
 const head=remoteEnabled()&&RS.visual?RS.visual.newWaveHead:d.new_wave_head();
 for(let j=0;j<128;j++)features[24+j]=history[(head+j)%128];
 features[152]=STATE.bpm;features[153]=STATE.beatConfidence;features[154]=STATE.beatPhase;features[155]=STATE.beatPulse;
 for(let j=0;j<3;j++)features[156+j]=STATE.levels[j];
 features[159]=STATE.newLine;
 // The bands the edited lamp receives (Remote Output band count) for the lab-only modes.
 const count=previewBands(),bands=remoteBands(count);
 for(let j=0;j<count;j++)features[160+j]=bands[j];
 features[224]=count;
 // Pitch classes C..B (Chromatic Flow).
 for(let j=0;j<12;j++)features[225+j]=STATE.chroma[j];
}
function remoteBands(count){
 if(remoteEnabled()&&RS.visual)return RS.visual['r'+count];
 if(count===16)return STATE.newSpectrum;
 const d=STATE.modules.dsp.exports;
 return new Float32Array(d.memory.buffer,count===32?d.new_remote32_ptr():d.new_remote64_ptr(),count);
}
// Mirrors render.cpp: Brightness and Speed/Scale/Light read features[23]
// (the selected control source) through the reaction range (transferValue);
// Line blends it with the fast line envelope.
function refreshEffective(){
 const s=settings(),kind=s['audio-mode'],single=kind>=5&&kind<=10,box=$('control-visual');
 box.hidden=!single;
 if(!single)return;
 const param=kind===8?'Speed':kind===9?'Scale':kind===10?'Light':kind===5?'Brightness':'Line width';
 const control=newControlSource(s),lineMix=s['line-response']/100;
 let input=kind===6||kind===7?(1-lineMix)*control+lineMix*STATE.newLine:control;
 input=Math.max(0,Math.min(1,Number.isFinite(input)?input:0));
 const mapped=Math.floor(transferValue(input,s)),columns=currentGeometry().w;
 let value;
 if(kind>=8)value=Math.round(s[kind===8?'speed':kind===9?'scale':'light']*(1-s.mix/100)+mapped*s.mix/100);
 else if(kind===6||kind===7)value=Math.floor(mapped*Math.floor(columns/(kind===7?2:1))/255);
 else value=Math.round(mapped/2.55);
 const sourceName=$('param-source').selectedOptions[0].textContent;
 $('control-source-label').textContent=kind===6||kind===7?`${sourceName} + fast envelope`:sourceName;
 $('control-value-label').textContent=kind===5?`Brightness ${value}%`:kind===6||kind===7?`${value} ${isStrip(currentGeometry())?'LED':'columns'}`:`${param}: ${value}`;
 $('control-fill').style.width=(input*100).toFixed(2)+'%';
 $('control-marker').style.left=(input*100).toFixed(2)+'%';
 const hint=kind===10&&s.color!==9&&s.brightness===0?'Light Control has no effect on this preset: Fixed brightness and not Solid Color':
 (kind===8&&s.color===9?'In Solid Color, Speed sets the hue':
 (kind===9&&s.color===9?'In Solid Color, Scale sets the saturation':''));
 $('control-hint').textContent=hint;
}

const displayScale=()=>Math.min(2,devicePixelRatio||1);
// Converts the serpentine WASM framebuffer to a row-major display image
// (optionally Y-inverted and LED-output corrected) and draws it.
function paint(m,canvas,side,dots){
 const n=m.get_width(),h=m.get_height();
 const u=new Uint8ClampedArray(m.memory.buffer,m.framebuffer_ptr(),n*h*4);
 const off=STATE.canvases[side].off;off.width=n;off.height=h;
 const oc=off.getContext('2d',{willReadFrequently:true});const img=oc.createImageData(n,h);
 const conf=settings(),invertY=conf['invert-y'],master=conf['simulate-led']?conf['master-brightness']:255,correction=conf['simulate-led']?[255,176,240]:[255,255,255];
 for(let y=0;y<h;y++)for(let x=0;x<n;x++){
  const src=((y&1)?n-1-x:x)+y*n,si=src*4,dstY=invertY?h-1-y:y,di=(dstY*n+x)*4;
  for(let c=0;c<3;c++){
   const adj=Math.floor(correction[c]*(master+1)/256);
   img.data[di+c]=Math.floor(u[si+c]*(adj+1)/256);
  }
  img.data[di+3]=255;
 }
 oc.putImageData(img,0,0);
 // A lightweight readout of the *actual* WASM RGB output, not of the audio
 // analyzer. It helps distinguish a dead DSP from a very dark original overlay.
 let sum=0,samples=0;
 for(let i=0;i<n*h;i+=Math.max(1,Math.floor(n*h/256))){sum+=img.data[i*4]+img.data[i*4+1]+img.data[i*4+2];samples++;}
 STATE.output[side]=sum/(samples*3*255);
 if(isStrip({w:n,h}))drawStrip(canvas,img.data,n,h,dots);
 else drawMatrix(canvas,off,img.data,n,h,dots);
}
function drawMatrix(canvas,off,data,n,h,dots){
 // The frame is sized by CSS (container units) from --ar, the matrix aspect ratio.
 const stage=canvas.parentElement,ar=String(+(n/h).toFixed(4));
 if(stage.style.getPropertyValue('--ar')!==ar)stage.style.setProperty('--ar',ar);
 const dpi=displayScale(),view=canvas.clientWidth||canvas.width;
 const cw=Math.max(64,Math.round(view*dpi)),ch=Math.max(16,Math.round(cw*h/n));
 if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
 const ctx=canvas.getContext('2d');
 ctx.fillStyle='#030508';ctx.fillRect(0,0,cw,ch);
 if(dots&&n*h<=1024){
  const dx=cw/n,dy=ch/h,radius=Math.max(1,Math.min(dx,dy)*.33);
  for(let y=0;y<h;y++)for(let x=0;x<n;x++){
   const i=(y*n+x)*4,bright=Math.max(data[i],data[i+1],data[i+2])/255;
   ctx.beginPath();ctx.arc((x+.5)*dx,(y+.5)*dy,radius,0,Math.PI*2);
   ctx.fillStyle=`rgb(${data[i]},${data[i+1]},${data[i+2]})`;
   if(bright>.2){ctx.shadowColor=ctx.fillStyle;ctx.shadowBlur=dx*.45*bright;}
   ctx.fill();ctx.shadowBlur=0;
  }
 }else{ctx.imageSmoothingEnabled=false;ctx.drawImage(off,0,0,cw,ch);}
}
// Strips are wrapped onto display lines (see stripLayout) so each LED keeps a
// readable size, as large as the stage allows; a soft halo is drawn instead of
// shadowBlur to stay cheap at 1024 LEDs x 60 FPS.
const PHONE_LAYOUT=matchMedia('(max-width:759px)');
function stripMaxHeight(canvas){
 if(PHONE_LAYOUT.matches)return Math.round(innerHeight*(document.body.classList.contains('stage-compact')?.12:.26));
 const view=canvas.closest('.stage-view');
 return view?Math.max(24,view.clientHeight-24):0;
}
function drawStrip(canvas,data,n,h,dots){
 const cssW=Math.max(120,canvas.clientWidth||canvas.parentElement.clientWidth||300),dpi=displayScale();
 const L=stripLayout(n,h,cssW,stripMaxHeight(canvas));STATE.stripLayout=L;
 const cw=Math.round(cssW*dpi),ch=Math.max(1,Math.round(L.height*dpi));
 if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
 const ctx=canvas.getContext('2d');
 ctx.setTransform(dpi,0,0,dpi,0,0);
 ctx.clearRect(0,0,cssW,L.height);
 const p=L.pitch,core=Math.max(.8,p*.34),left=L.offsetX;
 for(let y=0;y<h;y++){
  const top=y*(L.rowHeight+L.gap);
  for(let x=0;x<n;x++){
   const i=(y*n+x)*4,r=data[i],g=data[i+1],b=data[i+2];
   const col=x%L.perLine,line=Math.floor(x/L.perLine),cx=left+(col+.5)*p,cy=top+(line+.5)*p;
   if(!dots){ctx.fillStyle=`rgb(${r},${g},${b})`;ctx.fillRect(left+col*p+.5,top+line*p+.5,Math.max(1,p-1),Math.max(1,p-1));continue;}
   ctx.fillStyle='#10151e';ctx.beginPath();ctx.arc(cx,cy,core,0,Math.PI*2);ctx.fill();
   const bright=Math.max(r,g,b)/255;
   if(bright<.02)continue;
   if(bright>.2){ctx.fillStyle=`rgba(${r},${g},${b},${(.28*bright).toFixed(3)})`;ctx.beginPath();ctx.arc(cx,cy,p*.5,0,Math.PI*2);ctx.fill();}
   ctx.fillStyle=`rgb(${r},${g},${b})`;ctx.beginPath();ctx.arc(cx,cy,core,0,Math.PI*2);ctx.fill();
  }
 }
 ctx.setTransform(1,0,0,1,0,0);
}
function meters(){
 const vals=STATE.newSpectrum;
 renderSpectrum();
 const mode=+($('audio-mode').value),isWave=[1,2].includes(mode),isParam=[5,6,7,8,9,10,13,15,16,18,21,22,23,24,25,26,27,28,30].includes(mode);
 const strength=isParam?newControlSource():(isWave?STATE.newLoudness:Math.max(...vals));
 $('new-label').textContent=`Signal ${Math.round(strength*100)}% · LEDs ${Math.round(STATE.output.new*100)}%`;
 drawTransfer(mode?strength:NaN);
 for(let j=0;j<3;j++)$(['bass','mid','high'][j]).classList.toggle('active',STATE.pulses[j]>.35);
 const sure=STATE.beatConfidence>.21;
 $('bpm').textContent=sure?Math.round(STATE.bpm):'—';
 $('bpm-confidence').textContent=sure?Math.round(STATE.beatConfidence*100)+'%':'';
 drawDspView();
}
