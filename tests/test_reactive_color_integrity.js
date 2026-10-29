'use strict';
// Regression: Bass/Mid/High and Onset reactive modes must not inject off-palette
// white pixels or brighten arbitrary center/speckle positions.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const wasm=new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/render.wasm')));
function render(size,color,brightness,mode){
 const e=new WebAssembly.Instance(wasm).exports;
 e.set_dimensions(size,size);e.set_palette(7); // Fiery has no white stop
 const gamma=new Uint8Array(e.memory.buffer,e.gamma_lut_ptr(),256);for(let i=0;i<256;i++)gamma[i]=i;
 e.apply_palette_gamma();
 e.set_effects(color,brightness,mode);e.set_parameters(82,190,180,.85);
 e.reset_render();
 const features=new Float32Array(e.memory.buffer,e.audio_features_ptr(),159);
 for(let i=0;i<16;i++)features[i]=.75;
 // Force every reactive white overlay's former threshold to fire.
 for(let i=16;i<22;i++)features[i]=1;
 features[22]=features[23]=.8;
 e.render_frame(16.6667);
 return Uint8Array.from(new Uint8Array(e.memory.buffer,e.framebuffer_ptr(),size*size*4));
}
for(const size of [16,32])for(let color=0;color<10;color++)for(let brightness=0;brightness<5;brightness++){
 const base=render(size,color,brightness,0);
 for(const mode of [11,12]){
  const reactive=render(size,color,brightness,mode);
  for(let i=0;i<reactive.length;i++){
   if(i%4===3)assert.equal(reactive[i],255);
   else assert(reactive[i]<=base[i],`unexpected highlight size=${size} color=${color} bright=${brightness} mode=${mode} pixel=${Math.floor(i/4)} channel=${i%4}: ${reactive[i]} > ${base[i]}`);
  }
 }
}
const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8')+fs.readFileSync(path.join(__dirname,'../web/css/app.css'),'utf8');
const webSource=()=>fs.readdirSync(path.join(__dirname,'../web/js')).map(f=>fs.readFileSync(path.join(__dirname,'../web/js',f),'utf8')).join('\n');
const js=webSource();
assert.match(html,/\.workspace-grid\{display:grid/);
assert.match(html,/<div class="tabpanels">/);
assert.match(html,/id="floating-preview" hidden/);
assert.match(js,/updateFloatingPreview/);
assert.match(js,/floating-.*side/);
console.log('PASS: reactive modes 11/12 preserve base color on 200 matrices, workspace/tabs/mirrored preview markup');
