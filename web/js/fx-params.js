'use strict';
// Effect parameters of the visualizations: up to 11 values 0..255 per mode,
// in the order of Viz::paramDefaults() (src/viz_engine.h), sent to lamps with
// the "params" capability (docs/REMOTE_OUTPUT.md). Each one is an ordinary
// control (id fx-<mode>-<key>), so it is saved, reset and set per lamp like
// the other Reaction settings. tests/test_fx_params.js checks the defaults
// and counts against the engine.
const FX_PARAMS_VERSION=1,FX_MAX=11;
const fxPct=v=>Math.round(v/2.55)+'%';
const fxTimes=base=>v=>'×'+(v/base).toFixed(2);
const fxSigned=v=>v===128?'0':`${v>128?'+':'−'}${Math.round(Math.abs(v-128)/1.27)}%`;
const fxMsText=t=>t>=1000?(t/1000).toFixed(1)+' s':Math.round(t)+' ms';
const fxMs=(base,step)=>v=>fxMsText(base+v*step);
const fxQ12=v=>Math.round(v*16/40.96)+'%';
// The last parameter from Particles (26) on: the mode's light, 128 = as drawn.
const fxBrightness={key:'brightness',label:'Brightness',min:16,def:128,fmt:fxTimes(128)};
// A band position 0..255 of the spectrum, as the band's centre frequency.
function fxBandText(v){
 const n=typeof previewBands==='function'?previewBands():16,b=Math.floor(v*(n-1)/255);
 let hz='';
 try{const r=frequencyRange();hz=' · '+formatHz(roundHz(r.lo*Math.pow(r.hi/r.lo,(b+.5)/n)));}catch(_){}
 return `band ${b+1}/${n}${hz}`;
}
// key, label; then `choices` (a select), `toggle` (a checkbox, 0/1) or a range
// with min / max (0..255 by default), `fmt`, `center` (128 = neutral).
// `when(s)` hides a parameter that does nothing with the others as set.
const FX_PARAMS={
 13:[{key:'colors',label:'Colors',choices:['Along','By level','By tone'],def:0},
     {key:'peak',label:'Peak dot',toggle:true,def:1}],
 14:[{key:'colors',label:'Colors',choices:['By height','By band','By level'],def:0},
     {key:'peaks',label:'Falling peaks',toggle:true,def:1}],
 16:[{key:'trigger',label:'Launched by',choices:['Any onset','Bass','Mid','Treble','Beats'],def:0},
     {key:'width',label:'Width',def:24,fmt:v=>(Math.max(4,v)/16).toFixed(1)+' LED'},
     {key:'glow',label:'Glow with the level',def:31,fmt:fxPct}],
 17:[{key:'density',label:'Treble sparks',def:64,fmt:fxTimes(64)},
     {key:'burst',label:'Sparks per hit',def:13,fmt:v=>Math.round(v/2.56)+'% of LEDs'},
     {key:'glow',label:'Bass glow',def:89,fmt:fxPct},
     {key:'colors',label:'Colors',choices:['By group','Random','By tone'],def:0}],
 18:[{key:'map',label:'Drawn from',choices:['Level','Spectrum'],def:0},
     {key:'spread',label:'Color spread',def:48,fmt:fxPct},
     {key:'flash',label:'Bass flash',def:90,fmt:fxQ12},
     {key:'tone',label:'Tone range',def:200,fmt:fxPct}],
 19:[{key:'colors',label:'Colors',choices:['Classic','Along the history','By tone'],def:0}],
 21:[{key:'fuel',label:'Fuel',choices:['Bands','Bass','Loudness','Hits only'],def:0},
     {key:'height',label:'Flame height',def:170,fmt:fxPct},
     {key:'intensity',label:'Intensity',def:140,fmt:fxPct},
     {key:'flares',label:'Flares on hits',def:140,fmt:fxPct},
     {key:'wind',label:'Wind',def:128,center:true,fmt:fxSigned,matrix:true},
     {key:'blend',label:'Flames merge',def:140,fmt:fxPct,matrix:true},
     {key:'colors',label:'Colors',choices:['Heat','Palette by heat','Palette by tone'],def:0},
     {key:'embers',label:'Embers',def:60,fmt:fxPct}],
 22:[{key:'map',label:'Drawn from',choices:['Level','Spectrum'],def:0},
     {key:'zoom',label:'Zoom',def:64,fmt:fxTimes(64)},
     {key:'fullness',label:'Threshold',def:128,fmt:fxPct},
     {key:'spread',label:'Color spread',def:90,fmt:fxPct},
     {key:'flash',label:'Bass flash',def:77,fmt:fxQ12}],
 23:[{key:'dots',label:'Dots',min:1,max:8,def:8,fmt:String},
     {key:'size',label:'Dot size',def:128,fmt:fxTimes(128)}],
 24:[{key:'spin',label:'Spin',def:128,fmt:fxTimes(128)},
     {key:'core',label:'Bass core',def:90,fmt:fxPct}],
 25:[{key:'size',label:'Blob size',def:128,fmt:fxTimes(128)},
     {key:'count',label:'Blobs',min:1,max:4,def:4,fmt:String},
     {key:'softness',label:'Softness',def:127,fmt:fxPct}],
 26:[{key:'shape',label:'Shape',choices:['Fountain','Rain','Bursts','Bubbles','Comets'],def:0},
     {key:'trigger',label:'Launched by',choices:['Bands','Bass','Mid','Treble','Any hit','Beats','Stream'],def:0},
     {key:'amount',label:'Amount',def:100,fmt:v=>(1+Math.floor(v*15/255))+' per hit'},
     {key:'speed',label:'Speed',def:100,fmt:v=>((1024+v*81)/4096).toFixed(1)+' lamps/s'},
     {key:'gravity',label:'Gravity',def:170,center:true,fmt:fxSigned},
     {key:'spread',label:'Spread',def:90,fmt:fxPct},
     {key:'life',label:'Life',def:110,fmt:fxMs(150,15)},
     {key:'trail',label:'Trail',def:90,fmt:fxMs(20,4)},
     {key:'colors',label:'Colors',choices:['By frequency','By tone','Random','Cooling'],def:0},
     fxBrightness],
 27:[{key:'pattern',label:'Pattern',choices:['Clouds','Plasma','Rings','Stripes','Spiral'],def:0},
     {key:'zoom',label:'Zoom',def:100,fmt:v=>((8+v)/32).toFixed(1)+' waves'},
     {key:'flow',label:'Flow',def:80,fmt:fxPct},
     {key:'map',label:'Lit by',choices:['Level','Spectrum'],def:1},
     {key:'drive',label:'Driven by',choices:['Loudness','Bass','Mid','Treble','Beats'],def:1},
     {key:'pump',label:'Pump',def:120,fmt:fxPct},
     {key:'kick',label:'Kick on hits',def:100,fmt:fxPct},
     {key:'contrast',label:'Contrast',def:60,fmt:fxPct},
     {key:'colors',label:'Color spread',def:120,fmt:fxPct},
     {key:'drift',label:'Color drift',def:30,fmt:fxPct},
     fxBrightness],
 28:[{key:'zones',label:'Zones',min:1,max:16,def:8,fmt:String},
     {key:'layout',label:'Layout',choices:['Columns','Rows','Rings','Sectors','Tiles'],def:0,matrix:true},
     {key:'trigger',label:'Lit by',choices:['Equalizer','Band hits','Bass','Mid','Treble','Any hit','Beats'],def:0},
     {key:'pattern',label:'On a hit',choices:['All','Chase','Random','Alternate','Bounce','Build up'],def:1,when:s=>s['fx-28-trigger']>=2},
     {key:'decay',label:'Decay',def:100,fmt:fxMs(50,6)},
     {key:'glow',label:'Glow with the level',def:40,fmt:fxPct},
     {key:'colors',label:'Colors',choices:['By zone','By what hit','New each hit','By tone'],def:0},
     {key:'edge',label:'Borders',def:60,fmt:fxPct},
     fxBrightness],
 29:[{key:'from',label:'From',def:40,fmt:fxBandText},
     {key:'to',label:'To',def:200,fmt:fxBandText},
     {key:'style',label:'Style',choices:['Dot','Bar','Trace'],def:0},
     {key:'glide',label:'Glide',def:80,fmt:fxMs(10,3)},
     {key:'size',label:'Size',def:100,fmt:v=>((128+v*4)/128).toFixed(1)+' LED'},
     {key:'trail',label:'Trail',def:120,fmt:v=>fxMsText(20+v*4)},
     {key:'colors',label:'Colors',choices:['By note','By tone','By level'],def:0},
     {key:'gate',label:'Ignore below',def:40,fmt:fxQ12},
     fxBrightness],
 30:[{key:'shape',label:'Shape',choices:['Rings','Spin','Stripes','Bounce'],def:0},
     {key:'step',label:'Step per beat',def:64,fmt:v=>(v/128).toFixed(2)+' period'},
     {key:'snap',label:'Snap to the beat',def:200,fmt:fxPct},
     {key:'pump',label:'Bass expansion',def:160,fmt:fxPct},
     {key:'zoom',label:'Zoom',def:100,fmt:v=>((8+v)/32).toFixed(1)+' periods'},
     {key:'sparks',label:'Treble sparks',def:100,fmt:fxPct},
     {key:'colors',label:'Colors',choices:['Along the pattern','By tone','New each beat'],def:0},
     fxBrightness],
 31:[{key:'order',label:'Notes on the palette',choices:['Circle of fifths','Semitones'],def:0},
     {key:'shift',label:'C at',def:0,fmt:v=>Math.round(v/2.55)+'% of the palette'},
     {key:'follow',label:'Follow',def:100,fmt:fxMs(50,8)},
     {key:'focus',label:'Focus',def:80,fmt:v=>v?`under ${Math.round(v/2.56)}% of the strongest: out`:'every note'},
     {key:'zoom',label:'Zoom',min:4,def:80,fmt:fxTimes(80)},
     {key:'flow',label:'Drift',def:60,fmt:fxPct},
     {key:'blend',label:'Soft borders',def:128,fmt:fxPct},
     {key:'glow',label:'Glow on hits',def:90,fmt:fxPct},
     {key:'swell',label:'Swell on hits',def:60,fmt:fxPct},
     fxBrightness],
 32:[{key:'reach',label:'Reach',def:128,fmt:fxTimes(128)},
     {key:'colors',label:'Colors',choices:['Groups','By tone','Turn on beats'],def:0},
     {key:'order',label:'On top',choices:['Shortest','Treble','Bass'],def:0},
     {key:'edge',label:'Soft edge',def:64,fmt:v=>((256+v*12)/256).toFixed(1)+' LED'},
     fxBrightness],
 33:[{key:'threshold',label:'Ignore below',def:30,fmt:v=>Math.round(v*20/40.96)+'%'},
     {key:'colors',label:'Colors',choices:['Mix','By tone','Along the lamp'],def:0},
     fxBrightness],
 34:[{key:'bass',label:'Bass drops',def:128,fmt:fxTimes(128)},
     {key:'mid',label:'Mid drops',def:128,fmt:fxTimes(128)},
     {key:'treble',label:'Treble drops',def:128,fmt:fxTimes(128)},
     {key:'viscosity',label:'Viscosity',def:128,fmt:fxPct},
     {key:'colors',label:'Colors',choices:['By height','By tone','Along the lamp'],def:0},
     fxBrightness],
 35:[{key:'reactivity',label:'Bass reactivity',def:128,fmt:fxTimes(128)},
     {key:'contrast',label:'Contrast',def:180,fmt:fxPct},
     {key:'zoom',label:'Zoom',def:96,fmt:v=>((16+v)/64).toFixed(2)+' waves along'},
     {key:'colors',label:'Colors',choices:['Drift','By tone'],def:0},
     fxBrightness]
};
// Engine order: the controls above list some parameters in another order (map first).
const FX_ORDER={
 18:['spread','flash','tone','map'],
 22:['zoom','fullness','spread','flash','map']
};
const fxId=(mode,key)=>`fx-${mode}-${key}`;
const fxKeys=mode=>FX_ORDER[mode]||(FX_PARAMS[mode]||[]).map(p=>p.key);
const FX_IDS=Object.keys(FX_PARAMS).flatMap(mode=>FX_PARAMS[mode].map(p=>fxId(mode,p.key)));
const FX_MODES=Object.keys(FX_PARAMS).map(Number);
// The values for `mode` (lab numbering) from settings `s`, in engine order.
function fxValues(s,mode){
 const byKey=Object.fromEntries((FX_PARAMS[mode]||[]).map(p=>[p.key,p]));
 return fxKeys(mode).map(key=>{
  const v=s[fxId(mode,key)],p=byKey[key];
  if(p.toggle)return v?1:0;
  return Math.max(0,Math.min(255,Math.round(+v)||0));
 });
}
const fxDefaults=mode=>{const byKey=Object.fromEntries((FX_PARAMS[mode]||[]).map(p=>[p.key,p]));return fxKeys(mode).map(k=>byKey[k].def);};

