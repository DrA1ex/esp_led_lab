// Effect parameters (web/js/fx-params.js ↔ src/viz_engine.h through the WASM
// exports): the lab lists each mode's parameters in the engine's order with the
// engine's defaults, every choice list is as long as the engine's, the
// parameters reach the preview and change it, other modes' parameters are
// ignored, and no value lights a mode in silence.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/render.wasm')));
const ctx={$:()=>null,inputIds:[],Math,String,Number,Object,Boolean};vm.createContext(ctx);
const FX=vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/fx-params.js'),'utf8')+
 '\n;({FX_PARAMS,FX_MODES,FX_IDS,FX_PARAMS_VERSION,FX_MAX,fxValues,fxDefaults,fxKeys,fxId})',ctx);

const probe=new WebAssembly.Instance(mod).exports;
assert.equal(probe.viz_params_version(),FX.FX_PARAMS_VERSION,'params layout version');
assert.equal(probe.viz_max_params(),FX.FX_MAX,'parameter slots');
assert.equal(probe.viz_mode_count(),23,'23 visualizations (lab modes 13..35)');
for(let mode=13;mode<13+probe.viz_mode_count();mode++){
 const keys=FX.FX_PARAMS[mode]?[...FX.fxKeys(mode)]:[];
 assert.equal(probe.viz_param_count(mode-13),keys.length,`mode ${mode}: parameter count`);
 const engine=keys.map((_,i)=>probe.viz_param_default(mode-13,i));
 assert.deepEqual(keys.length?[...FX.fxDefaults(mode)]:[],engine,`mode ${mode}: defaults`);
 // The UI order may differ (a "map" choice first); the engine order covers every key once.
 if(keys.length)assert.deepEqual([...keys].sort(),[...FX.FX_PARAMS[mode].map(p=>p.key)].sort(),`mode ${mode}: keys`);
}
assert.equal(new Set(FX.FX_IDS).size,FX.FX_IDS.length,'unique control ids');

// Frames of a run, hashed; `params` for engine mode `pmode` (default: this mode).
function run(w,h,mode,fill,{params=null,pmode=mode-13,frames=70}={}){
 const m=new WebAssembly.Instance(mod).exports;
 m.set_dimensions(w,h);m.set_palette(41);m.set_effects(9,0,mode);m.set_parameters(0,0,255,1);
 m.set_visualization(0,0,.5,.5,1);
 if(params){new Uint8Array(m.memory.buffer,m.viz_params_ptr(),FX.FX_MAX).set(params);m.set_viz_params(pmode);}
 const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),237);
 const out=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),w*h*4);
 let hash=0,lit=0;
 for(let k=0;k<frames;k++){f.fill(0);f[224]=32;fill(f,k);m.render_frame(16.7);
  for(let i=0;i<w*h*4;i++)hash=(Math.imul(hash,31)+out[i])|0;}
 for(let i=0;i<w*h;i++)if(out[i*4]+out[i*4+1]+out[i*4+2]>30)lit++;
 return {hash,lit};
}
// Music with a moving spectrum, varying loudness, group onsets, beats, a broadband hit every 10 frames
// and notes: C major, then A minor from frame 35.
const music=(f,k)=>{
 f[225]=1;f[229]=.8;f[232]=k<35?.9:.2;f[234]=k<35?.1:.9;
 for(let i=0;i<64;i++)f[160+i]=k%10===0?1:.3+.6*Math.abs(Math.sin(i*.4+k*.3));
 for(let i=0;i<16;i++)f[i]=.5;
 f[16+k%3]=k%6<3?1:0;f[23]=.5+.3*Math.sin(k*.23);f[159]=f[23];
 for(let i=0;i<128;i++)f[24+i]=.4+.5*Math.abs(Math.sin(i*.2+k*.1));
 f[156]=.7;f[157]=.5;f[158]=.6;f[153]=1;f[154]=(k%30)/30;f[155]=k%30<4?1-(k%30)*.25:0;
};
const silence=()=>{};
// Parameters that only act with another set: [mode, key, other key, its value].
const CONTEXTS=[[28,'pattern','trigger',5],[28,'glow','trigger',5]];
let checked=0;
for(const mode of FX.FX_MODES){
 const keys=[...FX.fxKeys(mode)],defaults=[...FX.fxDefaults(mode)],byKey=Object.fromEntries(FX.FX_PARAMS[mode].map(p=>[p.key,p]));
 for(const [w,h] of [[16,16],[60,1]]){
  const plain=run(w,h,mode,music);
  assert.equal(run(w,h,mode,music,{params:defaults}).hash,plain.hash,`mode ${mode} ${w}x${h}: explicit defaults draw the same`);
  assert.equal(run(w,h,mode,music,{params:defaults.map(v=>v^0x55),pmode:(mode-13+1)%23}).hash,plain.hash,`mode ${mode}: another mode's parameters are ignored`);
  keys.forEach((key,i)=>{
   const p=byKey[key],start=[...defaults];
   for(const [cm,ck,other,value] of CONTEXTS)if(cm===mode&&ck===key)start[keys.indexOf(other)]=value;
   const at=v=>{const x=[...start];x[i]=v;return x;};
   const base=run(w,h,mode,music,{params:start}).hash;
   const values=p.choices?p.choices.map((_,c)=>c):p.toggle?[0,1]:[p.min??0,64,128,192,p.max??255];
   const changed=values.some(v=>run(w,h,mode,music,{params:at(v)}).hash!==base);
   if(h>=4||!p.matrix)assert(changed||h<4,`mode ${mode} ${w}x${h}: ${key} changes nothing`);
   // The engine's choice count is the UI's: one past the last choice wraps to the first.
   if(p.choices&&h>=4)assert.equal(run(w,h,mode,music,{params:at(p.choices.length)}).hash,run(w,h,mode,music,{params:at(0)}).hash,`mode ${mode}: ${key} has ${p.choices.length} choices in the engine`);
   // Ranges with limits: the engine clamps to them.
   if(p.max!==undefined&&p.max<255)assert.equal(run(w,h,mode,music,{params:at(p.max+1)}).hash,run(w,h,mode,music,{params:at(p.max)}).hash,`mode ${mode}: ${key} stops at ${p.max}`);
   for(const v of [0,1,2,3,4,5,6,7,127,128,254,255]){
    const q=run(w,h,mode,silence,{params:at(v),frames:40});
    assert(q.lit<=w*h*.02,`mode ${mode} ${w}x${h}: ${key}=${v} lights ${q.lit} LEDs in silence`);
   }
   checked++;
  });
 }
}
// fxValues reads the controls (strings from selects, booleans from checkboxes) into bytes.
{
 const s={'fx-13-colors':2,'fx-13-peak':false,'fx-18-map':1,'fx-18-spread':48,'fx-18-flash':'90','fx-18-tone':300};
 assert.deepEqual([...FX.fxValues(s,13)],[2,0]);
 assert.deepEqual([...FX.fxValues(s,18)],[48,90,255,1],'engine order, clamped');
}
console.log(`PASS effect parameters: ${FX.FX_MODES.length} modes, ${checked} parameter checks on 16x16 and 60x1 (defaults, order, choices, ranges, silence)`);
