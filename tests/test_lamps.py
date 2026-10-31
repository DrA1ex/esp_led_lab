"""Per-lamp settings in Chromium with in-page fake lamps: All lamps vs one lamp as the edited
target, what each lamp receives in its config, the preview of the edited lamp, own-setting
marks, resets, the layout read from each lamp and written back (one lamp, or the field that
changed to every lamp), the orientation test on the lamps, per-lamp band count, names,
removal and the profiles remembered across a reload.
Run: python tests/test_lamps.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STANDALONE = ROOT / 'dist' / 'standalone.html'
A, B = 'ws://127.0.0.1:8765/audio', 'ws://127.0.0.1:8766/audio'
FAKES = '''() => {
  window.__config={};window.__bands={};window.__lamps={};window.__layoutMsgs={};
  window.WebSocket=class FakeSocket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;
      this.lamp=__lamps[url]||={power:true,brightness:255,strip:url.includes(':8766'),playing:false,test:false,
        layout:url.includes(':8766')?{flip_x:false,flip_y:false,ring:true,offset:5}:{flip_x:false,flip_y:false,ring:false,offset:0}};
      setTimeout(()=>{this.readyState=1;this.onopen?.({});},2);}
    send(data){
      if(data instanceof ArrayBuffer){__bands[this.url]=new DataView(data).getUint8(7);return;}
      const msg=JSON.parse(data),lamp=this.lamp,reply=obj=>setTimeout(()=>this.onmessage?.({data:JSON.stringify(obj)}),2);
      if(msg.type==='hello')reply({type:'hello_ack',version:1,band_counts:[16,32,64],width:lamp.strip?153:16,height:lamp.strip?1:16,
        visualizations:[12,13,14,15,16,17,18,19,20,21,22,23,24],capabilities:['sync','clock','config','status','tuning','control','layout'],power:lamp.power,brightness:lamp.brightness,layout:lamp.layout});
      if(msg.type==='sync')reply({type:'sync_ack',id:msg.id,t1:performance.now(),t2:performance.now()});
      if(msg.type==='clock')reply({type:'clock_ack'});
      if(msg.type==='config')__config[this.url]=msg;
      if(msg.type==='layout'){const {type,...fields}=msg;(__layoutMsgs[this.url]||=[]).push(fields);lamp.layout={...lamp.layout,...fields};reply({type:'layout_ack',layout:lamp.layout});}
      if(msg.type==='test'){lamp.test=msg.on;reply({type:'test_ack',on:msg.on});}
      if(msg.type==='start'){lamp.playing=true;reply({type:'start_ack',session:msg.session_id});}
      if(msg.type==='stop'){lamp.playing=false;reply({type:'stop_ack'});}
      if(msg.type==='status')reply({type:'status',playing:lamp.playing,received_frames:0,buffer_occupancy:0,power:lamp.power,brightness:lamp.brightness});
    }
    close(){this.readyState=3;setTimeout(()=>this.onclose?.({code:1000}),1);}
  };
}'''
errors = []

def config(page, url, key):
    return page.evaluate(f"__config[{url!r}]?.[{key!r}]")

def wait_config(page, url, key, value):
    page.wait_for_function(f"JSON.stringify(__config[{url!r}]?.[{key!r}])===JSON.stringify({value!r})".replace('True', 'true').replace('False', 'false'), timeout=5000)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None,
                                args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    try:
        page.goto(STANDALONE.as_uri())
        stored = True
    except Exception as err:
        print('NOTE file:// navigation unavailable, skipping the reload check:', err)
        page.set_content(STANDALONE.read_text())
        stored = False
    page.wait_for_function('STATE.ready', timeout=15000)
    page.evaluate(FAKES)
    page.evaluate("$('remote-adapt').checked=true")
    assert page.locator('#targets').is_hidden(), 'no lamps: nothing to switch'
    page.locator('#tab-lamps').click()
    for port in (8765, 8766):
        page.locator('#remote-address').fill(f'127.0.0.1:{port}')
        page.locator('#remote-add').click()
    page.locator('#sources-button').click(); page.locator('#demo').click()
    page.wait_for_function(f"__config[{A!r}] && __config[{B!r}]", timeout=10000)
    assert config(page, A, 'audio_effect') == 3 and config(page, B, 'audio_effect') == 3
    assert page.locator('#targets .target').count() == 3
    print('PASS lamps stream the shared settings; switcher: All lamps + each lamp')

    # Edit the strip only: the preview becomes the strip, its controls show its own values.
    page.locator('#targets .target', has_text='127.0.0.1:8766').click()
    page.wait_for_function('STATE.modules.new.exports.get_width()===153')
    assert page.locator('#geometry-button').is_disabled() and page.locator('#matrix-label').inner_text() == '153 LED · strip'
    page.locator('#tab-reaction').click()
    assert 'Editing 127.0.0.1:8766 only' in page.locator('#panel-reaction .target-note').inner_text()
    page.locator('.choices[data-for="audio-mode"] label:has(input[value="15"])').click()  # Flow (not Chromatic Flow)
    page.locator('#input-gate').check()
    wait_config(page, B, 'audio_effect', 15)
    wait_config(page, B, 'input_gate', True)
    assert config(page, A, 'audio_effect') == 3 and config(page, A, 'input_gate') is False
    assert 'origin_ring' not in page.evaluate(f"__config[{B!r}]")  # the lamp's layout replaces it
    assert page.evaluate(f"Object.keys(LAMP_PROFILES[{B!r}].overrides).sort()") == ['audio-mode', 'input-gate']
    marks = page.evaluate("[...document.querySelectorAll('#panel-reaction .own')].map(e=>e.textContent.trim().slice(0,20))")
    assert len(marks) == 2 and any('Silence' in m for m in marks), marks
    assert '2 own settings' in page.locator('#panel-reaction .target-note').inner_text()
    assert page.locator('#targets .target', has_text='127.0.0.1:8766').locator('.own-mark').is_visible()
    print('PASS a lamp target: its preview size, own mode and gate sent only to it, marks')

    # Layout tab on the strip: the layout the lamp reported; a change goes to it only.
    page.locator('#tab-layout').click()
    assert page.locator('#layout-ring').is_checked() and page.evaluate("+$('layout-offset').value") == 5
    assert 'Saved on 127.0.0.1:8766' in page.locator('#layout-target').inner_text()
    assert page.evaluate("layoutMapper(currentLayout(),153,1)(76,0)[0]") == 81  # the ring turns 5 LEDs
    assert page.evaluate("STATE.stripLayout.ring") is True
    page.locator('#layout-offset-up').click()
    page.wait_for_function(f"JSON.stringify(__layoutMsgs[{B!r}])==='[{{\"offset\":6}}]'", timeout=5000)
    assert page.evaluate(f"__lamps[{B!r}].layout.offset") == 6 and A not in page.evaluate("Object.keys(__layoutMsgs)")
    assert '+6 LED' in page.locator('#layout-offset-value').inner_text()
    print('PASS layout read from the lamp, offset nudged and written to that lamp only')

    # All lamps again: a shared change reaches both, the strip keeps its own mode.
    page.locator('#targets .target', has_text='All lamps').click()
    page.wait_for_function('STATE.modules.new.exports.get_width()===16')
    assert page.evaluate("$('audio-mode').value") == '3' and not page.locator('#input-gate').is_checked()
    assert page.locator('#panel-reaction .own').count() == 0
    page.locator('#tab-effect').click()
    page.locator('.choice-swatch', has_text='Ocean').first.click()
    wait_config(page, A, 'palette', 49)
    wait_config(page, B, 'palette', 49)
    assert config(page, B, 'audio_effect') == 15
    # Layout on All lamps: the changed field goes to every lamp, each keeps the rest.
    page.locator('#tab-layout').click()
    assert not page.locator('#layout-ring').is_checked() and page.evaluate("+$('layout-offset').value") == 0
    page.locator('#layout-flip-x').check()
    page.wait_for_function(f"__lamps[{A!r}].layout.flip_x && __lamps[{B!r}].layout.flip_x", timeout=5000)
    assert page.evaluate(f"__lamps[{B!r}].layout") == {'flip_x': True, 'flip_y': False, 'ring': True, 'offset': 6}
    assert page.evaluate(f"__layoutMsgs[{A!r}]") == [{'flip_x': True}]
    # The orientation test runs on the lamps being edited and stops with the switch.
    page.locator('label.switch:has(#layout-test)').click()
    page.wait_for_function(f"__lamps[{A!r}].test && __lamps[{B!r}].test", timeout=5000)
    page.locator('label.switch:has(#layout-test)').click()
    page.wait_for_function(f"!__lamps[{A!r}].test && !__lamps[{B!r}].test", timeout=5000)
    print('PASS shared changes reach every lamp; layout field written to every lamp; orientation test on the lamps')

    # Section reset on a lamp returns to All lamps; "Use All lamps settings" drops the rest.
    page.locator('#targets .target', has_text='127.0.0.1:8766').click()
    page.locator('#tab-reaction').click()
    page.locator('#range-reset').click()
    wait_config(page, B, 'input_gate', False)
    assert page.evaluate(f"Object.keys(LAMP_PROFILES[{B!r}].overrides)") == ['audio-mode']
    page.locator('#panel-reaction .target-note button', has_text='Use All lamps settings').click()
    wait_config(page, B, 'audio_effect', 3)
    assert page.evaluate(f"Object.keys(LAMP_PROFILES[{B!r}].overrides)") == [] and page.evaluate("$('audio-mode').value") == '3'
    print('PASS reset a section to All lamps, use All lamps settings')

    # Lamp details: name, its own band count.
    page.locator('#tab-lamps').click()
    card = page.locator('.lamp').nth(1)
    assert 'selected' in card.get_attribute('class')
    card.locator('.lamp-more-toggle').click()
    card.locator('.lamp-rename').fill('Ceiling')
    page.wait_for_function("[...document.querySelectorAll('#targets .target')].some(b=>b.textContent.includes('Ceiling'))")
    assert card.locator('.lamp-name').inner_text() == 'Ceiling'
    card.locator('.lamp-bands').select_option('16')
    page.wait_for_function(f"__bands[{B!r}]===16", timeout=5000)
    page.wait_for_function(f"__bands[{A!r}]===16", timeout=5000)  # 16 columns: auto picks 16 too
    card.locator('.lamp-bands').select_option('64')
    page.wait_for_function(f"__bands[{B!r}]===64", timeout=5000)
    print('PASS lamp name in the card and the switcher, per-lamp band count')

    # Customize from the card: the lamp becomes the target and the Effect tab opens.
    page.locator('.lamp').nth(0).locator('.lamp-edit').click()
    assert page.locator('#tab-effect').get_attribute('aria-selected') == 'true'
    assert page.locator('#targets .target', has_text='127.0.0.1:8765').get_attribute('aria-pressed') == 'true'
    page.locator('.choice-tile', has_text='Fire').click()
    wait_config(page, A, 'color_effect', 2)
    assert config(page, B, 'color_effect') == 4

    if stored:
        page.wait_for_timeout(500)
        page.reload()
        page.wait_for_function('STATE.ready', timeout=15000)
        page.evaluate(FAKES)
        page.locator('#tab-lamps').click()
        page.locator('#lamps-connect').click()
        page.wait_for_function('REMOTE.devices.every(d=>d.status==="ready")', timeout=10000)
        state = page.evaluate(f"({{target:TARGET,color:$('color').value,palette:$('palette').value,name:lampName(REMOTE.devices[1]),"
                              f"bands:LAMP_PROFILES[{B!r}].bands,own:LAMP_PROFILES[{A!r}].overrides}})")
        assert state == {'target': A, 'color': '2', 'palette': '49', 'name': 'Ceiling', 'bands': '64', 'own': {'color': 2}}, state
        print('PASS lamp profiles, names and the edited lamp remembered across a reload')

    # Removing the edited lamp goes back to All lamps.
    page.locator('#tab-lamps').click()
    page.locator('.lamp').nth(0).locator('.lamp-more-toggle').click()
    page.locator('.lamp').nth(0).locator('.lamp-remove').click()
    page.wait_for_function("TARGET==='all' && REMOTE.devices.length===1")
    assert page.evaluate("$('color').value") == '4'
    if stored:
        page.evaluate('localStorage.clear()')
    print('PASS removing the edited lamp returns to All lamps')

    assert not errors, errors
    print('PASS no page errors')
    browser.close()
