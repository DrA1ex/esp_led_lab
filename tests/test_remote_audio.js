'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const RemoteAudio=require('../web/js/remote.js');
for(const count of [16,32,64]){
 const bands=Array.from({length:count},(_,i)=>4096*i/(count-1));
 const bytes=RemoteAudio.serialize({bands,session:0x10203040,seq:0x55667788,timestamp:0x12345678,
  rms:4096,bass:1234,mid:2345,high:3456,peak:3900,onsetStrength:4000,
  onsetMask:5,beatPhase:127,bpm:1276,confidence:210,live:true});
 const dv=new DataView(bytes);
 assert.equal(bytes.byteLength,38+count*2);
 assert.equal(Buffer.from(bytes,0,4).toString('ascii'),'ELAF');
 assert.equal(dv.getUint8(4),1);assert.equal(dv.getUint8(5),1);assert.equal(dv.getUint8(6),1);
 assert.equal(dv.getUint8(7),count);assert.equal(dv.getUint32(8,true),0x10203040);
 assert.equal(dv.getUint32(12,true),0x55667788);assert.equal(dv.getUint32(16,true),0x12345678);
 for(const [idx,value] of [4096,1234,2345,3456,3900,4000].entries())assert.equal(dv.getUint16(20+idx*2,true),value);
 assert.equal(dv.getUint8(32),5);assert.equal(dv.getUint8(33),127);
 assert.equal(dv.getUint16(34,true),1276);assert.equal(dv.getUint8(36),210);assert.equal(dv.getUint8(37),0);
 assert.equal(dv.getUint16(38,true),0);assert.equal(dv.getUint16(38+(count-1)*2,true),4096);
}
assert.equal(RemoteAudio.addressToUrl('192.168.1.1'),'ws://192.168.1.1/audio');
assert.equal(RemoteAudio.addressToUrl('ws://lamp.local:81/audio'),'ws://lamp.local:81/audio');
assert.throws(()=>RemoteAudio.addressToUrl('https://bad'),/ws/);
const wasm=new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(__dirname,'../web/wasm/dsp.wasm')))).exports;
const input=new Float32Array(wasm.memory.buffer,wasm.new_input_ptr(),1024);
for(const size of [256,512,1024]){
 wasm.reset_dsp();
 let nonzero=[false,false,false];
 for(let frame=0;frame<50;frame++){
  for(let i=0;i<size;i++){
   const t=(frame*256-size+i)/16000;
   input[i]=Math.sin(2*Math.PI*440*t)*.5+Math.sin(2*Math.PI*1250*t)*.25;
  }
  wasm.new_process(size,256/16000,25,210,.008,1,1.6,.82,900,0);
  for(const [n,ptr] of [[16,wasm.new_bands_ptr()],[32,wasm.new_remote32_ptr()],[64,wasm.new_remote64_ptr()]]){
   const values=new Float32Array(wasm.memory.buffer,ptr,n);
   assert(values.every(x=>Number.isFinite(x)&&x>=0&&x<=1));
   if(values.some(x=>x>.005))nonzero[[16,32,64].indexOf(n)]=true;
  }
 }
 assert(nonzero.every(Boolean),`no bands for FFT ${size}: ${nonzero}`);
}
console.log('PASS remote v1 16/32/64 binary vectors + C++/WASM single-FFT spectra (256/512/1024)');
