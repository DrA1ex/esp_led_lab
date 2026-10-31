'use strict';
// Reproduce the meter freeze using a deterministic animation clock. FPS and
// status updates must never suppress a rendered frame's spectrum update.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../web/js/main.js'),'utf8');
const calls=[],stats={textContent:''},STATE={ready:true,playing:false,tailUntil:-1,lastFrame:0,lastStats:0,lastUi:0,frames:0,modules:{new:{exports:{render_frame(){}}}}};
const ctx={STATE,Math,LAYOUT:{test:false},requestAnimationFrame(){},settings:()=>({}),feedRender(){},paint(){},meters:()=>calls.push(STATE.lastFrame),refreshEffective(){},$:()=>stats};
vm.createContext(ctx);
vm.runInContext(source.slice(0,source.indexOf("$('fps').hidden=")),ctx);
for(let frame=1;frame<=240;frame++)ctx.animate(frame*1000/60);
assert.equal(calls.length,240,'meters skipped animation frames near an FPS update');
assert(calls.every((v,i)=>!i||v-calls[i-1]<17),'periodic spectrum freeze');
assert.match(stats.textContent,/60 FPS/);
console.log('PASS analyzer: all 240 rendered frames update meters across four FPS intervals');
