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
const g=vm.runInContext('({c:clampGeometry(2000,500),p:parseGeometry("153x1"),s1:isStrip({w:153,h:1}),s2:isStrip({w:72,h:2}),m:isStrip({w:16,h:16}),L:stripLayout(153,1,340),L2:stripLayout(72,2,340),L3:stripLayout(7,1,340),R:stripLayout(153,1,600,300,true),R2:stripLayout(72,2,600,300,true)})',ctx);
assert.equal(g.c.w,1024);assert.equal(g.c.h,16);
assert.equal(g.p.w,153);assert.equal(g.p.h,1);
assert(g.s1&&g.s2&&!g.m);
// A strip is one line per row, as built: LEDs left to right, all inside the width.
const xs=a=>Array.from(a),one=g.L;
assert(xs(one.cy).every(v=>v===one.cy[0])&&xs(one.cx).every((v,i)=>!i||v>one.cx[i-1]),'153 LEDs on one line, in order');
assert(one.cx[0]>0&&one.cx[152]<340&&one.band>=12,'the line fits the width, LEDs at least 12 px across');
assert(g.L2.cy[72]-g.L2.cy[0]>g.L2.band&&g.L2.cy[71]===g.L2.cy[0],'two rows: two lines with a gap');
assert.equal(g.L3.pitch,32,'a short strip gets large LEDs (up to 32 px)');
// A closed strip (Ring) runs clockwise round a rectangle from the top-left corner.
const R=g.R,onEdge=i=>[R.cx[i]-R.cx[0]<R.pitch,600-R.cx[i]-R.cx[0]<R.pitch,R.cy[i]-R.cy[0]<R.pitch,300-R.cy[i]-R.cy[0]<R.pitch];
for(let i=0;i<153;i++)assert(onEdge(i).some(Boolean),`ring LED ${i} on the rectangle's edge`);
const step=i=>Math.hypot(R.cx[(i+1)%153]-R.cx[i],R.cy[(i+1)%153]-R.cy[i]);
for(let i=0;i<153;i++)assert(step(i)<R.pitch*1.01+.01,`ring LED ${i} next to LED ${(i+1)%153} (the ends meet)`);
assert(R.cx[10]>R.cx[0]&&R.cy[10]===R.cy[0]&&R.vert[50]===0&&R.vert[60]===1&&R.cx[0]>0&&R.height===300,'clockwise from the top-left, rectangle fills the stage');
assert(g.R2.cx[72]>g.R2.cx[0]&&g.R2.cy[72]>g.R2.cy[0],'the second row runs inside the first');
const near=vm.runInContext('stripLedAt(stripLayout(153,1,600,300,true),600,150)',ctx);
assert(near>=60&&near<=66,`a click on the middle of the right side picks a right-side LED (${near})`);
console.log('PASS strips 7..1024 LED, 72x2, pixel budget, stretched wave, single-row Bass/Mid/High, strip layout');
