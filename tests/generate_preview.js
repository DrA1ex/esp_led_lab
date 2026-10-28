'use strict';
const fs=require('node:fs');const path=require('node:path');
const w=16,h=16;
const wasm=fs.readFileSync(path.join(__dirname,'../web/wasm/render.wasm'));
const m=new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports;
m.set_dimensions(w,h);
const gamma=new Uint8Array(m.memory.buffer,m.gamma_lut_ptr(),256);
for(let i=0;i<256;i++)gamma[i]=i===0?0:Math.max(1,Math.floor(255*Math.pow(i/255,2.2)));
const dest=path.join(__dirname,'preview_rgb.bin');const out=Buffer.alloc(10*w*h*3);
for(let fx=0;fx<10;fx++){
 m.reset_render();m.set_palette(fx===2?8:fx===3?6:fx===7?3:fx===8?11:3);m.apply_palette_gamma();m.set_effects(fx,0,0);m.set_parameters(80,190,128,0);
 for(let t=0;t<90;t++)m.render_frame(16.666667);
 const ptr=m.framebuffer_ptr();const rgba=new Uint8Array(m.memory.buffer,ptr,w*h*4);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const ri=((((y&1)?w-1-x:x)+y*w)*4),oi=((fx*w*h+(h-1-y)*w+x)*3);
  out[oi]=rgba[ri];out[oi+1]=rgba[ri+1];out[oi+2]=rgba[ri+2];
 }
}
fs.writeFileSync(dest,out);
console.log('Generated',dest);
