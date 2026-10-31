'use strict';
// Audio tab tuning shared by the preview and the lamp: signal window, the
// radial centre on matrices, the transfer curve and mode-dependent
// visibility. The rules mirror firmware audioTransfer() and
// RemoteReactive::OriginMap; the start / centre along the LEDs comes from
// the lamp layout (layout.js).

// Visualizations (viz_engine.h, shared with the firmware). A lamp renders the
// ones its hello_ack lists in "visualizations"; older firmware gets Off.
const LAB_MODES=[13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35];
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
 31:'Notes. Chromatic Flow: soft, slowly drifting color regions, one per note that sounds (the 12 pitch classes of a separate long analysis), each in its note\'s place on the palette — a single note fills the lamp, a chord shares it. Bass hits and beats only add a glow and swell the regions a little. Lamps get the notes when their firmware lists “chroma”.',
 32:'Bass, mid and treble. Energy: three bars from the start, as long as the bass, the mids and the treble are loud; where they overlap the shortest is drawn on top, so all three show (Effect parameters can put the treble or the bass on top), with soft edges. Matrices fill from the bottom like the VU meter. Colors can turn on every beat.',
 33:'Bass, mid and treble. Scroll: the sound\'s color enters at the start every frame and flows outwards — bass, mids and treble mixed by their loudness. Motion speed is in strip lengths per second, so long strips scroll as fast as short ones; Fall-off sets the trail. Rings from the centre on a matrix.',
 34:'Bass, mid and treble. Water: ripples on the wave equation — the bass drops in at both ends and the middle (the centre of a matrix), the mids and the treble at drifting places, and the waves run, cross and fade. Motion speed sets how fast they run, Viscosity how soon they calm down.',
 35:'Loudness and bass. Lava lamp: three slow waves multiplied into soft blobs that drift along the palette; the bass speeds them up and swells them, the loudness sets the light. One wave runs across and one up on a matrix.'
};

// The renderer's origin (render.cpp set_origin): an open strip's layout
// offset moves the audio modes' start / centre (permille of WIDTH); flips
// and a ring's turn are applied when the frame is drawn, as on the lamp.
function originArgs(s,l,w){
 const permille=Math.max(-500,Math.min(500,Math.round(layoutOriginShift(l)*1000/Math.max(1,w))));
 return [permille,s['origin-y'],0,0,s['origin-radial']?1:0];
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
// The lamp's layout replaces origin_shift / origin_reverse / origin_ring.
function tuningConfig(s){
 return {input_min:s['input-min'],input_max:s['input-max'],input_gate:s['input-gate'],input_curve:curveExponent(s),
  origin_y:s['origin-y'],origin_radial:s['origin-radial']};
}
// audioTransfer() on a 0..1 input with count = 255.
function transferValue(v,s){
 const lo=Math.min(s['audio-min'],s['audio-max']),hi=s['audio-max'];
 const inMin=s['input-min'],inMax=s['input-max'],x=Math.max(0,Math.min(1,v))*255;
 if(x<inMin)return s['input-gate']?0:lo;
 if(x>=inMax)return hi;
 return lo+Math.pow((x-inMin)/(inMax-inMin),curveExponent(s)/100)*(hi-lo);
}

function refreshTuningUi(s,g){
 const mode=s['audio-mode'];
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
 $('origin-y-value').textContent=Math.round(s['origin-y']/10)+'%';
 $('input-min-value').textContent=Math.round(s['input-min']/2.55)+'%';
 $('input-max-value').textContent=Math.round(s['input-max']/2.55)+'%';
 const curve=curveExponent(s);
 $('input-curve-value').textContent=curve===100?'linear':`×${(curve/100).toFixed(2)}`;
 const strip=g.h<4;
 $('viz-mirror-label').textContent=strip?'From the center, both ways':'Mirror vertically (from the middle row)';
 $('viz-decay-value').textContent=s['viz-decay']+'%';$('viz-speed-value').textContent=s['viz-speed']+'%';
 // Contrast works on the auto-levelled range; blur 100% = a Gaussian of 3 LEDs (sigma, as in the engine).
 $('viz-contrast').disabled=!s['viz-auto'];$('viz-contrast-value').textContent=s['viz-auto']?s['viz-contrast']+'%':'needs auto-level';
 $('viz-blur-value').textContent=s['viz-blur']?`${(s['viz-blur']*.03).toFixed(1)} LED`:'off';
 $('viz-hint').textContent=(strip?`Strip (${g.w}×${g.h}): every row shows the same.`:`Matrix (${g.w}×${g.h}).`)+
  ` Spectrum uses ${previewBands()} bands, the count sent to the lamp (Lamps → Stream settings).`+
  ' A lamp whose firmware does not list this mode in hello_ack is sent Off.';
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

function initTuning(){
 for(const id of ['input-min','input-max'])$(id).addEventListener('input',()=>keepWindow(id));
 // Defaults on All lamps, the shared values on a lamp (resetSection in lamps.js).
 $('range-reset').onclick=()=>resetSection(['input-min','input-max','input-curve','audio-min','audio-max','input-gate']);
 $('viz-reset').onclick=()=>resetSection(['viz-color','viz-auto','viz-contrast','viz-mirror','viz-decay','viz-speed','viz-blur']);
 $('origin-reset').onclick=()=>resetSection(['origin-y','origin-radial']);
}
