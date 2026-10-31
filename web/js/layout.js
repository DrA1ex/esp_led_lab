'use strict';
// Layout tab: how the LEDs are mounted (ring, centre offset, flips) and the
// orientation test. Lamps with the "layout" capability keep their layout
// themselves (firmware LayoutConfig: saved on the lamp, applied to every
// effect through Led::get_index); the lab reads it from hello_ack and writes
// the field that changed. The controls show the edited lamp's layout; on All
// lamps they show the preview's, and a change goes to every connected lamp.
// The preview draws the same mapping, so it looks like the lamp.

const LAYOUT_FIELDS={'layout-ring':'ring','layout-offset':'offset','layout-flip-x':'flip_x','layout-flip-y':'flip_y'};
const LAYOUT_KEY='esp-led-lab.layout';
const DEFAULT_LAYOUT={ring:false,offset:0,flip_x:false,flip_y:false};
function normalizeLayout(l){
 l=l&&typeof l==='object'?l:{};
 return {ring:Boolean(l.ring),offset:Number.isFinite(+l.offset)?Math.round(+l.offset):0,flip_x:Boolean(l.flip_x),flip_y:Boolean(l.flip_y)};
}
const LAYOUT={shared:{...DEFAULT_LAYOUT},test:false,shown:''};
try{LAYOUT.shared=normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY)||'null'));}catch(_){}
const saveSharedLayout=()=>{try{localStorage.setItem(LAYOUT_KEY,JSON.stringify(LAYOUT.shared));}catch(_){}};

// The layout a lamp reported (or last reported, kept in its profile).
const lampLayout=d=>d.layout||lampProfile(d).layout||null;
// The layout the controls and the preview show.
function currentLayout(){
 const d=targetLamp();
 return normalizeLayout(d?lampLayout(d)||LAYOUT.shared:LAYOUT.shared);
}
// Firmware Layout::rotation / Layout::originShift.
const layoutRotation=(l,w)=>l.ring&&w>0?((l.offset%w)+w)%w:0;
const layoutOriginShift=l=>l.ring?0:l.flip_x?-l.offset:l.offset;
// Logical (x, y) -> the column / row it is wired to (firmware Layout::index
// before the serpentine): flips first, then a ring turns.
function layoutMapper(l,w,h){
 const rot=layoutRotation(l,w);
 return (x,y)=>{
  if(l.flip_x)x=w-1-x;
  if(l.flip_y)y=h-1-y;
  if(rot&&(x+=rot)>=w)x-=w;
  return [x,y];
 };
}

// Lamps a change goes to: the edited one, or every connected one on All lamps.
const layoutTargets=()=>{const d=targetLamp();return d?[d]:REMOTE.controllable;};
function writeLayout(id,value){
 const field=LAYOUT_FIELDS[id],d=targetLamp();
 if(!d){LAYOUT.shared[field]=value;saveSharedLayout();}
 for(const lamp of layoutTargets()){
  // An offset on All lamps is the same share of each lamp's width.
  let v=value;
  if(field==='offset'&&!d){const w=lampSize(lamp)?.w,sw=currentGeometry().w;if(w&&w!==sw)v=Math.round(value*w/sw);}
  const next={...normalizeLayout(lampLayout(lamp)||LAYOUT.shared),[field]:v};
  lampProfile(lamp).layout=next;scheduleProfiles();
  lamp.setLayout({[field]:v});
 }
}
function loadLayoutEditor(){
 const l=currentLayout();
 $('layout-offset').min=-512;$('layout-offset').max=512; // refreshLayoutUi narrows it to the LED count
 for(const [id,field] of Object.entries(LAYOUT_FIELDS))setControl($(id),l[field]);
 LAYOUT.shown=JSON.stringify(l);
}
// A lamp reported its layout (hello_ack, layout_ack): show it unless it is
// being edited. Not refreshLabels: that commits the controls to the target,
// which may just have gone away.
function layoutDevicesChanged(){
 for(const d of REMOTE.devices)if(d.layout&&JSON.stringify(d.layout)!==JSON.stringify(lampProfile(d).layout)){lampProfile(d).layout=d.layout;scheduleProfiles();}
 const busy=Object.keys(LAYOUT_FIELDS).includes(document.activeElement?.id);
 if(!busy&&JSON.stringify(currentLayout())!==LAYOUT.shown){loadLayoutEditor();refreshLayoutUi(currentGeometry());}
 syncLayoutTest();
}
// The orientation test runs on the edited lamp(s) while the switch is on.
function syncLayoutTest(){
 const targets=layoutTargets();
 for(const d of REMOTE.devices)d.wantTest(LAYOUT.test&&targets.includes(d));
}

