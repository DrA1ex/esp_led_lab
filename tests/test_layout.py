"""Responsive layout and playback-level smoke test (Chromium/Playwright)."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'dist' / 'standalone.html').read_text()

RECT = '''el => {const b = document.querySelector(el).getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom}}'''

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
        top = page.evaluate(f'''() => {{
          const r = {RECT};
          return {{document:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,
            stage:r('.matrixstage'),info:r('.preview-info'),main:r('.main'),library:r('.library'),transport:r('.transport'),remote:r('.remote-panel'),
            workspace:r('.workspace'),settings:r('.settings'),panels:r('.tabpanels')}};
        }}''')
        assert top['document'] <= width + 1, (width, 'horizontal overflow',top)
        if width >= 1200:
            # One viewport tall: the page itself does not scroll.
            assert top['scrollHeight'] <= height + 1, (width,'page taller than the viewport',top)
            assert top['settings']['bottom'] <= height and top['remote']['bottom'] <= height + 1, (width,'column past the viewport',top)
            # The lamps card fills the column under the preview.
            assert abs(top['remote']['bottom']-top['workspace']['bottom']) < 2, (width,'lamps card does not reach the bottom',top)
            # A matrix sits beside its readout and fits the height budget.
            assert top['info']['x'] >= top['stage']['x']+top['stage']['width'], (width,'readout not beside the matrix',top)
            assert 160 <= top['stage']['height'] <= min(390, height*0.45), (width,'matrix size',top)
            # Three columns: playlist | preview over lamps | settings; the transport sits in the header.
            assert top['library']['x']+top['library']['width'] <= top['main']['x'] < top['settings']['x'], (width,'not three columns',top)
            assert abs(top['main']['x']-top['remote']['x']) < 2 and top['remote']['y'] > top['main']['y'], (width,'lamps not under the preview',top)
            assert top['transport']['bottom'] <= top['main']['y'] and top['transport']['height'] < 70, (width,'transport not in the header',top)
            assert abs(top['library']['bottom']-top['remote']['bottom']) < 2, (width,'playlist column does not reach the bottom',top)
        else:
            assert top['stage']['width'] <= 362, (width,'oversized matrix',top)
            # Stacked: transport row, then preview → playlist → lamps → settings.
            assert top['transport']['bottom'] <= top['main']['y'] < top['library']['y'] < top['remote']['y'] < top['settings']['y'], (width,'stacked order',top)
        if width >= 1200:
            # Scrolling a long settings panel keeps the tabs in place and the page still.
            page.locator('.tabs [data-tab="audio"]').click()
            page.locator('#audio-mode').select_option('14')
            tabs_before = page.evaluate("document.querySelector('.tabs').getBoundingClientRect().top")
            page.mouse.move(top['panels']['x']+40, top['panels']['y']+60)
            page.mouse.wheel(0, 900)
            page.wait_for_timeout(300)
            state = page.evaluate('''() => ({tabs:document.querySelector('.tabs').getBoundingClientRect().top,
               panel:document.querySelector('.tabpanels').scrollTop,
               panelScrollable:document.querySelector('.tabpanels').scrollHeight>document.querySelector('.tabpanels').clientHeight,
               page:window.scrollY, dock:!document.getElementById('floating-preview').hidden})''')
            assert state['page'] == 0 and abs(state['tabs']-tabs_before) < 1 and not state['dock'], (width,state)
            assert state['panel'] > 0 or not state['panelScrollable'], (width,'settings panel did not scroll',state)
            # Advanced lamp settings scroll inside the lamps card.
            page.locator('#remote-panel summary').click()
            page.wait_for_timeout(100)
            assert page.evaluate("document.documentElement.scrollHeight") <= height + 1, (width,'advanced lamps grew the page')
            assert page.evaluate("document.querySelector('#remote-add').getBoundingClientRect().top < innerHeight"),(width,'connection control hidden')
        else:
            page.evaluate('window.scrollTo(0, 900)')
            page.wait_for_timeout(300)
            state = {'dock': page.evaluate("!document.getElementById('floating-preview').hidden")}
            assert state['dock'],(width,state)
        assert not errors,(width,errors)
        if width in (1600,1280,860,420):
            page.screenshot(path=str(ROOT/'tests'/f'layout_{width}.png'),full_page=False)
        print('PASS', width, 'matrix',round(top['stage']['width']), 'px', state)
        page.close()
    browser.close()
