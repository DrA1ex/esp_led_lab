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
  'A strip is HEIGHT = 1 (or 2 rows). Addressing is serpentine, like Led::get_index. Each row is shown as one line; with Ring (Layout tab) the strip is drawn closed, round a rectangle.';
 $('geometry-note').textContent=note;
}

// Strip preview: each logical row is one line of LEDs, as on the lamp (a
// 2-row strip is two lines); a closed strip (Layout → Ring) runs round the edge of a
// rectangle with the stage's proportions, from the top-left corner clockwise,
// the second row inside the first. Only presentation changes; the framebuffer
// stays linear. Returns the centre of every LED (cx / cy, index y * n + x,
// CSS px), whether it sits on a vertical side (vert), the spacing along the
// strip (pitch, up to 32 px) and the LED size across it (band, at least
// MIN_BAND so a dense strip stays visible).
const MIN_BAND=12;
function stripLayout(n,h,cssWidth,maxHeight=0,ring=false){
 const cx=new Float32Array(n*h),cy=new Float32Array(n*h),vert=new Uint8Array(n*h);
 if(!ring){
  const pitch=Math.min(32,cssWidth/n),band=Math.max(MIN_BAND,pitch),gap=h>1?band*.6:0;
  const offsetX=(cssWidth-n*pitch)/2;
  for(let y=0;y<h;y++)for(let x=0;x<n;x++){cx[y*n+x]=offsetX+(x+.5)*pitch;cy[y*n+x]=y*(band+gap)+band/2;}
  return {ring,pitch,band,gap,cx,cy,vert,width:cssWidth,height:h*band+(h-1)*gap};
 }
 // The rectangle takes the stage's aspect (or 2:1 when its height is unknown).
 const height=Math.max(48,maxHeight>0?Math.min(maxHeight,cssWidth):cssWidth/2);
 let pitch=0,band=MIN_BAND;
 for(let k=0;k<3;k++){
  const inset=band/2+(h-1)*band*1.6,w=cssWidth-2*inset,hh=height-2*inset;
  pitch=Math.min(32,2*Math.max(1,w+hh)/n);band=Math.max(MIN_BAND,pitch);
 }
 for(let y=0;y<h;y++){
  const inset=band/2+y*band*1.6,w=Math.max(1,cssWidth-2*inset),hh=Math.max(1,height-2*inset),per=2*(w+hh);
  for(let x=0;x<n;x++){
   let d=(x+.5)/n*per,px,py,v=0;
   if(d<w){px=d;py=0;}
   else if((d-=w)<hh){px=w;py=d;v=1;}
   else if((d-=hh)<w){px=w-d;py=hh;}
   else{d-=w;px=0;py=hh-d;v=1;}
   cx[y*n+x]=inset+px;cy[y*n+x]=inset+py;vert[y*n+x]=v;
  }
 }
 return {ring,pitch,band,gap:0,cx,cy,vert,width:cssWidth,height};
}
// The LED (index y * n + x) nearest to a point of the strip preview.
function stripLedAt(L,px,py){
 let best=0,dist=Infinity;
 for(let i=0;i<L.cx.length;i++){const d=(L.cx[i]-px)**2+(L.cy[i]-py)**2;if(d<dist){dist=d;best=i;}}
 return best;
}
