"""Effect parameters in Chromium: the controls of the running visualization,
the preview gets them, a lamp with the "params" capability receives a params
message after its config (and again on a change), an older lamp gets none, and
a lamp's own parameter values are kept like its other Reaction settings.
Lamps are in-page fake WebSockets (see test_remote_browser.py).
Run: python tests/test_fx_params_browser.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
NEW,OLD='ws://127.0.0.1:8765/audio','ws://127.0.0.1:8767/audio'
errors=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,
        args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page(viewport={'width':1440,'height':900})
    page.on('pageerror',lambda e:errors.append(str(e)))
    # Port 8767 is firmware from before effect parameters (and the four new modes).
    page.evaluate('''() => {
      window.__control=[];window.__playing={};
      window.WebSocket=class FakeSocket {
        static OPEN=1;
        constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;this.old=url.includes(':8767');
          setTimeout(()=>{this.readyState=1;this.onopen?.({});},2);}
        send(data){
          if(data instanceof ArrayBuffer)return;
          const msg=JSON.parse(data);__control.push({url:this.url,...msg});
          const reply=obj=>setTimeout(()=>this.onmessage?.({data:JSON.stringify(obj)}),2);
          const ids=n=>Array.from({length:n},(_,i)=>12+i);
          if(msg.type==='hello')reply(this.old
            ?{type:'hello_ack',version:1,band_counts:[16,32,64],width:16,height:16,capabilities:['sync','clock','config','status','tuning','visualizations'],visualizations:ids(13)}
            :{type:'hello_ack',version:1,band_counts:[16,32,64],width:16,height:16,capabilities:['sync','clock','config','status','tuning','visualizations','params'],visualizations:ids(17),params_version:1});
          if(msg.type==='sync')reply({type:'sync_ack',id:msg.id,t1:performance.now(),t2:performance.now()});
          if(msg.type==='clock')reply({type:'clock_ack'});
          if(msg.type==='config')reply({type:'config_ack'});
          if(msg.type==='params')reply({type:'params_ack'});
          if(msg.type==='start'){__playing[this.url]=true;reply({type:'start_ack',session:msg.session_id});}
          if(msg.type==='stop'){__playing[this.url]=false;reply({type:'stop_ack'});}
          if(msg.type==='status')reply({type:'status',playing:!!__playing[this.url],received_frames:0,buffer_occupancy:0});
        }
        close(){this.readyState=3;setTimeout(()=>this.onclose?.({code:1000}),1);}
      };
    }''')
    page.set_content((ROOT/'dist'/'standalone.html').read_text())
    page.wait_for_function('STATE.ready',timeout=15000)

    # Controls: only the running mode's parameters; a parameter that does nothing is hidden.
    page.locator('#tab-reaction').click()
    page.locator('.choices[data-for="audio-mode"] label',has_text='Zones').click()
    assert page.evaluate("$('audio-mode').value")=='28'
    visible=page.evaluate("[...document.querySelectorAll('#fx-params [data-fx]')].filter(e=>e.offsetParent).map(e=>e.dataset.fx)")
    assert visible and all(v.startswith('fx-28-') for v in visible),visible
    assert 'fx-28-pattern' not in visible,'the hit pattern is hidden while the zones are an equalizer'
    page.locator('.choices[data-for="fx-28-trigger"] label',has_text='Any hit').click()
    assert page.locator('[data-fx="fx-28-pattern"]').is_visible()
    assert page.locator('#fx-28-decay-value').inner_text()=='650 ms'
    print('PASS controls of the running mode, value labels, dependent parameter shown on demand')

    # The preview renders with them: the WASM holds the values in engine order.
    page.locator('#fx-28-zones').fill('5')
    wasm=page.evaluate("[...new Uint8Array(STATE.modules.new.exports.memory.buffer,STATE.modules.new.exports.viz_params_ptr(),9)]")
    assert wasm==page.evaluate("[...fxValues(settings(),28)]") and wasm[0]==5 and wasm[2]==5 and wasm[8]==128,wasm
    page.locator('.choices[data-for="audio-mode"] label',has_text='Mood').click()
    wasm=page.evaluate("[...new Uint8Array(STATE.modules.new.exports.memory.buffer,STATE.modules.new.exports.viz_params_ptr(),4)]")
    assert wasm==[48,90,200,0],'Mood: engine order with the map last, defaults'
    print('PASS preview gets the parameters in engine order')

    # Lamps: the new one gets params after config and again on a change; the old one never does.
    page.locator('.choices[data-for="audio-mode"] label',has_text='Particles').click()
    page.locator('#tab-lamps').click()
    for port in [8765,8767]:
        page.locator('#remote-address').fill(f'127.0.0.1:{port}')
        page.locator('#remote-add').click()
    page.wait_for_function('REMOTE.devices.length===2 && REMOTE.devices.every(d=>d.status==="ready")',timeout=10000)
    page.locator('#sources-button').click();page.locator('#demo').click()
    page.wait_for_function(f'__control.some(m=>m.url==={NEW!r}&&m.type==="params")',timeout=12000)
    sent=page.evaluate(f'__control.filter(m=>m.url==={NEW!r}&&["config","params"].includes(m.type))')
    first=next(i for i,m in enumerate(sent) if m['type']=='params')
    assert any(m['type']=='config' for m in sent[:first]),'config goes first'
    msg=sent[first]
    assert msg['version']==1 and msg['effect']==26 and msg['values']==[0,0,100,100,170,90,110,90,0,128],msg
    assert page.evaluate(f'__control.every(m=>m.url!=={OLD!r}||m.type!=="params")'),'older firmware gets no params'
    assert page.evaluate(f'__control.filter(m=>m.url==={OLD!r}&&m.type==="config").pop().audio_effect')==0,'older firmware: a new mode is Off'
    count=page.evaluate(f'__control.filter(m=>m.url==={NEW!r}&&m.type==="params").length')
    page.wait_for_timeout(300)
    assert page.evaluate(f'__control.filter(m=>m.url==={NEW!r}&&m.type==="params").length')==count,'unchanged values are not resent'
    page.locator('#tab-reaction').click()
    page.locator('.choices[data-for="fx-26-shape"] label',has_text='Rain').click()
    page.wait_for_function(f'__control.filter(m=>m.url==={NEW!r}&&m.type==="params").pop().values[0]===1',timeout=5000)
    print('PASS params after config to a lamp with the capability, resent on a change only, none to older firmware')

    # A lamp's own parameter: an override like the other Reaction settings.
    page.evaluate(f'selectTarget({NEW!r})')
    page.locator('#fx-26-amount').fill('255')
    page.wait_for_function(f'__control.filter(m=>m.url==={NEW!r}&&m.type==="params").pop().values[2]===255',timeout=5000)
    assert page.evaluate(f'Object.keys(LAMP_PROFILES[{NEW!r}].overrides)')==['fx-26-amount']
    page.evaluate("selectTarget('all')")
    assert page.evaluate("$('fx-26-amount').value")=='100'
    page.evaluate(f'selectTarget({NEW!r})')
    page.locator('#fx-reset').click()
    assert page.evaluate(f'Object.keys(LAMP_PROFILES[{NEW!r}].overrides)')==[]
    print('PASS per-lamp parameter override and section reset')
    assert not errors,errors
    browser.close()
