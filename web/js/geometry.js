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
function currentGeometry(){
 const sel=$('geometry').value;
 if(sel==='custom')return clampGeometry($('geom-w').value,$('geom-h').value);
 if(sel==='device')return deviceGeometry()||DEFAULT_GEOMETRY;
 return parseGeometry(sel)||DEFAULT_GEOMETRY;
}
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
 const strip=isStrip(g);
 $('geometry-custom').hidden=$('geometry').value!=='custom';
 document.body.classList.toggle('strip-layout',strip);
 $('preview-title').textContent=strip?'LED strip':'LED matrix';
 const note=$('geometry').value==='device'&&!deviceGeometry()?
  'Connect a lamp under Lamps over Wi-Fi: the size comes from hello_ack (WIDTH × HEIGHT). Using 16 × 16 until then.':
  'Same as WIDTH × HEIGHT in the firmware. A strip is HEIGHT = 1 (or 2 rows). Serpentine addressing, like Led::get_index.';
 $('geometry-note').textContent=note;
}

// Strip preview: wrap each logical row onto several display lines so every
// LED stays visible (153 LEDs in a 300 px card would be 2 px each otherwise).
// Lines are laid out left to right in LED order; logical rows are separated
// by a larger gap. Only presentation changes; the framebuffer stays linear.
function stripLayout(n,h,cssWidth){
 const minPitch=7;
 const perLine=Math.max(1,Math.min(n,Math.max(8,Math.floor(cssWidth/minPitch))));
 const linesPerRow=Math.ceil(n/perLine);
 const pitch=cssWidth/perLine;
 const gap=h>1?pitch*.9:0;
 const rowHeight=linesPerRow*pitch;
 return {perLine,linesPerRow,pitch,gap,rowHeight,height:h*rowHeight+(h-1)*gap};
}
