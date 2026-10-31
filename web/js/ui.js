'use strict';
// Interface components: radio choices bound to hidden <select>s (the selects
// stay the source of truth for settings()), slider fills and two-thumb ranges,
// popovers, the inspector tabs, where the music list lives, palette swatches
// and color-effect thumbnails, and settings remembered in this browser.
const WIDE='(min-width:1180px)',NARROW='(max-width:759px)';
const isWide=()=>matchMedia(WIDE).matches,isNarrow=()=>matchMedia(NARROW).matches;

// Choices: <div class="choices chips|tiles|swatches|segmented" data-for="select-id">
// becomes one radio per option, grouped by <optgroup>. Arrow keys move between
// them natively; picking one sets the select and fires its input/change events.
const CHOICES=[];
function buildChoices(box){
 const select=$(box.dataset.for),kind=box.classList.contains('tiles')?'tile':box.classList.contains('swatches')?'swatch':'chip';
 const inputs=new Map(),faces=new Map();
 box.setAttribute('role','radiogroup');
 const item=o=>{
  const label=document.createElement('label'),input=document.createElement('input'),face=document.createElement('span');
  label.className='choice choice-'+kind;
  input.type='radio';input.name='choice-'+select.id;input.value=o.value;
  const name=o.dataset.short||o.textContent;
  if(kind==='tile'){
   face.className='tile-box';
   const canvas=document.createElement('canvas');canvas.width=canvas.height=96;canvas.setAttribute('aria-hidden','true');
   const text=document.createElement('span');text.className='tile-name';text.textContent=name;
   face.append(canvas,text);
  }else if(kind==='swatch'){
   face.className='sw-box';
   const grad=document.createElement('span'),text=document.createElement('span');
   grad.className='sw-grad';text.className='sw-name';text.textContent=name;
   face.append(grad,text);
  }else face.textContent=name;
  const tip=select.id==='audio-mode'?MODE_HINTS[o.value]:o.textContent!==name?o.textContent:kind==='swatch'?name:'';
  if(tip)label.title=tip;
  input.addEventListener('change',()=>{
   if(!input.checked)return;
   select.value=input.value;
   select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));
  });
  label.append(input,face);inputs.set(o.value,input);faces.set(o.value,face);
  return label;
 };
 let loose=null;
 for(const child of select.children){
  if(child.tagName==='OPTGROUP'){
   const group=document.createElement('div'),title=document.createElement('span'),row=document.createElement('div');
   group.className='choice-group';title.className='choice-group-label';title.textContent=child.label;row.className='choice-row';
   for(const o of child.children)row.append(item(o));
   group.append(title,row);box.append(group);loose=null;
  }else{
   if(kind!=='chip'||!select.querySelector('optgroup'))box.append(item(child));
   else{if(!loose){loose=document.createElement('div');loose.className='choice-row';box.append(loose);}loose.append(item(child));}
  }
 }
 CHOICES.push({select,inputs,faces});
}
function syncChoices(){
 for(const {select,inputs} of CHOICES){
  for(const o of select.options){const input=inputs.get(o.value);if(!input)continue;input.disabled=o.disabled;input.checked=o.value===select.value;}
 }
 $('palette-name').textContent=$('palette').selectedOptions[0]?.textContent||'';
}
const choiceFace=(selectId,value)=>CHOICES.find(c=>c.select.id===selectId)?.faces.get(String(value));

