"""Check user's exact demo workflow and time-varying control in real Chromium."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 page=browser.new_page(viewport={'width':1360,'height':900})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content((ROOT/'dist'/'standalone.html').read_text());page.wait_for_function('STATE.ready === true')
 page.locator('#sources-button').click();page.locator('#demo').click()
 page.locator('#color').select_option('0',force=True)
 page.locator('#audio-mode').select_option('8',force=True)
 page.locator('#param-source').select_option('loudness',force=True)
 speeds=[]
 for i in range(24):
  page.wait_for_timeout(95)
  row=page.evaluate('''() => ({
    v: newControlSource(),
    label:document.getElementById('control-value-label').textContent,
    newSpeed:Math.floor(transferValue(newControlSource(),settings()))
  })''')
  speeds.append(row)
 assert any('Speed:' in r['label'] for r in speeds),speeds[-1]
 vmax=max(x['newSpeed'] for x in speeds);vmin=min(x['newSpeed'] for x in speeds)
 assert vmax-vmin>12, f'Speed should react to 120 BPM demo, got {vmin}..{vmax}'
 page.locator('#param-source').select_option('high',force=True)
 page.wait_for_timeout(200)
 assert 'Treble' in page.locator('#control-source-label').inner_text()
 print('PASS browser: real demo -> RMS -> effective Speed dynamic',vmin,'..',vmax,'and selectable High source')
 page.locator('#color').select_option('9',force=True)
 page.locator('#param-source').select_option('loudness',force=True)
 page.locator('#audio-mode').select_option('6',force=True)
 widths=[]
 for i in range(26):
  page.wait_for_timeout(95)
  widths.append(page.evaluate('''() => {
    let m=STATE.modules.new.exports;
    let rgba=new Uint8Array(m.memory.buffer,m.framebuffer_ptr(),16*16*4);
    // In solid-color mode, Line maps directly to the number of lit columns.
    let active=0;
    for(let x=0;x<16;x++){
      let i=(((0&1)?15-x:x)+0*16)*4;
      if(rgba[i]+rgba[i+1]+rgba[i+2]>0)active++;
    }
    return active;
  }'''))
 assert max(widths)-min(widths)>=2, f'Line should react to 120 BPM demo, got {widths}'
 print('PASS browser: new Line actually changes active columns during demo',min(widths),'..',max(widths))
 page.locator('#audio-mode').select_option('3',force=True)
 assert page.locator('#spectrum-shape').input_value()=='70'
 assert page.locator('#spectrum-onset').input_value()=='30'
 assert not errors, errors
 browser.close()
