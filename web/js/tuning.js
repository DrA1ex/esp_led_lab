'use strict';
// Audio tab tuning shared by the preview and the lamp: signal window,
// origin (start / centre shift, reverse, ring, radial centre), the transfer
// curve, mode-dependent visibility and picking the origin on the preview.
// The rules mirror firmware audioTransfer() and RemoteReactive::OriginMap.

const ORIGIN_MODES=[1,2,3,4,6,7,11,12];
const CENTERED_MODES=[2,4,7,12];
const MODE_HINTS={
 0:'Audio does not affect the picture.',
 1:'Loudness of the last ~3 s runs along the LEDs; the newest sound is at the start.',
 2:'Like Wave, but from the center outwards.',
 3:'Each column is a frequency band: bass at the start, treble at the end.',
 4:'Spectrum from the center: bass in the middle, treble at the edges.',
 5:'The whole picture pulses in brightness with the signal.',
 6:'A line grows from the start with the signal level.',
 7:'A line grows from the center in both directions.',
 8:'The signal drives the effect speed (Speed).',
 9:'The signal drives the effect scale (Scale).',
 10:'The signal drives the Light parameter (effect brightness / tint).',
 11:'Upper half follows bass, lower half mids; a strip blends both. Experimental.',
 12:'Band lighting plus a ring on each beat. Experimental.'
};

// Origin shift: the slider counts LEDs (columns); the wire format and the
// renderer take permille of WIDTH, which round-trips exactly up to 1000 LEDs.
const originPermille=(s,w)=>Math.max(-500,Math.min(500,Math.round((+s['origin-shift']||0)*1000/Math.max(1,w))));
function originArgs(s,w){
 return [originPermille(s,w),s['origin-y'],s['origin-reverse']?1:0,s['origin-ring']?1:0,s['origin-radial']?1:0];
}
// Fields for config (docs/REMOTE_AUDIO_PROTOCOL.md, "Tuning").
function tuningConfig(s,w){
 return {input_min:s['input-min'],input_max:s['input-max'],input_gate:s['input-gate'],
  origin_shift:originPermille(s,w),origin_y:s['origin-y'],origin_reverse:s['origin-reverse'],
  origin_ring:s['origin-ring'],origin_radial:s['origin-radial']};
}
// audioTransfer() on a 0..1 input with count = 255.
function transferValue(v,s){
 const lo=Math.min(s['audio-min'],s['audio-max']),hi=s['audio-max'];
 const inMin=s['input-min'],inMax=s['input-max'],x=Math.max(0,Math.min(1,v))*255;
 if(x<inMin)return s['input-gate']?0:lo;
 if(x>=inMax)return hi;
 return lo+(x-inMin)/(inMax-inMin)*(hi-lo);
}

// Column where the effect starts (normal modes) or is centred (Center modes).
function originColumn(s,g,centered){
 const cols=Math.round(g.w*originPermille(s,g.w)/1000);
 let xp=centered?Math.floor(g.w/2)+cols:cols;
 if(s['origin-ring'])xp=((xp%g.w)+g.w)%g.w;
 if(xp<0||xp>=g.w)return -1;
 return s['origin-reverse']?g.w-1-xp:xp;
}
function refreshTuningUi(s,g){
 const mode=s['audio-mode'],half=Math.floor(g.w/2);
 // Mode-dependent fields: data-modes="1,2,3", data-requires-matrix, data-requires="checkbox-id".
 for(const el of document.querySelectorAll('[data-modes],[data-requires-matrix],[data-requires]')){
  let show=true;
  if(el.dataset.modes)show=el.dataset.modes.split(',').map(Number).includes(mode);
  if(show&&el.hasAttribute('data-requires-matrix'))show=g.h>1;
  if(show&&el.dataset.requires)show=Boolean($(el.dataset.requires)?.checked);
  el.hidden=!show;
 }
 $('audio-mode-hint').textContent=MODE_HINTS[mode]||'';
 const shift=$('origin-shift');
 if(+shift.max!==half){shift.min=-half;shift.max=half;}
 if(Math.abs(+shift.value)>half)shift.value=Math.sign(+shift.value)*half;
 const leds=+shift.value;
 $('origin-shift-value').textContent=`${leds>0?'+':''}${leds} ${isStrip(g)?'LED':'col.'}`;
 $('origin-y-value').textContent=Math.round(s['origin-y']/10)+'%';
 $('input-min-value').textContent=Math.round(s['input-min']/2.55)+'%';
 $('input-max-value').textContent=Math.round(s['input-max']/2.55)+'%';
 const centered=CENTERED_MODES.includes(mode),at=originColumn(s,g,centered),unit=isStrip(g)?'LED':'column';
 const where=at<0?'off the edge':`${unit} ${at+1} of ${g.w}`;
 $('origin-hint').textContent=(centered?`Center: ${where}. `:`Start: ${where}, running ${s['origin-reverse']?'left':'right'}. `)+
  (s['origin-ring']?'On a ring the effect continues past the end of the strip. ':'Without a ring, the part shifted past the edge stays dark. ')+
  'Click the preview to set the point.';
 document.body.classList.toggle('center-pick',ORIGIN_MODES.includes(mode));
}