// Controls, one group per mode (shown by data-modes like the other fields).
(function buildFxControls(){
 const box=$('fx-params');if(!box)return;
 for(const mode of FX_MODES){
  const group=document.createElement('div');group.className='fx-group';group.dataset.modes=String(mode);
  for(const p of FX_PARAMS[mode]){
   const id=fxId(mode,p.key);let field;
   if(p.choices){
    field=document.createElement('div');field.className='field';
    const title=document.createElement('span'),select=document.createElement('select'),choices=document.createElement('div');
    title.className='field-label';title.id=id+'-title';title.textContent=p.label;
    select.id=id;select.hidden=true;
    p.choices.forEach((name,i)=>{const o=new Option(name,String(i),i===p.def,i===p.def);select.append(o);});
    choices.className='choices '+(p.choices.length<=3?'segmented':'chips');choices.dataset.for=id;choices.setAttribute('aria-labelledby',title.id);
    field.append(title,select,choices);
   }else if(p.toggle){
    field=document.createElement('label');field.className='check';
    const input=document.createElement('input'),text=document.createElement('span');
    input.type='checkbox';input.id=id;input.defaultChecked=input.checked=Boolean(p.def);text.textContent=p.label;
    field.append(input,text);
   }else{
    field=document.createElement('div');field.className='field';
    const label=document.createElement('label'),val=document.createElement('span'),input=document.createElement('input');
    label.htmlFor=id;label.append(p.label+' ');val.className='val';val.id=id+'-value';label.append(val);
    input.type='range';input.id=id;input.min=String(p.min??0);input.max=String(p.max??255);
    input.defaultValue=input.value=String(p.def);
    if(p.center)input.dataset.center='';
    field.append(label,input);
   }
   field.dataset.fx=id;
   group.append(field);
  }
  box.append(group);
 }
 inputIds.push(...FX_IDS);
})();
// Value labels; parameters that do nothing here (matrix-only ones on a strip,
// or with the others as set) are hidden.
function refreshFxUi(s,g){
 for(const mode of FX_MODES)for(const p of FX_PARAMS[mode]){
  const id=fxId(mode,p.key);
  if(p.fmt)$(id+'-value').textContent=p.fmt(+s[id]);
  document.querySelector(`[data-fx="${id}"]`).hidden=Boolean(p.matrix&&g.h<4||p.when&&!p.when(s));
 }
}
// The section reset covers the running mode's parameters only.
if($('fx-reset'))$('fx-reset').onclick=()=>{const mode=+$('audio-mode').value;resetSection((FX_PARAMS[mode]||[]).map(p=>fxId(mode,p.key)));};
