'use strict';
// LED geometry: square/rectangular matrices and LED strips (HEIGHT = 1 or a
// few rows). The firmware addresses both through the same row-serpentine
// Led::get_index(x, y), so the WASM renderer only needs WIDTH x HEIGHT.
const GEOMETRY_LIMITS={maxW:1024,maxH:128,maxPixels:128*128};
const DEFAULT_GEOMETRY={w:16,h:16};

function clampGeometry(w,h){
 w=Math.max(1,Math.min(GEOMETRY_LIMITS.maxW,Math.round(+w)||1));
 h=Math.max(1,Math.min(GEOMETRY_LIMITS.maxH,Math.round(+h)||1));
 if(w*h>GEOMETRY_LIMITS.maxPixels)h=Math.max(1,Math.floor(GEOMETRY_LIMITS.maxPixels/w));
 return {w,h};
}
function parseGeometry(value){
 const m=/^(\d+)x(\d+)$/.exec(value||'');
 return m?clampGeometry(m[1],m[2]):null;
}
// A strip is long and only one or two rows high (e.g. 153x1, 72x2).
const isStrip=g=>g.h<=2&&g.w>=g.h*4;

// The first selected connected device that reported its WIDTH x HEIGHT.
function deviceGeometry(){
 const d=REMOTE.devices.find(d=>d.selected&&d.width>0&&d.height>0)||REMOTE.devices.find(d=>d.width>0&&d.height>0);
 return d?clampGeometry(d.width,d.height):null;
}
// The LED layout menu: the preview of All lamps.
function menuGeometry(){
 const sel=$('geometry').value;
 if(sel==='custom')return clampGeometry($('geom-w').value,$('geom-h').value);
 if(sel==='device')return deviceGeometry()||DEFAULT_GEOMETRY;
 return parseGeometry(sel)||DEFAULT_GEOMETRY;
}
// The preview: the edited lamp's own size when it is known (lamps.js), else the menu.
function currentGeometry(){return targetLampSize()||menuGeometry();}
function geometryLabel(g){
 if(!isStrip(g))return `${g.w} × ${g.h} · matrix`;
 return g.h>1?`${g.w} × ${g.h} · strip, ${g.h} rows`:`${g.w} LED · strip`;
}
// Select a preset when one matches, otherwise fill the custom fields.
function applyGeometry(w,h){
 const g=clampGeometry(w,h),id=`${g.w}x${g.h}`;
 const preset=[...$('geometry').options].find(o=>o.value===id);
 if(preset)$('geometry').value=id;
 else{$('geometry').value='custom';$('geom-w').value=g.w;$('geom-h').value=g.h;}
 refreshLabels();
}
function refreshGeometryUi(g){
 const strip=isStrip(g),lamp=targetLamp(),own=lamp&&lampSize(lamp);
 $('geometry-custom').hidden=$('geometry').value!=='custom';
 document.body.classList.toggle('strip-layout',strip);
 $('preview-title').textContent=strip?'LED strip':'LED matrix';
 $('geometry-icon').setAttribute('href',strip?'#i-strip':'#i-grid');
 // A lamp's preview has the size the lamp reports; the menu is the layout of All lamps.
 const button=$('geometry-button');button.disabled=Boolean(own);
 button.title=own?`${lampName(lamp)} reports ${g.w} × ${g.h}`:'LED layout: matrix or strip';
 const note=lamp&&!own?`${lampName(lamp)} has not reported its size yet; its preview uses this layout until it connects.`:
  $('geometry').value==='device'&&!deviceGeometry()?
  'Connect a lamp on the Lamps tab: the size comes from its hello_ack (WIDTH × HEIGHT). Using 16 × 16 until then.':
  'A strip is HEIGHT = 1 (or 2 rows). Addressing is serpentine, like Led::get_index; long strips wrap onto several display lines.';
 $('geometry-note').textContent=note;
}

// Strip preview: wrap each logical row onto several display lines so every
// LED stays visible (153 LEDs in a 300 px card would be 2 px each otherwise).
// Lines are laid out left to right in LED order; logical rows are separated
// by a larger gap. Only presentation changes; the framebuffer stays linear.
// With maxHeight the LEDs grow (up to 32 px) while the wrapped rows still fit
// that height; the lines are then centered (offsetX).
function stripLayout(n,h,cssWidth,maxHeight=0){
 const gapOf=p=>h>1?p*.9:0;
 let perLine=Math.max(1,Math.min(n,Math.max(8,Math.floor(cssWidth/7)))),pitch=cssWidth/perLine;
 if(maxHeight>0){
  for(let lines=1;lines<=n;lines++){
   const k=Math.ceil(n/lines),p=Math.min(32,cssWidth/k);
   if(h*lines*p+(h-1)*gapOf(p)>maxHeight)break;
   if(p>=pitch){perLine=k;pitch=p;}
   if(p>=32||k===1)break;
  }
 }
 const linesPerRow=Math.ceil(n/perLine),gap=gapOf(pitch),rowHeight=linesPerRow*pitch;
 return {perLine,linesPerRow,pitch,gap,rowHeight,height:h*rowHeight+(h-1)*gap,offsetX:Math.max(0,(cssWidth-perLine*pitch)/2)};
}