// Slider fills: --p (0..1) for one thumb, --a / --b on a .dual pair.
function paintRange(el){
 const min=+el.min||0,max=el.max===''?100:+el.max,f=x=>max>min?Math.max(0,Math.min(1,(+x.value-min)/(max-min))):0;
 const dual=el.parentElement?.classList.contains('dual')?el.parentElement:null;
 if(!dual){el.style.setProperty('--p',f(el).toFixed(4));return;}
 const [a,b]=dual.querySelectorAll('input');
 dual.style.setProperty('--a',f(a).toFixed(4));dual.style.setProperty('--b',f(b).toFixed(4));
 // The lower thumb goes on top in the upper half, so touching thumbs stay draggable.
 a.classList.toggle('on-top',f(a)>.5);
}
function paintRanges(){for(const el of document.querySelectorAll('input[type=range]'))paintRange(el);}
function setSeek(v){const el=$('seek');el.value=v;paintRange(el);}
document.addEventListener('input',e=>{if(e.target.type==='range')paintRange(e.target);},true);
// Reaction range: "from" never passes "to" (equal is allowed).
for(const [lo,hi] of [['audio-min','audio-max']]){
 $(lo).addEventListener('input',()=>{if(+$(lo).value>+$(hi).value)$(hi).value=$(lo).value;});
 $(hi).addEventListener('input',()=>{if(+$(hi).value<+$(lo).value)$(lo).value=$(hi).value;});
}
// Analyzer groups keep at least one band each; the tempo range stays 10 BPM wide.
for(const [lo,hi,gap] of [['split-mid','split-high',1],['bpm-min','bpm-max',10]]){
 $(lo).addEventListener('input',()=>{if(+$(lo).value>+$(hi).value-gap){const v=Math.min(+$(lo).value,+$(lo).max-gap);$(lo).value=v;$(hi).value=v+gap;}});
 $(hi).addEventListener('input',()=>{if(+$(hi).value<+$(lo).value+gap){const v=Math.max(+$(hi).value,+$(hi).min+gap);$(hi).value=v;$(lo).value=v-gap;}});
}

// Popovers: native [popover] placed under (or above) their button; bottom sheets on phones.
const POPOVER_API=typeof HTMLElement!=='undefined'&&Object.prototype.hasOwnProperty.call(HTMLElement.prototype,'popover');
const popoverButton=pop=>document.querySelector(`[popovertarget="${pop.id}"]`);
function placePopover(pop,button){
 if(isNarrow()||!button){pop.style.left=pop.style.top='';return;}
 const r=button.getBoundingClientRect(),w=pop.offsetWidth,h=pop.offsetHeight;
 const left=r.left+r.width/2>innerWidth/2?r.right-w:r.left;
 let top=r.bottom+6;
 if(top+h>innerHeight-8&&r.top-h-6>=8)top=r.top-h-6;
 pop.style.left=Math.round(Math.max(8,Math.min(innerWidth-w-8,left)))+'px';
 pop.style.top=Math.round(Math.max(8,top))+'px';
}
function initPopovers(){
 const pops=[...document.querySelectorAll('[popover]')];
 if(POPOVER_API){
  for(const pop of pops){
   const button=popoverButton(pop);button?.setAttribute('aria-expanded','false');
   pop.addEventListener('toggle',e=>{const open=e.newState==='open';if(open)placePopover(pop,button);button?.setAttribute('aria-expanded',String(open));});
  }
  addEventListener('resize',()=>{for(const p of pops)if(p.matches(':popover-open'))p.hidePopover();});
  return;
 }
 // Older browsers: a plain toggle; a click outside closes.
 const inline=pop=>pop.id==='volume-menu'&&isWide();
 for(const pop of pops){
  const button=popoverButton(pop);if(inline(pop))continue;
  pop.hidden=true;pop.style.position='fixed';pop.style.zIndex=200;
  button?.addEventListener('click',e=>{e.stopPropagation();const open=pop.hidden;for(const p of pops)if(!inline(p))p.hidden=true;pop.hidden=!open;if(open)placePopover(pop,button);});
  pop.addEventListener('click',e=>e.stopPropagation());
 }
 document.addEventListener('click',()=>{for(const p of pops)if(!inline(p))p.hidden=true;});
}

