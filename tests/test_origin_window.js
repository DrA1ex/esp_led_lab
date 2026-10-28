// Signal window (input range / gate) and the shared origin (shift, reverse,
// ring, radial centre). Defaults must keep the stock firmware picture; the
// rules mirror firmware audioTransfer() and RemoteReactive::OriginMap.
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/render.wasm')));

// Solid white base (HSL light 255), audio mode `mode`, features from fill().
function frame(w,h,mode,fill,setup){
 const m=new WebAssembly.Instance(mod).exports;
 m.set_dimensions(w,h);m.set_palette(41);m.set_effects(9,0,mode);m.set_parameters(0,0,255,1);
 if(setup)setup(m);
 const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),160);f.fill(0);fill(f);
 m.render_frame(16.7);
 const out=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),w*h*4);
 // Logical (x,y) -> red channel, undoing row-serpentine addressing.
 return (x,y=0)=>out[(((y&1)?w-1-x:x)+y*w)*4];
}
const ramp=f=>{for(let i=0;i<16;i++)f[i]=i/15;}; // spectrum rises along the strip
const loud=v=>f=>{f[23]=v;f[159]=v;};

// Explicit default calls change nothing.
for(const mode of [1,2,3,4,6,7,11,12]){
 const a=frame(16,16,mode,f=>{ramp(f);f[23]=.6;for(let i=0;i<128;i++)f[24+i]=i/127;});
 const b=frame(16,16,mode,f=>{ramp(f);f[23]=.6;for(let i=0;i<128;i++)f[24+i]=i/127;},m=>{m.set_origin(0,500,0,0,0);m.set_audio_window(0,255,0);});
 for(let y=0;y<16;y++)for(let x=0;x<16;x++)assert.equal(a(x,y),b(x,y),`mode ${mode} default origin`);
}

// Window: 0..150 of the input stretched onto the output, gate cuts the bottom.
const lineAt=(v,setup)=>{const px=frame(100,1,6,loud(v),setup);let n=0;for(let x=0;x<100;x++)if(px(x))n++;return n;};
assert.equal(lineAt(150/255),Math.floor(150/255*100));
assert.equal(lineAt(150/255,m=>m.set_audio_window(0,150,0)),100,'input max stretches to the full line');
assert.equal(lineAt(40/255,m=>{m.set_audio_range(100,200);m.set_audio_window(50,100,0);}),Math.floor(100*100/255),'below window -> output min');
assert.equal(lineAt(40/255,m=>{m.set_audio_range(100,200);m.set_audio_window(50,100,1);}),0,'gate -> 0');
assert.equal(lineAt(.9,m=>{m.set_audio_range(100,200);m.set_audio_window(50,100,1);}),Math.floor(200*100/255),'above window -> output max');

// Line shifted by 25 %: starts at LED 25; without ring the first 25 stay dark.
const shifted=frame(100,1,6,loud(.5),m=>m.set_origin(250,500,0,0,0));
assert(!shifted(24)&&shifted(25)&&shifted(25+48)&&!shifted(25+51));
// Ring: a long line wraps past the end back to LED 0.
const ring=frame(100,1,6,loud(1),m=>m.set_origin(250,500,0,1,0));
for(let x=0;x<100;x++)assert(ring(x),`ring LED ${x}`);
// Reverse: Line grows from the last LED.
const rev=frame(100,1,6,loud(.3),m=>m.set_origin(0,500,1,0,0));
assert(rev(99)&&!rev(0));

// Spectrum shifted on a ring keeps every band, rotated.
const spec=frame(32,1,3,ramp),specRing=frame(32,1,3,ramp,m=>m.set_origin(250,500,0,1,0));
for(let x=0;x<32;x++)assert.equal(specRing((x+8)%32),spec(x));

// Line Center moved to 1/4 of a 101 LED ring strip.
const lc=frame(101,1,7,loud(.2),m=>m.set_origin(-250,500,0,1,0));
const lit=[...Array(101).keys()].filter(x=>lc(x));
assert(lit.includes(25)&&!lit.includes(50)&&lit.length>4);
// Wrap: a centre near LED 0 lights both ends of the ring.
const lc0=frame(101,1,7,loud(.3),m=>m.set_origin(-480,500,0,1,0));
assert(lc0(0)&&lc0(100));

// Radial centre on a matrix: the Wave Center picture is a disc around (cx, cy).
const disc=frame(16,16,2,f=>{for(let i=0;i<128;i++)f[24+i]=1-i/127;},m=>m.set_origin(0,250,0,0,1));
assert(disc(8,4)>disc(8,15),'brighter at the radial centre row');
assert(disc(8,4)>disc(0,4));
// Speed Control follows the curve: a gated window holds Perlin still (speed 0),
// a signal above the window animates it.
function perlinMoves(v,gate){
 const m=new WebAssembly.Instance(mod).exports;
 m.set_dimensions(16,16);m.set_palette(4);m.set_effects(0,0,8);m.set_parameters(120,180,200,1);
 m.set_audio_window(160,255,gate);
 const f=new Float32Array(m.memory.buffer,m.audio_features_ptr(),160);f.fill(0);f[23]=v;
 const px=()=>Array.from(new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),16*16*4));
 m.render_frame(40);const a=px();m.render_frame(40);return px().some((x,i)=>x!==a[i]);
}
assert(!perlinMoves(.3,1),'gated speed stops the effect');
assert(perlinMoves(.9,1),'signal above the window moves the effect');
console.log('PASS origin (shift / ring / reverse / radial) and signal window, defaults unchanged');
