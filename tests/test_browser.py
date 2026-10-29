"""Optional interactive smoke test: python tests/test_browser.py (requires playwright + Chromium).
Validates live standalone HTML, WASM initialization, the fixed-height desktop workspace and
compact scrolling preview on small screens. No network access is required.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'dist'/'standalone.html').read_text()
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox'])
    for width,height in [(1280,720),(860,720),(420,740)]:
        page=browser.new_page(viewport={'width':width,'height':height})
        errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.set_content(HTML,wait_until='load')
        page.wait_for_function('STATE.ready === true',timeout=15000)
        page.locator('#demo').click()
        page.locator('#audio-mode').select_option('3',force=True)
        page.evaluate('window.scrollTo(0,800)')
        page.wait_for_timeout(350)
        status=page.evaluate('''() => ({top:document.querySelector('.workspace-grid').getBoundingClientRect().top,scrollY:window.scrollY,
            dock:!document.getElementById('floating-preview').hidden,
            ready:STATE.ready,
            hasPixels:(()=>{let c=document.querySelector('#canvas-new');let a=c.getContext('2d').getImageData(0,0,c.width,c.height).data;return a.some((v,i)=>i%4!==3&&v>0)})()})''')
        assert status['ready'] and status['hasPixels'] and not errors,(width,status,errors)
        if width>=1200:
            assert status['scrollY']==0 and 0<=status['top']<=120 and not status['dock'],(width,status)
        else:
            assert status['dock'],(width,status)
        page.locator('#audio-mode').select_option('4',force=True)
        page.wait_for_timeout(160)
        print('PASS browser',width,height,status)
        page.close()
    browser.close()
