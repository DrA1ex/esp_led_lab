// Lab-only visualizations 13..30 on every geometry class: silence stays dark,
// sound lights the LEDs, strips show the same on every row (except random Sparkles), the lamp band
// count is used, and mirroring is symmetric.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/render.wasm')));
const MODES=[13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30];

// Palette colours on a white base; `fill(f, frame)` sets the features per frame.
function run(w,h,mode,fill,{frames=40,mirror=0,bands=32,auto=0,setup}={}){
 const m=new WebAssembly.Instance(mod).exports;
 m.set_dimensions(w,h);m.set_palette(41);m.set_effects(9,0,mode);m.set_parameters(0,0,255,1);
 m.set_visualization(0,mirror,.5,.5,auto);
 if(setup)setup(m);
 const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),225);
 for(let k=0;k<frames;k++){f.fill(0);f[224]=bands;fill(f,k);m.render_frame(16.7);}
 const out=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),w*h*4);
 const at=(x,y=0)=>{const i=(((y&1)?w-1-x:x)+y*w)*4;return out[i]+out[i+1]+out[i+2];};
 let lit=0;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(at(x,y)>30)lit++;
 return {at,lit};
}
// Loud music: rising spectrum, levels, a bass/mid/treble onset every 6 frames.
const music=(f,k)=>{
 for(let i=0;i<64;i++)f[160+i]=.3+.6*Math.abs(Math.sin(i*.4+k*.3));
 for(let i=0;i<16;i++)f[i]=.5;
 f[16+k%3]=k%6<3?1:0;f[23]=.8;f[159]=.8;
 for(let i=0;i<128;i++)f[24+i]=.4+.5*Math.abs(Math.sin(i*.2));
 f[156]=.7;f[157]=.5;f[158]=.6;
};
const silence=()=>{};

const GEOMETRIES=[[7,1],[153,1],[72,2],[16,16],[128,128]];
for(const mode of MODES)for(const [w,h] of GEOMETRIES){
 const quiet=run(w,h,mode,silence,{auto:1});
 assert(quiet.lit<=w*h*.02,`mode ${mode} ${w}x${h}: silence lights ${quiet.lit} LEDs`);
 const loud=run(w,h,mode,music,{auto:1});
 assert(loud.lit>0,`mode ${mode} ${w}x${h}: music lights nothing`);
 // Sparkles are random per LED on every geometry.
 if(h>1&&h<4&&mode!==17)for(let x=0;x<w;x++)assert.equal(loud.at(x,0),loud.at(x,1),`mode ${mode} ${w}x${h}: rows differ at ${x}`);
}

// Mirrored strip spectrum / VU are symmetric around the centre.
for(const mode of [13,14,19,20]){
 const r=run(61,1,mode,music,{mirror:1});
 if(mode===20)continue; // three segments, each mirrored on its own
 for(let x=0;x<30;x++)assert.equal(r.at(x),r.at(60-x),`mode ${mode} mirrored at ${x}`);
}

// Spectrum Bars on a matrix: one loud band column, the rest silent.
{
 const r=run(32,16,14,f=>{f[160+31]=1;},{bands:32});
 assert(r.at(31,0)>30&&r.at(31,15)>30,'loud top band fills its column');
 assert.equal(r.at(0,0),0,'silent band stays dark');
}
// The band count matters: 64 bands put band 63 at the strip end only.
{
 const r=run(64,1,14,f=>{f[160+63]=1;},{bands:64});
 assert(r.at(63)>30&&r.at(31)===0,'64-band strip spectrum');
}
// VU on a strip fills from the start up to the level.
{
 const r=run(100,1,13,f=>{f[23]=.5;f[159]=.5;});
 assert(r.at(10)>30&&r.at(80)===0,'VU fill');
}
// Lab modes leave the colour effect alone in "mask" mode when the level is full.
{
 const r=run(16,16,18,f=>{f[23]=1;f[159]=1;},{setup:m=>m.set_visualization(1,0,.5,.5,0)});
 assert(r.lit===256,'mask mode keeps the effect visible');
}
// Auto-level: a quiet treble meter moves like the bass one.
{
 const bar=(auto,g)=>{const r=run(90,1,20,(f,k)=>{const on=k%20<10;f[156]=on?.8:.4;f[157]=0;f[158]=on?.12:.04;},{auto,frames:120});
  let n=0;for(let x=g*30;x<g*30+30;x++)if(r.at(x)>30)n++;return n;};
 assert(bar(0,2)<6,'treble meter barely moves without auto-level');
 assert(bar(1,2)>15,'auto-level lifts the treble meter');
}
// Groove follows the beat phase (features[154]) of a confident tempo: at 100 BPM
// (30 frames of 20 ms a beat) the picture comes back every two beats (half a
// period per beat), not after one or half a beat; without the confidence it rests.
{
 const frames=(conf,n)=>{
  const m=new WebAssembly.Instance(mod).exports,seen=[];
  m.set_dimensions(16,16);m.set_palette(4);m.set_effects(9,0,30);m.set_parameters(0,0,255,1);m.set_visualization(0,0,.5,.5,1);
  // Bloom colours by tone: the default ones roll a little every beat.
  new Uint8Array(m.memory.buffer,m.viz_params_ptr(),8).set([0,64,200,160,100,100,1,128]);m.set_viz_params(17);
  const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),225),out=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),1024);
  for(let k=0;k<n;k++){f.fill(0);f[224]=32;for(let i=0;i<64;i++)f[160+i]=.5;f[23]=f[159]=.6;f[156]=.7;f[157]=.5;
   f[152]=100;f[153]=conf;f[154]=(k%30)/30;m.render_frame(20);
   seen.push(Array.from({length:256},(_,i)=>Math.max(out[i*4],out[i*4+1],out[i*4+2])));}
  return seen;
 };
 const diff=(a,b)=>Math.max(...a.map((v,i)=>Math.abs(v-b[i])));
 const locked=frames(1,400);
 for(let k=300;k<330;k+=5){
  assert(diff(locked[k],locked[k+60])<=8,`Groove two beats apart at ${k}: ${diff(locked[k],locked[k+60])}`);
  assert(diff(locked[k],locked[k+30])>50&&diff(locked[k],locked[k+15])>50,`Groove moves within the beat at ${k}`);
 }
 const loose=frames(0,200);
 assert.equal(diff(loose[150],loose[199]),0,'Groove rests without a confident tempo or hits');
}
// The firmware renders the same modes from its own copy of the engine.
{
 const lamp=path.join(__dirname,'../../esp_led_lamp/src/remote_audio/viz_engine.h');
 if(fs.existsSync(lamp))assert.equal(fs.readFileSync(lamp,'utf8'),fs.readFileSync(path.join(__dirname,'../src/viz_engine.h'),'utf8'),
  'src/viz_engine.h differs from esp_led_lamp/src/remote_audio/viz_engine.h: copy it over');
}
console.log('PASS lab visualizations 13..30 on strips 7/153, 72x2, matrices 16/128: silence, music, rows, mirror, bands, Groove beat lock');
