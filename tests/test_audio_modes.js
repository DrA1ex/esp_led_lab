'use strict';
// Check firmware AudioEffectEnum coverage and parametric pre-render semantics.
const fs=require('node:fs'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const wasmModule=new WebAssembly.Module(fs.readFileSync(path.join(root,'web/wasm/render.wasm')));
function instance(){const e=new WebAssembly.Instance(wasmModule).exports;e.set_dimensions(16,16);e.set_palette(7);
 const lut=new Uint8Array(e.memory.buffer,e.gamma_lut_ptr(),256);for(let k=0;k<256;k++)lut[k]=k;e.apply_palette_gamma();return e;}
function frame({mode=0,color=1,bright=0,speed=80,scale=190,light=128,volume=.6,mix=1,range=[0,255],spect=1,wave=1}={}){
 const e=instance();e.set_effects(color,bright,mode);e.set_parameters(speed,scale,light,mix);e.set_audio_range(...range);e.reset_render();
 const feat=new Float32Array(e.memory.buffer,e.audio_features_ptr(),159);feat.fill(0);
 for(let i=0;i<16;i++)feat[i]=spect;
 for(let i=0;i<128;i++)feat[24+i]=wave;
 feat[23]=volume;
 // Two frames ensure dynamic effect phases are influenced by Speed.
 for(let t=0;t<2;t++)e.render_frame(16.6667);
 return Uint8Array.from(new Uint8Array(e.memory.buffer,e.framebuffer_ptr(),16*16*4));
}
function equal(a,b,msg){assert.deepEqual(a,b,msg)}
function different(a,b,msg){assert.notDeepEqual(a,b,msg)}
// Core firmware behavior at 100% mix: speed/scale/light modify preset BEFORE render.
for(const [mode,key,target,base] of [[8,'speed',255,25],[9,'scale',255,0],[10,'light',255,25]]){
 const config={mode,color:mode===10?9:mode===8?1:0,bright:0,speed:25,scale:0,light:25,volume:1,mix:1};
 const reactive=frame(config);
 const expected=frame({...config,mode:0,[key]:target});
 equal(reactive,expected,`parametric mode ${mode} did not change ${key} BEFORE rendering`);
 different(reactive,frame({...config,mode:0}),`parametric mode ${mode} was a no-op`);
 equal(frame({...config,mode,mix:0}),frame({...config,mode:0}),`mix 0 failed in param mode ${mode}`);
}
// AudioConfig range [min,max] changes parameter mapping (zero source must yield min).
const r=frame({mode:8,color:1,speed:25,volume:0,range:[96,160]});
equal(r,frame({color:1,speed:96}),`Audio minimum not applied to Speed Control`);
const rmax=frame({mode:8,color:1,speed:25,volume:1,range:[96,160]});
equal(rmax,frame({color:1,speed:160}),`Audio maximum not applied to Speed Control`);
// Auditory overlay modes have source-correct signal behavior. All-zero volume hides image.
const bright=frame({mode:0,color:9,bright:0,speed:30,scale:180,light:180});
for(const mode of [1,2,3,4,5,6,7]){
 const reactive=frame({mode,color:9,bright:0,speed:30,scale:180,light:180,volume:0,spect:0,wave:0});
 const rgb=reactive.filter((_,i)=>i%4!==3);
 assert(rgb.every(x=>x===0),`audio mode ${mode} left pixels lit on zero signal`);
 equal(frame({mode,color:9,speed:30,scale:180,light:180,volume:0,spect:0,wave:0,mix:0}),bright,`mix0 mode ${mode}`);
}
// Mirror symmetry of centered column overlays; non-centered differ given asymmetric columns.
const waveLeft=frame({mode:1,bright:0,color:9,light:180,wave:.35});
const waveCenter=frame({mode:2,bright:0,color:9,light:180,wave:.35});
assert(waveLeft.length===waveCenter.length);
const dsp=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(root,'web/wasm/dsp.wasm')))).exports;
dsp.reset_dsp();const wav=new Uint16Array(dsp.memory.buffer,dsp.old_wave_input_ptr(),16);const par=new Uint16Array(dsp.memory.buffer,dsp.old_param_input_ptr(),64);
for(let j=0;j<10;j++){for(let i=0;i<16;i++)wav[i]=512+Math.round(Math.sin(i/16*Math.PI*2)*j*20);for(let i=0;i<64;i++)par[i]=512+Math.round(Math.sin(i/64*Math.PI*2)*j*20);dsp.old_volume_process(0,1,0);dsp.old_volume_process(1,1,0);}
assert(dsp.old_param_value()>0&&dsp.old_param_value()<=1,'legacy parametric analyzer unresponsive');
const history=new Float32Array(dsp.memory.buffer,dsp.old_wave_ptr(),128);assert(history.some(x=>x>0),'legacy wave history empty');
console.log('PASS: 10 firmware audio modes, parametric pre-render application, audio min/max/mix, legacy wave/volume DSP');