// Keep the window non-empty (firmware rejects input_min >= input_max).
function keepWindow(changed){
 const lo=$('input-min'),hi=$('input-max');
 if(+lo.value<+hi.value)return;
 if(changed==='input-min')lo.value=Math.max(0,+hi.value-1);
 else hi.value=Math.min(255,+lo.value+1);
 if(+lo.value>=+hi.value){lo.value=Math.max(0,+hi.value-1);}
}

// Transfer curve: input signal (x) -> reaction (y), with the live input.
function drawTransfer(input){
 const canvas=$('transfer-curve');
 if(!canvas||canvas.closest('[hidden]'))return;
 const s=settings(),dpi=Math.min(2,devicePixelRatio||1);
 const cssW=canvas.clientWidth||300,cssH=canvas.clientHeight||110;
 const cw=Math.round(cssW*dpi),ch=Math.round(cssH*dpi);
 if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
 const ctx=canvas.getContext('2d');ctx.setTransform(dpi,0,0,dpi,0,0);
 const pad=8,w=cssW-pad*2,h=cssH-pad*2,X=v=>pad+v*w,Y=v=>pad+(1-v/255)*h;
 ctx.clearRect(0,0,cssW,cssH);
 ctx.fillStyle='rgba(99,140,255,.08)';ctx.fillRect(X(s['input-min']/255),pad,X(s['input-max']/255)-X(s['input-min']/255),h);
 ctx.strokeStyle='#232c3a';ctx.lineWidth=1;ctx.beginPath();
 for(const v of [0,.25,.5,.75,1]){ctx.moveTo(X(v),pad);ctx.lineTo(X(v),pad+h);}
 for(const v of [0,127.5,255]){ctx.moveTo(pad,Y(v));ctx.lineTo(pad+w,Y(v));}
 ctx.stroke();
 ctx.strokeStyle='#7fb0ff';ctx.lineWidth=2;ctx.beginPath();
 for(let i=0;i<=w;i++){const v=i/w,y=Y(transferValue(v,s));if(i)ctx.lineTo(X(v),y);else ctx.moveTo(X(v),y);}
 ctx.stroke();
 if(Number.isFinite(input)){
  const v=Math.max(0,Math.min(1,input)),y=transferValue(v,s);
  ctx.fillStyle='#86e2c6';ctx.beginPath();ctx.arc(X(v),Y(y),4,0,Math.PI*2);ctx.fill();
 }
 ctx.fillStyle='#6f7c90';ctx.font='10px system-ui,sans-serif';
 ctx.fillText('signal →',pad+4,pad+h-4);ctx.fillText('reaction',pad+4,pad+10);
}

// Logical LED (x, y) under a click on the new-DSP preview canvas.
function previewLed(canvas,ev,g){
 const r=canvas.getBoundingClientRect(),px=ev.clientX-r.left,py=ev.clientY-r.top;
 let x,row;
 if(isStrip(g)){
  const L=stripLayout(g.w,g.h,r.width);
  row=Math.min(g.h-1,Math.floor(py/(L.rowHeight+L.gap)));
  const line=Math.min(L.linesPerRow-1,Math.floor((py-row*(L.rowHeight+L.gap))/L.pitch));
  x=line*L.perLine+Math.floor(px/L.pitch);
 }else{x=Math.floor(px/r.width*g.w);row=Math.floor(py/r.height*g.h);}
 x=Math.max(0,Math.min(g.w-1,x));row=Math.max(0,Math.min(g.h-1,row));
 return {x,y:$('invert-y').checked?g.h-1-row:row};
}
// Move the start / centre so that the clicked LED becomes it.
function pickOrigin(ev){
 const s=settings(),mode=s['audio-mode'];
 if(!ORIGIN_MODES.includes(mode))return;
 const g=currentGeometry(),{x,y}=previewLed($('canvas-new'),ev,g),half=Math.floor(g.w/2);
 const centered=CENTERED_MODES.includes(mode),pos=s['origin-reverse']?g.w-1-x:x;
 let cols=centered?pos-half:pos;
 if(s['origin-ring']){cols=((cols%g.w)+g.w)%g.w;if(cols>half)cols-=g.w;}
 $('origin-shift').value=Math.max(-half,Math.min(half,cols));
 if(g.h>1&&s['origin-radial'])$('origin-y').value=Math.round(y*1000/Math.max(1,g.h-1));
 refreshLabels();
}

function initTuning(){
 for(const id of ['input-min','input-max'])$(id).addEventListener('input',()=>keepWindow(id));
 $('range-reset').onclick=()=>{
  Object.entries({'input-min':0,'input-max':255,'audio-min':0,'audio-max':255}).forEach(([k,v])=>$(k).value=v);
  $('input-gate').checked=false;refreshLabels();
 };
 $('origin-reset').onclick=()=>{
  $('origin-shift').value=0;$('origin-y').value=500;
  for(const id of ['origin-reverse','origin-ring','origin-radial'])$(id).checked=false;
  refreshLabels();
 };
 $('canvas-new').addEventListener('click',pickOrigin);
}
