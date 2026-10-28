"""Responsive layout and playback-level smoke test (Chromium/Playwright)."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'dist' / 'standalone.html').read_text()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    for width, height in [(1600, 900), (1280, 720), (1200, 650), (1060, 720), (860, 720), (650, 800), (420, 740), (360, 740)]:
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(HTML, wait_until='load')
        page.wait_for_function('STATE.ready === true', timeout=15000)
        page.locator('#demo').click()
        page.wait_for_function('STATE.playing', timeout=10000)
        page.locator('#playback-volume').fill('35')
        page.locator('#mix').fill('50')
        page.wait_for_function('Math.abs(STATE.playbackGain.gain.value-.35) < .03', timeout=2000)
        assert page.locator('#mix-value').inner_text()=='50%'
        top = page.evaluate('''() => {
          let r = el => {const b = document.querySelector(el).getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom}};
          return {document:document.documentElement.scrollWidth,stage:r('.matrixstage'),main:r('.main'),player:r('.audio-card'),remote:r('.remote-panel'),workspace:r('.workspace-sticky'),body:document.documentElement.clientWidth};
        }''')
        assert top['document'] <= width + 1, (width, 'horizontal overflow',top)
        assert top['stage']['width'] <= 232, (width,'oversized matrix',top)
        if width >= 1200:
            assert abs(top['main']['x']-top['player']['x'])>50, (width,'not side by side',top)
            assert top['player']['y']-top['main']['y'] < 12, (width,'player not alongside preview',top)
        if width <=760:
            assert top['player']['y'] > top['main']['y'],(width,'small mobile not stacked',top)
        page.evaluate('window.scrollTo(0, 900)')
        page.wait_for_timeout(300)
        state = page.evaluate('''() => {
          const r=document.querySelector('.workspace-sticky').getBoundingClientRect();
          return {top:r.top, dock: !document.getElementById('floating-preview').hidden,
             sticky:getComputedStyle(document.querySelector('.workspace-sticky')).position,
             audio:document.querySelector('.audio-card').getBoundingClientRect().top,
             viewport:innerHeight};
        }''')
        if width >= 1200:
            assert state['sticky']=='sticky' and not state['dock'],(width,state)
            assert -2<=state['top']<=16,(width,state)
            assert state['audio']<height,(width,'player out of viewport',state)
            assert page.evaluate("document.querySelector('#remote-add').getBoundingClientRect().top < innerHeight"),(width,'connection control hidden')
        else:
            assert state['dock'],(width,state)
        assert not errors,(width,errors)
        if width in (1280,860,420):
            page.screenshot(path=str(ROOT/'tests'/f'layout_{width}.png'),full_page=False)
        print('PASS', width, 'preview',round(top['stage']['width']), 'px',state)
        page.close()
    browser.close()
