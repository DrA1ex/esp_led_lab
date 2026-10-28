const fs=require('fs'),assert=require('node:assert/strict');
const base=__dirname+'/../web/wasm/';
function load(name){return new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(base+name)));}
const render=load('render.wasm').exports;
for(const size of [16,32,64,128]){render.set_dimensions(size,size);render.set_palette(3);for(let effect=0;effect<10;effect++){for(let bright=0;bright<5;bright++){render.set_effects(effect,bright,3);render.set_parameters(86,180,160,.8);const f=new Float32Array(render.memory.buffer,render.audio_features_ptr(),159);f.fill(.5);f[16]=.8;f[18]=.35;render.render_frame(16.6667);const out=new Uint8Array(render.memory.buffer,render.framebuffer_ptr(),size*size*4);assert.equal(out.length,size*size*4);assert(out.some((v,i)=>i%4!==3&&v>0),`missing pixels effect=${effect} bright=${bright} size=${size}`);assert(out.every((v,i)=>i%4!==3||v===255),`not opaque effect=${effect}`);}}}
const dsp=load('dsp.wasm').exports;dsp.reset_dsp();const buff=new Float32Array(dsp.memory.buffer,dsp.new_input_ptr(),1024);for(let step=0;step<100;step++){for(let i=0;i<512;i++)buff[i]=.2*Math.sin((i+step*256)*2*Math.PI*440/16000);dsp.new_process(512,.016,25,210,.008,1,1.6,.82,900,0);}
const bands=new Float32Array(dsp.memory.buffer,dsp.new_bands_ptr(),16);assert(bands.some(x=>x>.005));assert(bands.every(x=>Number.isFinite(x)&&x>=0&&x<=1));
console.log('PASS: wasm all 10 color x 5 brightness x 4 matrix sizes, opacity, DSP response');
