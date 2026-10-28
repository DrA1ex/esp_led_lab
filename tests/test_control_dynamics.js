'use strict';
// Render-level contract tests: old renderer remains exact source mapping;
// new renderer can deliberately opt into more expressive music response.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const mod=new WebAssembly.Module(fs.readFileSync(path.join(root,'web/wasm/render.wasm')));
const dspmod=new WebAssembly.Module(fs.readFileSync(path.join(root,'web/wasm/dsp.wasm')));
function newRenderer(){const e=new WebAssembly.Instance(mod).exports;e.set_dimensions(16,16);e.set_palette(4);const lut=new Uint8Array(e.memory.buffer,e.gamma_lut_ptr(),256);for(let j=0;j<256;j++)lut[j]=j;e.apply_palette_gamma();e.set_parameters(82,190,180,1);e.set_audio_range(0,255);return e;}
function setup(e,mode,{v=.3,line=.3,bands=.3,shape=0,onsets=0,fastLine=0,speedFloor=0,color=9}={}){
 e.set_effects(color,0,mode);e.set_reaction_tuning(shape,onsets,fastLine,speedFloor);e.reset_render();
 const f=new Float32Array(e.memory.buffer,e.audio_features_ptr(),160);f.fill(0);f[23]=v;f[159]=line;for(let i=0;i<16;i++)f[i]=bands;
}
function snapshot(e){return Uint8Array.from(new Uint8Array(e.memory.buffer,e.framebuffer_ptr(),16*16*4));}
function meanRGB(frame){let s=0;for(let i=0;i<frame.length;i+=4)s+=frame[i]+frame[i+1]+frame[i+2];return s/(frame.length/4*3*255);}
const same=(a,b)=>assert.deepEqual(a,b);
const different=(a,b)=>assert.notDeepEqual(a,b);
{
 const source=newRenderer(),control=newRenderer();
 setup(source,3,{v:.3,bands:.3,shape:0});setup(control,3,{v:.3,bands:.3,shape:.75});
 source.render_frame(16.66);control.render_frame(16.66);
 const a=meanRGB(snapshot(source)),b=meanRGB(snapshot(control));
 assert(b>a*2.5,`new spectrum curve too dim: ${a} vs ${b}`);
 console.log('PASS new spectrum visible; brightness old:',a.toFixed(3),'new:',b.toFixed(3));
}
{
 const a=newRenderer(),b=newRenderer();setup(a,6,{v:.25,line:.95});setup(b,6,{v:.25,line:.95,fastLine:1});
 a.render_frame(16.66);b.render_frame(16.66);
 assert(meanRGB(snapshot(b))>meanRGB(snapshot(a))*2.5,'new line envelope not more expressive');
 console.log('PASS new Line follows fast loudness transients');
}
{
 const a=newRenderer(),b=newRenderer();setup(a,8,{v:.5,color:0});setup(b,8,{v:.5,color:0,speedFloor:144});
 a.render_frame(16.66);b.render_frame(16.66);
 different(snapshot(a),snapshot(b),'Speed floor did not affect real WASM renderer');
 const old=newRenderer(),expect=newRenderer();setup(old,8,{v:0.5,color:0});setup(expect,0,{v:.5,color:0});
 expect.set_parameters(127,190,180,1);
 // Numeric floor still 0 on the original side; no accidental expression.
 for(let t=0;t<6;t++){old.render_frame(16.66);expect.render_frame(16.66);}
 same(snapshot(old),snapshot(expect));
 console.log('PASS new speed floor changes C++ animation, legacy remains untouched');
}
{
 const e=new WebAssembly.Instance(dspmod).exports;e.reset_dsp();
 const wav=new Uint16Array(e.memory.buffer,e.old_wave_input_ptr(),16);
 for(let i=0;i<16;i++)wav[i]=512+(i%2)*100;
 const h=e.old_wave_head();e.old_volume_process(0,1,0);
 assert.equal(e.old_wave_head(),(h+127)%128,'legacy history must advance once per 40Hz update');
 console.log('PASS legacy wave history advances once per sample');
}
