"""Responsive layout and playback-level smoke test (Chromium/Playwright).
Wide (>= 1180 px): music | stage | inspector above the player bar, exactly one viewport tall.
Medium: stage | inspector, the music list becomes the Music tab. Phones: the stage is pinned
on top, the tabs stick under it and the player bar is fixed at the bottom.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / 'dist' / 'standalone.html').read_text()

RECT = '''el => {const b = document.querySelector(el).getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom,right:b.right}}'''
MEASURE = f'''() => {{
  const r = {RECT};
  return {{document:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,scrollY:window.scrollY,
    stage:r('#stage'),view:r('.stage-view'),frame:r('.matrixstage'),library:r('#library'),inspector:r('#inspector'),
    player:r('#transport'),tabs:r('.tabs'),panels:r('.tabpanels'),header:r('.topbar')}};
}}'''

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None, args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    for width, height in [(1600, 900), (1280, 720), (1200, 650), (1060, 720), (860, 720), (650, 800), (420, 740), (360, 740)]:
        page = browser.new_page(viewport={'width': width, 'height': height}, device_scale_factor=1)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(HTML, wait_until='load')
        page.wait_for_function('STATE.ready === true', timeout=15000)
        # Wide: the music column; otherwise the Music tab, which a first visit opens.
        page.locator('#sources-button').click();page.locator('#demo').click()
        page.wait_for_function('STATE.playing', timeout=10000)
        # Volume: inline in the player on wide screens, a popover otherwise.
        if not page.locator('#playback-volume').is_visible():
            page.locator('#volume-button').click()
        page.locator('#playback-volume').fill('35')
        page.wait_for_function('Math.abs(STATE.playbackGain.gain.value-.35) < .03', timeout=2000)
        page.keyboard.press('Escape')
        # Preview-only strength sits in the View menu of the stage, which opens inside the window.
        page.locator('#view-button').click()
        page.locator('#mix').fill('50')
        assert page.locator('#mix-value').inner_text() == '50%'
        pop = page.evaluate(RECT, '#view-menu')
        assert pop['x'] >= 0 and pop['right'] <= width + 1 and pop['y'] >= 0 and pop['bottom'] <= height + 1, (width, 'view menu off screen', pop)
        page.keyboard.press('Escape')
        assert not page.locator('#view-menu').is_visible()
        top = page.evaluate(MEASURE)
        assert top['document'] <= width + 1, (width, 'horizontal overflow', top)
        if width >= 1180:
            assert top['scrollHeight'] <= height + 1, (width, 'page taller than the viewport', top)
            # Three columns over the player bar, all reaching it.
            assert top['library']['right'] <= top['stage']['x'] < top['inspector']['x'], (width, 'not three columns', top)
            assert abs(top['player']['bottom'] - height) < 1, (width, 'player not at the bottom', top)
            for col in ('stage', 'inspector'):
                assert abs(top[col]['bottom'] - top['stage']['bottom']) < 2 and top[col]['bottom'] <= top['player']['y'] + 1, (width, col, top)
            # The matrix fills the stage (square: limited by the smaller side).
            assert top['frame']['height'] >= min(top['view']['width'], top['view']['height']) - 30, (width, 'matrix too small', top)
            # Hiding the music column widens the stage; showing it brings it back.
            stage_width = top['stage']['width']
            page.locator('#library-toggle').click()
            page.wait_for_timeout(100)
            assert not page.locator('#library').is_visible() and page.evaluate(RECT, '#stage')['width'] > stage_width + 200
            page.locator('#library-toggle').click()
            page.wait_for_timeout(100)
            assert page.locator('#library').is_visible()
        elif width >= 760:
            assert top['scrollHeight'] <= height + 1, (width, 'page taller than the viewport', top)
            # Stage | inspector; the music list lives in the Music tab.
            assert top['stage']['right'] <= top['inspector']['x'], (width, 'not two columns', top)
            assert page.evaluate("document.getElementById('panel-music').contains(document.getElementById('library'))")
            assert page.locator('#tab-music').is_visible()
        else:
            assert top['stage']['y'] >= top['header']['bottom'] - 1, (width, 'stage over the header', top)
            assert top['frame']['width'] <= width - 100, (width, 'phone matrix leaves no room for the analyzer', top)
        if width >= 760:
            # Scrolling a long settings panel keeps the tabs in place and the page still.
            page.locator('#tab-reaction').click()
            page.locator('#audio-mode').select_option('14', force=True)
            tabs_before = page.evaluate(RECT, '.tabs')['y']
            panels = page.evaluate(RECT, '.tabpanels')
            page.mouse.move(panels['x'] + 40, panels['y'] + 60)
            page.mouse.wheel(0, 900)
            page.wait_for_timeout(300)
            state = page.evaluate('''() => ({tabs:document.querySelector('.tabs').getBoundingClientRect().y,
               panel:document.querySelector('.tabpanels').scrollTop,
               scrollable:document.querySelector('.tabpanels').scrollHeight>document.querySelector('.tabpanels').clientHeight,
               page:window.scrollY})''')
            assert state['page'] == 0 and abs(state['tabs'] - tabs_before) < 1, (width, state)
            assert state['panel'] > 0 or not state['scrollable'], (width, 'settings panel did not scroll', state)
        else:
            # Phones: the page scrolls, the stage stays pinned with the tabs right under it.
            page.locator('#tab-reaction').click()
            page.evaluate('window.scrollTo(0, 900)')
            page.wait_for_timeout(300)
            state = page.evaluate(MEASURE)
            assert state['scrollY'] > 0 and abs(state['stage']['y']) < 1, (width, 'stage not pinned', state)
            assert abs(state['tabs']['y'] - state['stage']['bottom']) < 2, (width, 'tabs not under the stage', state)
            assert abs(state['player']['bottom'] - height) < 1, (width, 'player not fixed at the bottom', state)
        assert not errors, (width, errors)
        if width in (1600, 1280, 860, 420):
            page.screenshot(path=str(ROOT / 'tests' / f'layout_{width}.png'), full_page=False)
        print('PASS', width, 'matrix', round(top['frame']['width']), 'px')
        page.close()
    browser.close()