// Inspector tabs (Music exists as a tab only below the wide layout). The last tab is remembered.
const TAB_KEY='esp-led-lab.tab',TAB_ALIASES={audio:'reaction',led:'effect',dsp:'analyzer'};
const visibleTabs=()=>[...document.querySelectorAll('.tabs [data-tab]')].filter(t=>!(t.dataset.tab==='music'&&isWide()));
const currentTab=()=>document.querySelector('.tabs [aria-selected=true]')?.dataset.tab;
function selectTab(name,persist=true){
 const tabs=visibleTabs();name=TAB_ALIASES[name]||name;
 if(!tabs.some(t=>t.dataset.tab===name))name='effect';
 for(const t of document.querySelectorAll('.tabs [data-tab]')){const on=t.dataset.tab===name;t.setAttribute('aria-selected',String(on));t.tabIndex=on?0:-1;}
 for(const p of document.querySelectorAll('.tabpanel'))p.hidden=p.dataset.panel!==name;
 if(persist)try{localStorage.setItem(TAB_KEY,name);}catch(_){}
 if(name==='reaction')drawTransfer(NaN);
 refreshStageMode();
}
function initTabs(){
 const nav=document.querySelector('.tabs');
 for(const t of nav.querySelectorAll('[data-tab]'))t.onclick=()=>selectTab(t.dataset.tab);
 nav.addEventListener('keydown',e=>{
  const tabs=visibleTabs(),i=tabs.indexOf(document.activeElement);if(i<0)return;
  const j={ArrowLeft:i-1,ArrowRight:i+1,Home:0,End:tabs.length-1}[e.key];if(j===undefined)return;
  e.preventDefault();const t=tabs[(j+tabs.length)%tabs.length];selectTab(t.dataset.tab);t.focus();
 });
 let saved=null;try{saved=localStorage.getItem(TAB_KEY);}catch(_){}
 selectTab(saved||(isWide()?'effect':'music'),false);
}
// On phones the panels scroll with the page: bring the tabs up under the pinned stage.
function revealInspector(){
 if(!isNarrow())return;
 const top=$('inspector').getBoundingClientRect().top+scrollY-$('stage').offsetHeight;
 if(Math.abs(scrollY-top)>2)scrollTo({top,behavior:'smooth'});
}
function showPanel(name){
 if(name==='music')return showMusic();
 selectTab(name);revealInspector();
}

// The music list: its own column on wide screens, the Music tab otherwise.
const LIBRARY_KEY='esp-led-lab.library-collapsed';
function placeLibrary(){
 const wide=isWide(),target=wide?$('library-dock'):$('panel-music');
 if($('library').parentElement!==target)target.append($('library'));
 if(wide&&currentTab()==='music')selectTab('effect',false);
 $('library-toggle').setAttribute('aria-pressed',String(!document.body.classList.contains('library-collapsed')));
}
function setLibraryCollapsed(collapsed){
 document.body.classList.toggle('library-collapsed',collapsed);
 $('library-toggle').setAttribute('aria-pressed',String(!collapsed));
 try{localStorage.setItem(LIBRARY_KEY,collapsed?'1':'0');}catch(_){}
}
function showMusic(){
 if(isWide())setLibraryCollapsed(false);
 else{selectTab('music');revealInspector();}
 $('playlist').querySelector('.current')?.scrollIntoView({block:'nearest'});
}
function initLibrary(){
 try{document.body.classList.toggle('library-collapsed',localStorage.getItem(LIBRARY_KEY)==='1');}catch(_){}
 placeLibrary();matchMedia(WIDE).addEventListener('change',placeLibrary);
 $('library-toggle').onclick=()=>isWide()?setLibraryCollapsed(!document.body.classList.contains('library-collapsed')):showMusic();
 $('now-playing').onclick=showMusic;
}

