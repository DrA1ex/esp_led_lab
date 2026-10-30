'use strict';
// Per-lamp settings. "All lamps" holds the shared settings; a lamp follows
// them except where it has its own values (its overrides). It also keeps a
// name, a max brightness, a band count and its last reported size.
// The settings panels edit one target at a time: their controls show the
// target's effective values and every change is written back to it
// (commitEditor, run by refreshLabels). Lamps get their config from the
// stored values (lampConfig), never from the controls.
const LAMP_GROUPS={
 Effect:['color','palette','brightness','speed','scale','light'],
 Reaction:['audio-mode','param-source','spectrum-shape','spectrum-onset','viz-color','viz-auto','viz-mirror','viz-decay','viz-speed',
  'input-min','input-max','input-curve','input-gate','audio-min','audio-max'],
 Parameters:FX_IDS,
 Start:['origin-shift','origin-y','origin-reverse','origin-ring','origin-radial']
};
const LAMP_KEYS=Object.values(LAMP_GROUPS).flat();
const SHARED={};
const PROFILES_KEY='esp-led-lab.lamp-profiles',TARGET_KEY='esp-led-lab.target';
let LAMP_PROFILES={},TARGET='all';

// Profiles of older versions ({mode, bands, shift}) become overrides.
function normalizeProfile(p){
 if(!p||typeof p!=='object')p={};
 const overrides=p.overrides&&typeof p.overrides==='object'?{...p.overrides}:{};
 if(p.mode!==undefined&&p.mode!=='')overrides['audio-mode']=+p.mode;
 if(p.shift!==undefined&&p.shift!=='')overrides['origin-shift']=+p.shift;
 const limit=Number.isFinite(+p.limit)?Math.max(0,Math.min(100,Math.round(+p.limit))):100;
 const size=p.size&&p.size.w>0&&p.size.h>0?{w:+p.size.w,h:+p.size.h}:null;
 return {name:typeof p.name==='string'?p.name:'',overrides,bands:[16,32,64].includes(+p.bands)?String(+p.bands):'',limit,size};
}
try{
 const saved=JSON.parse(localStorage.getItem(PROFILES_KEY)||'{}')||{};
 for(const [url,p] of Object.entries(saved))LAMP_PROFILES[url]=normalizeProfile(p);
}catch(_){}
let profilesTimer=0;
function saveProfiles(){
 clearTimeout(profilesTimer);
 try{localStorage.setItem(PROFILES_KEY,JSON.stringify(LAMP_PROFILES));}catch(_){}
}
const scheduleProfiles=()=>{clearTimeout(profilesTimer);profilesTimer=setTimeout(saveProfiles,300);};
const lampProfile=d=>LAMP_PROFILES[d.url]||=normalizeProfile();
function forgetLamp(d){delete LAMP_PROFILES[d.url];saveProfiles();if(TARGET===d.url)selectTarget('all');}

const lampHost=d=>{try{return new URL(d.url).host||d.address;}catch(_){return d.address;}};
const lampName=d=>lampProfile(d).name||lampHost(d);
const targetLamp=()=>TARGET==='all'?null:REMOTE.devices.find(d=>d.url===TARGET)||null;
// WIDTH x HEIGHT from hello_ack, or the last one the lamp reported.
function lampSize(d){
 if(d.width>0&&d.height>0)return clampGeometry(d.width,d.height);
 const s=lampProfile(d).size;
 return s?clampGeometry(s.w,s.h):null;
}
const targetLampSize=()=>{const d=targetLamp();return d?lampSize(d):null;};
const ownKeys=d=>Object.keys(lampProfile(d).overrides).filter(id=>LAMP_KEYS.includes(id));
const ownGroups=d=>{const own=ownKeys(d);return Object.keys(LAMP_GROUPS).filter(g=>LAMP_GROUPS[g].some(id=>own.includes(id)));};

// The shared start offset counts LEDs of the All lamps layout; a lamp that
// follows it gets the same share of its own width (as on the wire).
function sharedValueFor(d,id){
 if(id==='origin-shift'){
  const w=lampSize(d)?.w,sw=menuGeometry().w;
  if(w&&w!==sw){const half=Math.floor(w/2);return Math.max(-half,Math.min(half,Math.round(SHARED[id]*w/sw)));}
 }
 return SHARED[id];
}
function effectiveValue(d,id){
 const own=lampProfile(d).overrides;
 return id in own?own[id]:sharedValueFor(d,id);
}
function lampSettings(d){
 const s={};
 for(const id of LAMP_KEYS)s[id]=d?effectiveValue(d,id):SHARED[id];
 return s;
}

// Band count: the lamp's own choice, else about one band per column of its
// width ("Band count from each lamp's width"), else "Spectrum bands".
function lampBands(d){
 const own=+lampProfile(d).bands;
 if(own&&d.supported.includes(own))return own;
 if(!lampAdapt())return +$('remote-bands').value;
 return RemoteAudio.pickBands(lampSize(d)?.w||menuGeometry().w,d.supported);
}
const lampAdapt=()=>Boolean($('remote-adapt')?.checked);
// The band count the preview's lab-only modes use: what the edited target receives.
function previewBands(){const d=targetLamp();return d?lampBands(d):+$('remote-bands').value;}

