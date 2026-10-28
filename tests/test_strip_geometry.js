// LED strips (HEIGHT = 1 or 2) and long widths: WASM renderer + display layout.
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/render.wasm')));
const fresh=()=>new WebAssembly.Instance(mod).exports;

// Firmware strip configs (src/_override/*.h) and every effect combination render.
const r=fresh();
for(const [w,h] of [[7,1],[34,1],[46,1],[153,1],[300,1],[72,2],[1024,1]]){
 r.set_dimensions(w,h);assert.equal(r.get_width(),w);assert.equal(r.get_height(),h);
 for(let color=0;color<10;color++)for(let bright=0;bright<5;bright++){
  r.reset_render();r.set_palette(4);r.set_effects(color,bright,0);r.set_parameters(90,180,160,1);
  r.render_frame(16.7);r.render_frame(16.7);
  const out=new Uint8Array(r.memory.buffer,r.framebuffer_ptr(),w*h*4);
  assert(out.every((v,i)=>i%4!==3||v===255),`opaque ${w}x${h} c${color} b${bright}`);
  if(color!==7)assert(out.some((v,i)=>i%4!==3&&v>0),`pixels ${w}x${h} c${color} b${bright}`);
 }
}
// The pixel budget bounds the framebuffer: a 1024-wide layout keeps 16 rows.
r.set_dimensions(1024,128);assert.equal(r.get_width(),1024);assert.equal(r.get_height(),16);
assert.equal(r.max_pixels(),128*128);

// Wave on a 300 LED strip stretches the 128-sample history instead of
// clamping the last 172 LEDs to the oldest sample (firmware RemoteSignalProvider).
function waveColumns(w,mode){
 const m=fresh();m.set_dimensions(w,1);m.set_palette(41);m.set_effects(9,0,mode);m.set_parameters(0,0,255,1);
 const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),160);f.fill(0);
 for(let age=0;age<128;age++)f[24+age]=1-age/127; // newest loud, oldest silent
 m.render_frame(16.7);
 const out=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),w*4);
 return Array.from({length:w},(_,x)=>out[x*4]+out[x*4+1]+out[x*4+2]);
}
const wave=waveColumns(300,1);
for(let x=1;x<300;x++)assert(wave[x]<=wave[x-1],`wave non-increasing at ${x}`);
assert(wave[0]>0&&wave[299]===0);
assert(wave[200]>0,'mid-strip column still shows history rather than the oldest sample');
const centered=waveColumns(301,2);
assert.equal(centered[150],Math.max(...centered));assert.equal(centered[0],centered[300]);

// Bass/Mid/High on a single-row strip blends bass and mid (firmware Half::BOTH),
// so swapping bass and mid energy gives the same picture.
function bmh(low,mid,h){
 const m=fresh();m.set_dimensions(60,h);m.set_palette(41);m.set_effects(9,0,11);m.set_parameters(0,0,255,1);
 const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),160);f.fill(0);f[156]=low;f[157]=mid;
 m.render_frame(16.7);return Array.from(new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),60*h*4));
}
assert.deepEqual(bmh(1,0,1),bmh(0,1,1));
assert.notDeepEqual(bmh(1,0,2),bmh(0,1,2));

// Display helpers from web/js/geometry.js.
const ctx={$:()=>null,REMOTE:{devices:[]},document:{},Math};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'../web/js/geometry.js'),'utf8'),ctx);
const g=vm.runInContext('({c:clampGeometry(2000,500),p:parseGeometry("153x1"),s1:isStrip({w:153,h:1}),s2:isStrip({w:72,h:2}),m:isStrip({w:16,h:16}),L:stripLayout(153,1,340),L2:stripLayout(72,2,340),L3:stripLayout(7,1,340)})',ctx);
assert.equal(g.c.w,1024);assert.equal(g.c.h,16);
assert.equal(g.p.w,153);assert.equal(g.p.h,1);
assert(g.s1&&g.s2&&!g.m);
assert(g.L.pitch>=7&&g.L.perLine*g.L.linesPerRow>=153,'every strip LED gets a cell of at least 7 px');
assert(g.L2.height>2*g.L2.rowHeight,'two strip rows are separated by a gap');
assert.equal(g.L3.perLine,7);
console.log('PASS strips 7..1024 LED, 72x2, pixel budget, stretched wave, single-row Bass/Mid/High, strip layout');