// Palette swatches and color-effect thumbnails come from a second render.wasm
// instance, so the picker shows the real palettes and effects.
function paintSwatches(m){
 const hex=c=>'#'+(c&0xffffff).toString(16).padStart(6,'0');
 for(const o of $('palette').options){
  m.set_palette(+o.value);
  const p=new Uint32Array(m.memory.buffer,m.palette_ptr(),16);
  const stops=Array.from(p,(c,i)=>`${hex(c)} ${(i*100/15).toFixed(1)}%`).join(',');
  const grad=choiceFace('palette',o.value)?.querySelector('.sw-grad');
  if(grad)grad.style.background=`linear-gradient(90deg,${stops})`;
 }
}
const THUMBS={key:'',timer:0};
function scheduleThumbs(s){
 if(!STATE.modules.thumb)return;
 const key=[s.palette,s.speed,s.scale,s.light,s.gamma,s['invert-y']].join(':');
 if(key===THUMBS.key)return;
 THUMBS.key=key;clearTimeout(THUMBS.timer);THUMBS.timer=setTimeout(renderThumbs,120);
}
function renderThumbs(){
 const m=STATE.modules.thumb.exports,s=settings(),n=16;
 m.set_dimensions(n,n);m.set_palette(s.palette);writeGammaLut(m,s.gamma);m.apply_palette_gamma();
 new Float32Array(m.memory.buffer,m.audio_features_ptr(),237).fill(0);
 for(const o of $('color').options){
  const canvas=choiceFace('color',o.value)?.querySelector('canvas');if(!canvas)continue;
  m.reset_render();m.set_effects(+o.value,0,0);m.set_parameters(s.speed,s.scale,s.light,0);
  for(let i=0;i<48;i++)m.render_frame(16.667);
  const u=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),n*n*4),ctx=canvas.getContext('2d'),cell=canvas.width/n;
  ctx.fillStyle='#020305';ctx.fillRect(0,0,canvas.width,canvas.height);
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
   const i=(((y&1)?n-1-x:x)+y*n)*4,dy=s['invert-y']?n-1-y:y;
   ctx.fillStyle=`rgb(${u[i]},${u[i+1]},${u[i+2]})`;ctx.beginPath();ctx.arc((x+.5)*cell,(dy+.5)*cell,cell*.42,0,Math.PI*2);ctx.fill();
  }
 }
}
function initPickers(){
 paintSwatches(STATE.modules.thumb.exports);THUMBS.key='';scheduleThumbs(settings());
}
$('palette-search').addEventListener('input',e=>{
 const q=e.target.value.trim().toLowerCase();
 for(const o of $('palette').options)choiceFace('palette',o.value)?.parentElement.classList.toggle('filtered',Boolean(q)&&!o.textContent.toLowerCase().includes(q));
});

