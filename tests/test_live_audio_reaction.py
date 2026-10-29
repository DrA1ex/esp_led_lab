"""End-to-end reproduction test of the reported no-reaction regression.

Uses a real Chromium, the bundled standalone HTML, generated 120-BPM demo,
actual PCM -> WASM DSP -> WASM render framebuffer path. The Solid/Fixed
combination isolates audio from unrelated color animations during comparison.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width':1280,'height':800})
    errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.set_content((ROOT/'dist'/'standalone.html').read_text(),wait_until='load')
    page.wait_for_function('STATE.ready === true')
    # An untouched page renders the original effect, not a silent Spectrum mask.
    assert page.locator('#audio-mode').input_value() == '0'
    page.locator('#demo').click()
    page.wait_for_function('STATE.newParam > 0.15',timeout=10000)
    page.wait_for_timeout(450)
    assert page.locator('#audio-mode').input_value() == '3'
    measurements=page.evaluate('''() => ({
      playing:STATE.playing, pcm:STATE.pcm.length,
      newParam:STATE.newParam,newBands:STATE.newSpectrum.slice(),
      newMini:[...document.getElementById('new-mini-bars').children].map(e=>e.style.height)
    })''')
    assert measurements['playing'] and measurements['pcm']==16000*16
    assert any(v>0.04 for v in measurements['newBands'])
    assert max(measurements['newBands'])<.999, 'new FFT clipped all the way to 100%'
    assert any(float(v.rstrip('%'))>4 for v in measurements['newMini'])
    assert not errors,errors
    print('PASS browser: demo -> PCM -> FFT, mini spectrum populated',measurements['newParam'])
    # Compare each original effect against Off at the SAME instant and same base.
    # Solid is intentionally chosen to remove unrelated animation from the test.
    page.locator('#color').select_option('9',force=True)
    page.locator('#brightness').select_option('0',force=True)
    page.locator('#speed').fill('40');page.locator('#scale').fill('190');page.locator('#light').fill('215')
    statuses=page.evaluate('''() => {
      const e=document.getElementById('audio-mode'), sides=['new'];
      function snapshot(mode,side) {
        e.value=''+mode;refreshLabels();
        const m=STATE.modules[side].exports;
        feedRender(m);m.render_frame(16.667);
        return Array.from(new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),16*16*4));
      }
      const off=Object.fromEntries(sides.map(side=>[side,snapshot(0,side)]));
      return Array.from({length:10},(_,i)=>i+1).map(mode=>({mode,
        changed:sides.map(side=>{
          const a=snapshot(mode,side),b=off[side];
          return a.some((v,j)=>j%4!==3 && v!==b[j]);
        })}));
    }''')
    print('Original modes vs Off:',statuses)
    assert all(all(x['changed']) for x in statuses), 'one of the firmware audio modes did not modify the solid reference'
    # Light Control really has no effect on Plasma+Fixed: report the original
    # limitation rather than silently pretending the user selected a working mode.
    page.locator('#color').select_option('4',force=True)
    page.locator('#audio-mode').select_option('10',force=True)
    assert 'has no effect on this preset' in page.locator('#control-hint').inner_text()
    assert not errors,errors
    print('PASS browser: all 10 firmware modes alter WASM RGB on demo, no swallowed signal; incompatible preset warning')
    # Demo repeats rather than freezing in the last frame.
    page.evaluate('''() => {STATE.lastPlaybackSample=255500;STATE.playStart=STATE.context.currentTime-0.03;}''')
    page.wait_for_timeout(90)
    assert page.evaluate('STATE.playing && STATE.loopDemo && STATE.nextSample < 10000')
    print('PASS browser: demo loop boundary resets DSP and keeps playing')
    browser.close()