function refreshLayoutUi(g){
 const l=currentLayout(),offset=$('layout-offset'),half=Math.max(1,Math.floor(g.w/2));
 if(+offset.max!==half){offset.min=-half;offset.max=half;}
 const unit=isStrip(g)?'LED':'col.',v=+offset.value;
 $('layout-offset-value').textContent=`${v>0?'+':''}${v} ${unit}`;
 // Where the centre (Center modes, the test's yellow mark) and the start land on the wiring.
 const map=layoutMapper(l,g.w,1),shift=layoutOriginShift(l),centre=Math.floor(g.w/2)+shift,start=shift;
 const at=x=>x<0||x>=g.w?'off the end':`${isStrip(g)?'LED':'column'} ${map(x,0)[0]+1} of ${g.w}`;
 $('layout-hint').textContent=`Center: ${at(centre)}. Start: ${at(start)}, running ${map(Math.min(g.w-1,Math.max(0,start))+1,0)[0]<map(Math.min(g.w-1,Math.max(0,start)),0)[0]?'backwards':'forwards'} along the wiring. `+
  (l.ring?'On a ring the whole picture turns, the built-in effects too.':'An open strip cannot turn: the offset moves the start and center of the audio modes, and the part past the end stays dark.');
 const d=targetLamp(),lamps=layoutTargets(),old=lamps.filter(x=>!x.acceptsLayout);
 $('layout-target').textContent=d?(d.acceptsLayout?`Saved on ${lampName(d)}; every effect uses it.`:
  d.controllable?`${lampName(d)} runs firmware without layout support: only the preview uses these.`:`${lampName(d)} is not connected: this is its last reported layout, and changes only reach the preview; the lamp's own is read when it connects.`):
  (lamps.length?`All lamps: a change is written to ${lamps.length} connected lamp${lamps.length>1?'s':''}${old.length?` (${old.length} without layout support)`:''} and to the preview.`:'All lamps: no lamp connected, so only the preview changes.');
}

function initLayout(){
 for(const id of Object.keys(LAYOUT_FIELDS)){
  const el=$(id),send=()=>{writeLayout(id,el.type==='checkbox'?el.checked:+el.value);LAYOUT.shown=JSON.stringify(currentLayout());refreshLabels();};
  el.addEventListener(el.type==='checkbox'?'change':'input',send);
 }
 for(const [id,step] of [['layout-offset-down',-1],['layout-offset-up',1]])$(id).onclick=()=>{
  const el=$('layout-offset'),v=Math.max(+el.min,Math.min(+el.max,+el.value+step));
  if(v!==+el.value){el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));}
 };
 $('layout-reset').onclick=()=>{
  const l=currentLayout();
  for(const [id,field] of Object.entries(LAYOUT_FIELDS))if(l[field]!==DEFAULT_LAYOUT[field]){setControl($(id),DEFAULT_LAYOUT[field]);writeLayout(id,DEFAULT_LAYOUT[field]);}
  LAYOUT.shown=JSON.stringify(currentLayout());refreshLabels();
 };
 $('layout-test').addEventListener('change',e=>{LAYOUT.test=e.target.checked;syncLayoutTest();});
 loadLayoutEditor();
}
