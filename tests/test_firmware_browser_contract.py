"""Contract regression against the actual feature/remote-audio-dsp firmware handshake.
Uses a simulated WebSocket receiver, not physical ESP hardware.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page()
    failures=[]
    page.on('pageerror',lambda exc:failures.append(str(exc)))
    page.evaluate('''() => {
      window.__firmwareLog=[];
      window.WebSocket=class FirmwareCompatibleSocket {
        constructor(){this.readyState=0;this.bufferedAmount=0;this.owner=0;this.clock=false;this.playing=false;this.received=0;this.dropped=0;this.session=0;
          setTimeout(()=>{this.readyState=1;this.onopen?.({});},2);}
        send(data){
          const reply=obj=>setTimeout(()=>this.onmessage?.({data:JSON.stringify(obj)}),2);
          if(data instanceof ArrayBuffer){
            const v=new DataView(data),session=v.getUint32(8,true),count=v.getUint8(7);
            if(!this.playing||session!==this.session||count!==32||data.byteLength!==102){this.dropped++;return;}
            this.received++;window.__firmwareLog.push({type:'frame',session,bytes:data.byteLength});return;
          }
          const m=JSON.parse(data);window.__firmwareLog.push(m);
          if(m.type==='hello'){
            this.owner=1;this.session=1;this.clock=false;this.playing=false;
            reply({type:'hello_ack',version:1,session:1,bands:32,band_counts:[32],fps:60});
          }else if(m.type==='sync')reply({type:'sync_ack',id:m.id,t0:m.t0,t1:performance.now()+21,t2:performance.now()+21});
          else if(m.type==='clock'){this.clock=true;reply({type:'clock_ack',session:this.session});}
          else if(m.type==='config')reply({type:'config_ack',session:this.session});
          else if(m.type==='start'){
            if(!this.clock)reply({type:'error',reason:'clock_not_set'});
            else {this.session=m.session_id;this.playing=true;reply({type:'start_ack',session:this.session});}
          }else if(m.type==='stop'){this.playing=false;reply({type:'stop_ack',session:this.session});}
          else if(m.type==='status')reply({type:'status',session:this.session,playing:this.playing,received_frames:this.received,dropped:this.dropped,buffer_occupancy:0});
        }
        close(){this.readyState=3;this.onclose?.({});}
      }
    }''')
    page.set_content((ROOT/'dist'/'standalone.html').read_text())
    page.wait_for_function('STATE.ready',timeout=10000)
    assert page.locator('#remote-enable').is_checked()
    page.locator('#remote-address').fill('192.168.4.1')
    page.locator('#remote-add').click()
    page.wait_for_function("REMOTE.devices[0]?.status==='ready'",timeout=10000)
    page.wait_for_timeout(200)
    assert page.evaluate('!REMOTE.devices[0].receiverPlaying && REMOTE.devices[0].sent===0')
    page.locator('#demo').click()
    page.wait_for_function('REMOTE.devices[0].sent>=10 && REMOTE.devices[0].receiverPlaying',timeout=15000)
    page.wait_for_function('REMOTE.devices[0].received>=10',timeout=10000)
    assert page.evaluate('''() => __firmwareLog.some(m=>m.type==='start')''')
    assert page.evaluate('''() => __firmwareLog.some(m=>m.type==='frame'&&m.bytes===102)''')
    print('PASS firmware-like receiver: idle -> start_ack -> binary 32-band frames -> status playing true')
    page.locator('#remote-bands').select_option('64',force=True)
    page.wait_for_timeout(120)
    assert page.evaluate('REMOTE.devices[0].session===null')
    assert page.evaluate('!REMOTE.devices[0].supported.includes(64)')
    assert 'only accepts 32' in page.locator('#remote-state').inner_text()
    print('PASS mismatch: firmware 32-only support diagnosed, no invalid packets sent')
    assert not failures, failures
    browser.close()
