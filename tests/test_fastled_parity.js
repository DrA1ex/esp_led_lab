'use strict';
// Regression checks against explicit FastLED 3.6.0 arithmetic formulas and
// LED LAMP's serpentine XY layout. This is not hardware validation.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const path = require('node:path');
const wasm = fs.readFileSync(path.join(__dirname, '../web/wasm/render.wasm'));
const m = new WebAssembly.Instance(new WebAssembly.Module(wasm)).exports;
const scale8 = (x, s) => Math.floor(x * (s + 1) / 256);
const blend8 = (a,b,t) => ((a << 8) | b) + (b*t) - (a*t);
const ease8quad = i => {let j = i&128 ? 255-i:i;let v = (2*scale8(j,j))&255; return i&128?255-v:v};
const ease8cubic = i => {const ii=scale8(i,i),iii=scale8(ii,i),r=3*ii-2*iii;return r&256?255:r&255};
const cubicwave8 = x => ease8cubic(((x&128)?255-x:x)*2&255);
const sin16 = v => {const b=[0,6393,12539,18204,23170,27245,30273,32137],s=[49,48,44,38,31,23,14,4];let off=(v&0x3fff)>>3;if(v&0x4000)off=2047-off;let index=Math.floor(off/256);let result=b[index]+s[index]*Math.floor((off&255)/2);return (v&0x8000)?(-result||0):result;};
for(let i=0;i<256;i++) {
  assert.equal(m.test_cubicwave8(i),cubicwave8(i),`FastLED cubicwave8(${i})`);
}
for(let i=0;i<65536;i++) {
  assert.equal(m.test_sin16(i),sin16(i),`FastLED sin16(${i})`);
}
for(let a=0;a<256;a+=17)for(let b=0;b<256;b+=11)for(let k=0;k<256;k+=19) {
  assert.equal(m.test_blend8(a,b,k),((blend8(a,b,k)%65536)+65536)%65536>>8,`blend8(${a},${b},${k})`);
}
// Frozen vectors for the port of FastLED 3.6.0 noise.cpp. Check native
// FastLED separately when updating the upstream version.
for(const [x,y,v] of [[0,0,32722],[65536,65536,32722],[12345678,87654321,38347],[0x1234abcd,0x0f1e2d3c,22948]]){
 assert.equal(m.test_inoise16_2d(x,y),v,`inoise16(${x},${y})`);
}
for(const [x,y,z,v] of [[0,0,0,32745],[65536,65536,65536,32745],[12345678,87654321,13579,38805],[0x1234abcd,0x0f1e2d3c,0x00998877,35944]]){
 assert.equal(m.test_inoise16_3d(x,y,z),v,`inoise16(${x},${y},${z})`);
}
// Explicit non-square dimensions catch both odd/even serpentine row mistakes.
for(const [w,h] of [[5,4],[6,5],[16,16],[32,32]]){
 m.set_dimensions(w,h);m.render_test_pattern(0);
 const px=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),w*h*4);
 const logical=(x,y)=>{let i=((y&1)?w-1-x:x)+w*y;return [px[i*4],px[i*4+1],px[i*4+2]];};
 assert.deepEqual(logical(0,0),[255,0,0]);
 assert.deepEqual(logical(w-1,0),[0,255,0]);
 assert.deepEqual(logical(0,h-1),[0,0,255]);
 assert.deepEqual(logical(w-1,h-1),[255,255,255]);
 // The centre column (Layout::testPattern): yellow where Center modes centre.
 assert.deepEqual(logical(w>>1,1),[255,192,0]);
}
// An open strip's offset moves the centre; past the end it is not drawn.
m.set_dimensions(46,1);m.render_test_pattern(-3);
{const px=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),46*4);assert.deepEqual([...px.slice(20*4,20*4+3)],[255,192,0]);}
m.set_dimensions(8,1);m.render_test_pattern(40);
{const px=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),8*4);assert.deepEqual([...px.slice(4*4,4*4+3)],[0,0,0]);}
const html=fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8')+fs.readFileSync(path.join(__dirname,'../web/css/app.css'),'utf8');
const webSource=()=>fs.readdirSync(path.join(__dirname,'../web/js')).map(f=>fs.readFileSync(path.join(__dirname,'../web/js',f),'utf8')).join('\n');
const js=webSource();
assert.match(html,/id="invert-y" checked/);
assert.match(html,/id="layout-test"/);
assert.match(js,/dstY=invertY\?h-1-wy:wy/);
console.log('PASS: FastLED fixed arithmetic sin16/cubicwave8/blend8, frozen noise vectors, serpentine corners, the orientation test and the first-row-at-bottom UI');
