// Remote clock sync: windowed best-RTT offset, refresh while streaming, no
// "clock setup" gap (which used to drop frames) once the device is synced.
const assert=require('node:assert/strict');
const RemoteAudio=require('../web/js/remote.js');
const sent=[];
const d=new RemoteAudio.Device('192.168.1.5',()=>{});
d.socket={readyState:1,bufferedAmount:0,send:m=>sent.push(m),close(){}};
d.status='synchronizing';
const texts=()=>sent.filter(m=>typeof m==='string').map(JSON.parse);
let clockNow=1000;const realNow=performance.now;performance.now=()=>clockNow;
function exchange(deviceOffset,rtt){
 d.sync();const msg=texts().filter(m=>m.type==='sync').pop();
 clockNow+=rtt;const t1=msg.t0+rtt/2+deviceOffset;
 d.message({type:'sync_ack',id:msg.id,t1,t2:t1});
}
d.message({type:'hello_ack',version:1,width:153,height:1,band_counts:[32],capabilities:['sync','clock','config','status','tuning']});
assert.equal(d.width,153);assert.equal(d.height,1);assert(d.capabilities.includes('tuning'));
assert.deepEqual(d.visualizations,[],'older firmware: no visualizations');
{const v=new RemoteAudio.Device('192.168.1.6',()=>{});v.socket={readyState:1,bufferedAmount:0,send(){},close(){}};
 v.message({type:'hello_ack',version:1,width:16,height:16,band_counts:[16,32,64],visualizations:[12,13,22]});
 assert.deepEqual(v.visualizations,[13,14,23],'firmware ids map to lab modes (+1)');}
exchange(500,20);
assert.equal(texts().filter(m=>m.type==='clock').pop().offset_ms,500);
d.message({type:'clock_ack'});assert.equal(d.status,'ready');
exchange(500,4);exchange(500,30);
// The device clock drifts by +40 ms: once old samples age out the offset follows.
clockNow+=31000;
exchange(540,25);
assert.equal(d.clockOffset,540,'offset follows drift after the window');
assert.equal(d.status,'ready','resync never leaves the ready state');
const clocks=texts().filter(m=>m.type==='clock');
assert.equal(clocks.length,2,'clock is re-sent only when the offset changes');
// Periodic refresh also happens while a session is streaming.
d.session=7;d.lastStatus=clockNow;const before=texts().filter(m=>m.type==='sync').length;
d.tick(clockNow+6000);
assert.equal(texts().filter(m=>m.type==='sync').length,before+1);
performance.now=realNow;
console.log('PASS remote clock: burst/window best-RTT offset, drift tracking, streaming resync, ready kept');
