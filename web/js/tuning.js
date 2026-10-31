'use strict';
// Audio tab tuning shared by the preview and the lamp: signal window,
// origin (start / centre shift, reverse, ring, radial centre), the transfer
// curve, mode-dependent visibility and picking the origin on the preview.
// The rules mirror firmware audioTransfer() and RemoteReactive::OriginMap.

const ORIGIN_MODES=[1,2,3,4,6,7,11,12,13,14,15,16,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
// Visualizations (viz_engine.h, shared with the firmware). A lamp renders the
// ones its hello_ack lists in "visualizations"; older firmware gets Off.
const LAB_MODES=[13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
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
 8:'The signal drives the effect speed: reaction 0 stops most effects (Gradient stands still at 128).',
 9:'The signal drives the effect scale (Scale).',
 10:'The signal drives the Light parameter (effect brightness / tint).',
 11:'Upper half follows bass, lower half mids; a strip blends both. Experimental.',
 12:'Band lighting plus a ring on each beat. Experimental.',
 13:'Loudness. Level meter with a falling peak dot. Strip: fills from the start (or both ways from the center). Matrix: rises from the bottom, from the middle row, or as a circle with the 2D center.',
 14:'Spectrum. Strip: all bands spread smoothly along the LEDs, bass to treble. Matrix: a bar per column with falling peaks. Uses the band count sent to the lamp.',
 15:'Spectrum on a matrix, loudness on a strip. Strip: a river of loudness flowing from the start, colored by tone (bass → treble). Matrix: a scrolling spectrogram, newest row at the top (or in the middle).',
 16:'Bass, mid and treble onsets. Each onset launches a comet along the strip (bass, mid and treble in their own colors); on a matrix it is a ring growing from the center.',
 17:'Bass, mid and treble. Treble and onsets sprinkle sparks, bass is a soft glow. Looks the same on any geometry.',
 18:'Loudness, or the spectrum (Effect parameters → Drawn from). The whole lamp breathes with the level, the color follows the tone; with the spectrum every place breathes with its own band. Good for short strips and small lamps.',
 19:'Loudness. Strip: the loudness history in palette colors. Matrix: the history as bars, or a mirrored waveform.',
 20:'Bass, mid and treble. Three meters for bass, mid and treble: three parts of a strip (or ring), three bars on a matrix.',
 21:'Spectrum (or bass, loudness, hits: Effect parameters → Fuel). On a strip it burns from the start (or the center), on a matrix every column is a flame fed by its band; onsets throw up flares. Height, wind, embers and real heat colors are in the effect parameters.',
 22:'Loudness, or the spectrum (Effect parameters → Drawn from). Aurora: a slow, soft noise curtain that grows, brightens and speeds up with the music; with the spectrum each part of the curtain follows its band.',
 23:'Spectrum. Juggle: eight dots, one per band range, swing along the strip (Lissajous paths on a matrix) and leave trails; louder bands are bigger.',
 24:'Spectrum. Radial spectrum: on a matrix a rotating “sun” whose rays are the bands, with a bass core; on a strip or ring a symmetric spectrum that rolls along.',
 25:'Bass, mid and treble. Blobs: a lava lamp of four blobs (bass, bass, mid, treble) that swell with their band, drift and merge.',
 26:'Constructor. Particles: hits launch sparks — fountains, rain, bursts, bubbles or comets. By default every band hit launches from its own place (bass on the left / at the start, treble on the right / further), colored by its frequency.',
 27:'Constructor. Field: a moving pattern (clouds, plasma, rings, stripes, spiral). By default every value of the pattern is a band, so each part lights with its own frequency; the bass pumps the motion and kicks it on hits.',
 28:'Constructor. Zones: the lamp split into columns, rows, rings, sectors or tiles. By default every zone is an equalizer band; or zones flash on hits in a pattern (chase, random, bounce, build up).',
 29:'Spectrum: follows the dominant frequency (the loudest band, refined between bands) — the melody or the bass line, inside a part of the spectrum you choose. A dot, a bar or a scrolling trace.',
 30:'Beat. Groove: rings, spiral arms, stripes or a swinging ball move one step per beat, locked to the beat phase — not a flash per onset. Bass hits expand the pattern, mid hits turn its motion round, treble hits add small sparks. Without a confident tempo, bass and mid hits start the steps.',
 31:'Notes. Chromatic Flow: soft, slowly drifting color regions, one per note that sounds (the 12 pitch classes of a separate long analysis), each in its note\'s place on the palette — a single note fills the lamp, a chord shares it. Bass hits and beats only add a glow and swell the regions a little. Lamps get the notes when their firmware lists “chroma”.'
};

// Origin shift: the slider counts LEDs (columns); the wire format and the
// renderer take permille of WIDTH, which round-trips exactly up to 1000 LEDs.
const originPermille=(s,w)=>Math.max(-500,Math.min(500,Math.round((+s['origin-shift']||0)*1000/Math.max(1,w))));
function originArgs(s,w){
 return [originPermille(s,w),s['origin-y'],s['origin-reverse']?1:0,s['origin-ring']?1:0,s['origin-radial']?1:0];
}
// Curve slider -100..100 -> exponent x 100 on a log scale (25..400, 0 = linear),
// the input_curve wire value.
const curveExponent=s=>Math.max(25,Math.min(400,Math.round(100*Math.pow(4,(+s['input-curve']||0)/100))));
// Fill the renderer's table like firmware TransferCurve: round(65535 * (i/256)^gamma).
function fillCurveTable(m,curve){
 const table=new Uint16Array(m.memory.buffer,m.curve_table_ptr(),257),gamma=curve/100;
 for(let i=0;i<=256;i++)table[i]=Math.round(65535*Math.pow(i/256,gamma));
}
// Fields for config (docs/REMOTE_AUDIO_PROTOCOL.md, "Tuning").
function tuningConfig(s,w){
 return {input_min:s['input-min'],input_max:s['input-max'],input_gate:s['input-gate'],input_curve:curveExponent(s),
  origin_shift:originPermille(s,w),origin_y:s['origin-y'],origin_reverse:s['origin-reverse'],
  origin_ring:s['origin-ring'],origin_radial:s['origin-radial']};
}
// audioTransfer() on a 0..1 input with count = 255.
function transferValue(v,s){
 const lo=Math.min(s['audio-min'],s['audio-max']),hi=s['audio-max'];
 const inMin=s['input-min'],inMax=s['input-max'],x=Math.max(0,Math.min(1,v))*255;
 if(x<inMin)return s['input-gate']?0:lo;
 if(x>=inMax)return hi;
 return lo+Math.pow((x-inMin)/(inMax-inMin),curveExponent(s)/100)*(hi-lo);
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
 // A section whose every field is hidden for this mode goes away too.
 for(const sec of document.querySelectorAll('[data-auto-hide]'))
  sec.hidden=![...sec.querySelectorAll('[data-modes]')].some(el=>!el.hidden);
 $('audio-mode-hint').textContent=MODE_HINTS[mode]||'';
 const shift=$('origin-shift');
 if(+shift.max!==half){shift.min=-half;shift.max=half;}
 if(Math.abs(+shift.value)>half)shift.value=Math.sign(+shift.value)*half;
 const leds=+shift.value;
 $('origin-shift-value').textContent=`${leds>0?'+':''}${leds} ${isStrip(g)?'LED':'col.'}`;
 $('origin-y-value').textContent=Math.round(s['origin-y']/10)+'%';
 $('input-min-value').textContent=Math.round(s['input-min']/2.55)+'%';
 $('input-max-value').textContent=Math.round(s['input-max']/2.55)+'%';
 const curve=curveExponent(s);
 $('input-curve-value').textContent=curve===100?'linear':`×${(curve/100).toFixed(2)}`;
 const strip=g.h<4;
 $('viz-mirror-label').textContent=strip?'From the center, both ways':'Mirror vertically (from the middle row)';
 $('viz-decay-value').textContent=s['viz-decay']+'%';$('viz-speed-value').textContent=s['viz-speed']+'%';
 $('viz-hint').textContent=(strip?`Strip (${g.w}×${g.h}): every row shows the same.`:`Matrix (${g.w}×${g.h}).`)+
  ` Spectrum uses ${previewBands()} bands, the count sent to the lamp (Lamps → Stream settings).`+
  ' A lamp whose firmware does not list this mode in hello_ack is sent Off.';
 const centered=CENTERED_MODES.includes(mode)||(strip&&LAB_MODES.includes(mode)&&s['viz-mirror']),at=originColumn(s,g,centered),unit=isStrip(g)?'LED':'column';
 const where=at<0?'off the edge':`${unit} ${at+1} of ${g.w}`;
 $('origin-hint').textContent=(centered?`Center: ${where}. `:`Start: ${where}, running ${s['origin-reverse']?'left':'right'}. `)+
  (s['origin-ring']?'On a ring the effect continues past the end of the strip. ':'Without a ring, the part shifted past the edge stays dark. ')+
  'Click the preview to set the point.';
 const pick=ORIGIN_MODES.includes(mode);
 document.body.classList.toggle('center-pick',pick);
 $('origin-tip').hidden=!pick;
 $('origin-tip-text').textContent=centered?'Click an LED to set the center':'Click an LED to set the start';
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
 const cssW=canvas.clientWidth||300,cssH=canvas.clientHeight||128;
 const cw=Math.round(cssW*dpi),ch=Math.round(cssH*dpi);
 if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
 const ctx=canvas.getContext('2d');ctx.setTransform(dpi,0,0,dpi,0,0);
 const pad=10,w=cssW-pad*2,h=cssH-pad*2,X=v=>pad+v*w,Y=v=>pad+(1-v/255)*h;
 ctx.clearRect(0,0,cssW,cssH);
 ctx.fillStyle='rgba(142,155,255,.09)';ctx.fillRect(X(s['input-min']/255),pad,X(s['input-max']/255)-X(s['input-min']/255),h);
 ctx.strokeStyle='#1d222c';ctx.lineWidth=1;ctx.beginPath();
 for(const v of [0,.25,.5,.75,1]){ctx.moveTo(X(v),pad);ctx.lineTo(X(v),pad+h);}
 for(const v of [0,127.5,255]){ctx.moveTo(pad,Y(v));ctx.lineTo(pad+w,Y(v));}
 ctx.stroke();
 ctx.strokeStyle='#8e9bff';ctx.lineWidth=2;ctx.lineJoin='round';ctx.beginPath();
 for(let i=0;i<=w;i++){const v=i/w,y=Y(transferValue(v,s));if(i)ctx.lineTo(X(v),y);else ctx.moveTo(X(v),y);}
 ctx.stroke();
 if(Number.isFinite(input)){
  const v=Math.max(0,Math.min(1,input)),y=transferValue(v,s);
  ctx.strokeStyle='rgba(90,209,160,.35)';ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(X(v),pad+h);ctx.lineTo(X(v),Y(y));ctx.lineTo(pad,Y(y));ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#5ad1a0';ctx.beginPath();ctx.arc(X(v),Y(y),4.5,0,Math.PI*2);ctx.fill();
 }
 ctx.fillStyle='#8a93a3';ctx.font='10px system-ui,sans-serif';
 ctx.textAlign='right';ctx.fillText('signal →',pad+w-4,pad+h-5);ctx.textAlign='left';ctx.fillText('↑ reaction',pad+4,pad+11);
}

// Logical LED (x, y) under a click on the new-DSP preview canvas.
function previewLed(canvas,ev,g){
 const r=canvas.getBoundingClientRect(),px=ev.clientX-r.left,py=ev.clientY-r.top;
 let x,row;
 if(isStrip(g)){
  const L=STATE.stripLayout||stripLayout(g.w,g.h,r.width);
  row=Math.min(g.h-1,Math.floor(py/(L.rowHeight+L.gap)));
  const line=Math.min(L.linesPerRow-1,Math.floor((py-row*(L.rowHeight+L.gap))/L.pitch));
  x=line*L.perLine+Math.max(0,Math.min(L.perLine-1,Math.floor((px-L.offsetX)/L.pitch)));
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
 // Defaults on All lamps, the shared values on a lamp (resetSection in lamps.js).
 $('range-reset').onclick=()=>resetSection(['input-min','input-max','input-curve','audio-min','audio-max','input-gate']);
 $('viz-reset').onclick=()=>resetSection(['viz-color','viz-auto','viz-mirror','viz-decay','viz-speed']);
 $('origin-reset').onclick=()=>resetSection(['origin-shift','origin-y','origin-reverse','origin-ring','origin-radial']);
 $('canvas-new').addEventListener('click',pickOrigin);
}