// Order matches firmware RemoteReactive::ControlSource (config.param_source).
const PARAM_SOURCES=['loudness','spectral','bass','mid','high','peak','onset','beat'];
// Firmware ignores unknown fields, so the lab tuning below is safe for older
// receivers; receivers advertising "tuning" apply it like the preview.
function runtimeConfig(s,width){return {
 color_effect:s.color,brightness_effect:s.brightness,audio_effect:s['audio-mode'],
 audio_min:s['audio-min'],audio_max:s['audio-max'],palette:s.palette,
 speed:s.speed,scale:s.scale,light:s.light,
 param_source:Math.max(0,PARAM_SOURCES.indexOf(s['param-source'])),
 // The reaction range replaces the separate speed floor (0 = stock mapping).
 speed_floor:0,spectrum_shape:s['spectrum-shape'],spectrum_onset:s['spectrum-onset'],
 viz_color:+s['viz-color'],viz_mirror:Boolean(s['viz-mirror']),viz_auto:Boolean(s['viz-auto']),
 viz_decay:+s['viz-decay'],viz_motion:+s['viz-speed'],
 ...tuningConfig(s,width)
};}
function lampConfig(d){
 const s=lampSettings(d),own=lampProfile(d).overrides;
 const c=runtimeConfig(s,lampSize(d)?.w||menuGeometry().w);
 // A shared start offset goes out as the same share of the width for every lamp.
 if(!('origin-shift' in own))c.origin_shift=originPermille(SHARED,menuGeometry().w);
 // A visualization this lamp's firmware does not render: Off instead.
 if(LAB_MODES.includes(c.audio_effect)&&!d.visualizations.includes(c.audio_effect))c.audio_effect=0;
 return c;
}

// Effect parameters of the visualization this lamp runs, for lamps with the
// "params" capability ({type:'params'} message), else null.
function lampParams(d){
 const effect=lampConfig(d).audio_effect;
 if(!FX_MODES.includes(effect))return null;
 return {version:FX_PARAMS_VERSION,effect,values:fxValues(lampSettings(d),effect)};
}

// Editing: the controls show the target; changes go back to it.
function captureShared(){const s=settings();for(const id of LAMP_KEYS)SHARED[id]=s[id];}
function commitEditor(s){
 const d=targetLamp();
 if(!d){for(const id of LAMP_KEYS)SHARED[id]=s[id];return;}
 // Own values are exactly the ones that differ from what the lamp would follow.
 const p=lampProfile(d),own={};
 for(const id of LAMP_KEYS)if(s[id]!==sharedValueFor(d,id))own[id]=s[id];
 if(JSON.stringify(own)!==JSON.stringify(p.overrides)){p.overrides=own;scheduleProfiles();renderTargets();}
}
// The width the controls were loaded for: a lamp that reports a new size
// rescales the shared start offset it follows, so the controls reload.
let EDITOR_WIDTH=0;
const editorStale=()=>{const d=targetLamp();return Boolean(d)&&(lampSize(d)?.w||0)!==EDITOR_WIDTH;};
function loadEditor(){
 const d=targetLamp();EDITOR_WIDTH=d?lampSize(d)?.w||0:0;
 $('origin-shift').min=-512;$('origin-shift').max=512; // refreshTuningUi narrows it to the LED count
 for(const id of LAMP_KEYS)setControl($(id),d?effectiveValue(d,id):SHARED[id]);
}
function selectTarget(t){
 if(t!=='all'&&!REMOTE.devices.some(d=>d.url===t))t='all';
 TARGET=t;
 try{localStorage.setItem(TARGET_KEY,t);}catch(_){}
 loadEditor();refreshLabels();renderRemoteDevices();
}
// Section resets: defaults on All lamps, the shared values on a lamp.
function resetSection(ids){
 const d=targetLamp();
 if(!d)resetControls(ids);
 else for(const id of ids)if(LAMP_KEYS.includes(id))setControl($(id),sharedValueFor(d,id));
 refreshLabels();
}
function useSharedSettings(d){lampProfile(d).overrides={};saveProfiles();if(d===targetLamp())loadEditor();refreshLabels();renderTargets();}
function resetLampProfiles(){
 for(const p of Object.values(LAMP_PROFILES)){p.overrides={};p.limit=100;p.bands='';}
 BRIGHT.master=null;saveProfiles();
}

// Max brightness: each lamp gets (all-lamps brightness) x (its max brightness).
const BRIGHT={master:null};
const to100=v=>Math.round(v*100/255),pct255=p=>Math.round(p*255/100);
const lampLevel=(d,master)=>Math.round(Math.max(0,Math.min(100,master))*lampProfile(d).limit/100*255/100);
// The all-lamps level the lamps are at now (they may have been changed elsewhere).
function lampsMaster(){
 const levels=REMOTE.controllable.filter(d=>d.brightness!==null&&lampProfile(d).limit>0)
  .map(d=>Math.min(100,d.brightness*100/255/(lampProfile(d).limit/100)));
 if(!levels.length)return null;
 const avg=levels.reduce((a,b)=>a+b,0)/levels.length;
 return {value:Math.round(avg),mixed:Math.max(...levels)-Math.min(...levels)>2};
}
function setLampsMaster(v){BRIGHT.master=v;for(const d of REMOTE.controllable)d.control('brightness',lampLevel(d,v));}
function setLampLimit(d,v){
 lampProfile(d).limit=Math.max(0,Math.min(100,Math.round(v)));scheduleProfiles();
 if(d.controllable)d.control('brightness',lampLevel(d,BRIGHT.master??lampsMaster()?.value??100));
}

function initLamps(){
 captureShared();
 let saved='all';try{saved=localStorage.getItem(TARGET_KEY)||'all';}catch(_){}
 if(saved!=='all'&&REMOTE.devices.some(d=>d.url===saved))selectTarget(saved);
 addEventListener('pagehide',saveProfiles);
}
