"""Chromium integration test with an in-browser fake WebSocket endpoint.
The test environment blocks localhost navigation; use mock_remote_receiver.py for
end-to-end LAN testing on a machine where local sockets are permitted.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,
        args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page()
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.evaluate('''() => {
      window.__frames=[];window.__control=[];window.__playing=false;
      window.WebSocket=class FakeSocket {
        static OPEN=1;
        constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;
          setTimeout(()=>{this.readyState=1;this.onopen?.({});},2);}
        send(data){
          if(data instanceof ArrayBuffer){window.__frames.push({url:this.url,buf:data});return;}
          const msg=JSON.parse(data);window.__control.push({url:this.url,...msg});
          const reply=obj=>setTimeout(()=>this.onmessage?.({data:JSON.stringify(obj)}),2);
          if(msg.type==='hello')reply({type:'hello_ack',version:1,band_counts:[16,32,64]});
          if(msg.type==='sync')reply({type:'sync_ack',id:msg.id,t1:performance.now()+22,t2:performance.now()+22});
          if(msg.type==='clock')reply({type:'clock_ack'});
          if(msg.type==='start'){window.__playing=true;reply({type:'start_ack',session:msg.session_id});}
          if(msg.type==='stop'){window.__playing=false;reply({type:'stop_ack'});}
          if(msg.type==='status')reply({type:'status',playing:window.__playing,received_frames:window.__frames.length,buffer_occupancy:0});
        }
        close(){this.readyState=3;this.onclose?.({});}
      };
    }''')
    page.set_content((ROOT/'dist'/'standalone.html').read_text())
    page.wait_for_function('STATE.ready',timeout=10000)
    for port in [8765,8766]:
        page.locator('#remote-address').fill(f'127.0.0.1:{port}')
        page.locator('#remote-add').click()
    page.wait_for_function('REMOTE.devices.length===2 && REMOTE.devices.every(d=>d.status==="ready")',timeout=10000)
    assert page.locator('#remote-enable').is_checked(), 'Remote streaming must be enabled by default'
    page.locator('#demo').click()
    page.wait_for_function('REMOTE.devices.every(d=>d.sent>=10 && d.started)',timeout=12000)
    assert page.evaluate('''() => __frames.filter(f=>new DataView(f.buf).getUint8(7)===32).length>=20''')
    assert page.evaluate('''() => __control.filter(f=>f.type==='start').length>=2''')
    assert page.evaluate('REMOTE.devices.every(d=>d.receiverPlaying)')
    assert page.evaluate('''() => __control.filter(f=>f.type==='clock').length>=2''')
    print('PASS 32-band multi-device mock socket / handshake / clock / demo stream')
    for count in [16,64]:
        page.locator('#remote-bands').select_option(str(count))
        page.wait_for_function(f'__frames.some(f=>new DataView(f.buf).getUint8(7)==={count})',timeout=10000)
        expected=38+count*2
        assert page.evaluate(f'''() => __frames.filter(f=>new DataView(f.buf).getUint8(7)==={count}).every(f=>f.buf.byteLength==={expected})''')
        print('PASS',count,'band negotiation, size',expected)
    old=page.evaluate('RS.session')
    page.locator('#play').click()
    page.wait_for_timeout(150)
    assert page.evaluate('REMOTE.devices.every(d=>d.session===null)')
    page.locator('#play').click()
    page.wait_for_function('REMOTE.devices.every(d=>d.session!==null)',timeout=10000)
    assert old!=page.evaluate('RS.session')
    print('PASS pause/resume fresh session')
    page.locator('#remote-enable').uncheck(force=True)
    assert page.evaluate('REMOTE.devices.every(d=>d.session===null)')
    assert page.evaluate('STATE.playing')
    # Microphone is a separate causal source; no future PCM is available.
    page.evaluate('''() => {
      Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
        const c=STATE.context,osc=c.createOscillator(),out=c.createMediaStreamDestination();
        osc.frequency.value=180;osc.connect(out);osc.start();return out.stream;
      }}});
    }''')
    page.locator('#remote-enable').check(force=True)
    page.locator('#audio-input').select_option('microphone',force=True)
    page.wait_for_function('STATE.mic && STATE.mic.written>4096',timeout=18000)
    page.wait_for_function('''__frames.some(f=>new DataView(f.buf).getUint8(6)&1)''',timeout=18000)
    assert page.evaluate('''() => __frames.some(f => (new DataView(f.buf).getUint8(6)&1) &&
        new DataView(f.buf).getUint8(7)===64)''')
    page.locator('#audio-input').select_option('file',force=True)
    page.wait_for_function('STATE.mic===null')
    print('PASS microphone causal frames, live flag, track cleanup and source change')
    assert not errors,errors
    print('PASS independent stream toggle / local playback / no browser exceptions')
    browser.close()