// Settings remembered in this browser (a convenience; storage may be unavailable).
// Sliders and selects keep their markup defaults, which the reset buttons restore.
// Lamp settings are stored as All lamps (SHARED); lamps keep their own in lamps.js.
const SETTINGS_KEY='esp-led-lab.settings';
const PERSISTED=[...inputIds,'remote-bands','remote-latency','remote-adapt','playback-volume'];
const STANDARD_RATES=[8000,16000,32000,48000];
let saveTimer=0;
function saveSettings(){
 clearTimeout(saveTimer);
 try{localStorage.setItem(SETTINGS_KEY,JSON.stringify(Object.fromEntries(PERSISTED.map(id=>{const el=$(id);
  return [id,LAMP_KEYS.includes(id)&&id in SHARED?SHARED[id]:el.type==='checkbox'?el.checked:el.value];}))));}catch(_){}
}
const scheduleSave=()=>{clearTimeout(saveTimer);saveTimer=setTimeout(saveSettings,400);};
function setControl(el,v){
 if(el.type==='checkbox')el.checked=Boolean(v);
 else if(el.tagName==='SELECT'){if([...el.options].some(o=>o.value===String(v)))el.value=String(v);}
 else if(v!==undefined&&v!==null&&v!=='')el.value=v;
}
function restoreSettings(){
 let saved=null;
 try{saved=JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null');}catch(_){}
 if(!saved)try{ // the LED layout was stored on its own before
  const g=JSON.parse(localStorage.getItem('esp-led-lab.geometry')||'null');
  if(g)saved={geometry:g.value,'geom-w':g.w,'geom-h':g.h};
 }catch(_){}
 if(!saved||typeof saved!=='object')return;
 // The analysis rate first: the frequency sliders are relative to its Nyquist limit.
 const rate=+saved['sample-rate'];
 if(STANDARD_RATES.includes(rate)&&rate!==fs){fs=rate;$('sample-rate').value=rate;updateAnalysisHop();}
 $('origin-shift').min=-512;$('origin-shift').max=512; // refreshTuningUi narrows it to the LED count
 for(const id of PERSISTED)if(id!=='sample-rate'&&id in saved&&$(id))setControl($(id),saved[id]);
 $('playback-volume-value').textContent=$('playback-volume').value+'%';
 $('remote-latency-value').textContent=$('remote-latency').value+' ms';
}
function resetControls(ids){
 for(const id of ids){
  const el=$(id);if(!el)continue;
  if(el.type==='checkbox')el.checked=el.defaultChecked;
  else if(el.tagName==='SELECT')el.value=([...el.options].find(o=>o.defaultSelected)||el.options[0]).value;
  else el.value=el.defaultValue;
 }
}
function resetAll(){
 selectTarget('all');resetLampProfiles();
 resetControls(PERSISTED.filter(id=>id!=='sample-rate'));
 try{localStorage.removeItem(SETTINGS_KEY);localStorage.removeItem('esp-led-lab.geometry');}catch(_){}
 for(const id of ['playback-volume','remote-latency'])$(id).dispatchEvent(new Event('input'));
 for(const id of ['remote-bands','remote-adapt'])$(id).dispatchEvent(new Event('change'));
 resetAnalyzer();
}
document.addEventListener('input',e=>{if(PERSISTED.includes(e.target.id))scheduleSave();});
document.addEventListener('change',e=>{if(PERSISTED.includes(e.target.id))scheduleSave();});
addEventListener('pagehide',saveSettings);

// Keys 1–5 open the panels (not while typing or on a focused control).
document.addEventListener('keydown',e=>{
 if(e.ctrlKey||e.metaKey||e.altKey||!/^[1-5]$/.test(e.key))return;
 const tag=document.activeElement?.tagName;
 if(['INPUT','SELECT','TEXTAREA'].includes(tag)||document.activeElement?.isContentEditable)return;
 e.preventDefault();showPanel(['music','effect','reaction','lamps','analyzer'][+e.key-1]);
});

// Phones: the preview can shrink to leave more room for the panels (remembered).
const STAGE_KEY='esp-led-lab.stage-compact';
function setStageCompact(compact){
 document.body.classList.toggle('stage-compact',compact);
 const b=$('stage-size'),label=compact?'Larger preview':'Smaller preview';
 b.setAttribute('aria-pressed',String(compact));b.title=label;b.setAttribute('aria-label',label);
 try{localStorage.setItem(STAGE_KEY,compact?'1':'0');}catch(_){}
}
function initUi(){
 for(const box of document.querySelectorAll('.choices[data-for]'))buildChoices(box);
 try{if(localStorage.getItem(STAGE_KEY)==='1')setStageCompact(true);}catch(_){}
 $('stage-size').onclick=()=>setStageCompact(!document.body.classList.contains('stage-compact'));
 initPopovers();initTabs();initLibrary();
 $('effect-reset').onclick=()=>resetSection(['color','palette','brightness','speed','scale','light']);
 $('signal-reset').onclick=()=>resetSection(['param-source','spectrum-shape','spectrum-onset','line-response']);
 // Menu items close their menu.
 for(const item of document.querySelectorAll('.menu-item'))item.addEventListener('click',()=>item.closest('[popover]')?.hidePopover?.());
 $('view-reset').onclick=()=>{resetControls(['mix','led-dots','invert-y','xy-test','simulate-led','master-brightness','gamma']);refreshLabels();};
 $('reset-all').onclick=()=>{resetAll();$('help-menu').hidePopover?.();};
 // The pinned stage on phones: the tabs stick right under it.
 if(typeof ResizeObserver==='function')new ResizeObserver(()=>document.documentElement.style.setProperty('--stage-h',$('stage').offsetHeight+'px')).observe($('stage'));
}
