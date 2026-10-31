"""Interface components in Chromium: choices bound to the hidden selects, palette swatches and
effect thumbnails from the second renderer, two-thumb ranges, tabs and hotkeys, the LED layout
menu with picking the start on a strip, the Analyzer tab's DSP view, and settings remembered in
the browser.
Run: python tests/test_ui.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STANDALONE = ROOT / 'dist' / 'standalone.html'
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=os.environ.get('CHROMIUM') or None,
                                args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    page.on('pageerror', lambda e: errors.append(str(e)))
    # A file:// page has localStorage (needed for the remembered settings below).
    try:
        page.goto(STANDALONE.as_uri())
        stored = True
    except Exception as err:  # some sandboxes block file navigation
        print('NOTE file:// navigation unavailable, skipping remembered settings:', err)
        page.set_content(STANDALONE.read_text())
        stored = False
    page.wait_for_function('STATE.ready', timeout=15000)

    # Choices: one radio per option, grouped; picking one drives the select and the renderer.
    assert page.locator('[name="choice-audio-mode"]').count() == page.locator('#audio-mode option').count() == 36
    assert page.locator('#audio-mode-hint').inner_text() == 'Audio does not affect the picture.'
    page.locator('#tab-reaction').click()
    page.locator('.choices[data-for="audio-mode"] label', has_text='Fire').click()
    assert page.evaluate("$('audio-mode').value==='21' && settings()['audio-mode']===21")
    assert 'every column is a flame fed by its band' in page.locator('#audio-mode-hint').inner_text()
    assert page.locator('#viz-speed').is_visible() and page.locator('[data-for="param-source"]').is_visible()
    assert page.locator('#viz-decay').is_hidden(), 'Fire has no fall-off: its height and intensity parameters set it'
    # A section with no field for the mode disappears (Spectrum Bars has no signal settings).
    page.locator('.choices[data-for="audio-mode"] label', has_text='Spectrum Bars').click()
    assert page.locator('#signal-title').is_hidden() and page.locator('#viz-decay').is_visible()
    # Selects changed by code show up in the choices.
    page.evaluate("$('param-source').value='bass';$('audio-mode').value='8';refreshLabels()")
    assert page.locator('[name="choice-param-source"][value="bass"]').is_checked()
    assert page.locator('#control-visual').is_visible()
    # Arrow keys move between the radios of a group.
    page.locator('#tab-effect').click()
    page.locator('[name="choice-brightness"][value="0"]').focus()
    page.keyboard.press('ArrowRight')
    assert page.evaluate("$('brightness').value") == '1'
    print('PASS choices: grouped radios, select + renderer in sync both ways, auto-hidden sections, arrow keys')

    # Palette swatches are the real palettes; the filter narrows them.
    grads = page.evaluate("[...document.querySelectorAll('.sw-grad')].map(e=>e.style.background)")
    assert len(grads) == 79 and all('linear-gradient' in g for g in grads) and len(set(grads)) > 70
    page.locator('#palette-search').fill('oce')
    visible = page.evaluate("[...document.querySelectorAll('.choice-swatch')].filter(e=>!e.classList.contains('filtered')).map(e=>e.textContent)")
    assert visible == ['Ocean', 'Oceanic'], visible
    page.locator('.choice-swatch', has_text='Oceanic').click()
    assert page.evaluate("$('palette').value") == '50' and page.locator('#palette-name').inner_text() == 'Oceanic'
    page.locator('#palette-search').fill('')
    # Effect thumbnails are rendered and follow the palette.
    lit = '''() => [...document.querySelectorAll('.choice-tile canvas')].map(c => {
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let s=0;for(let i=0;i<d.length;i+=4)s+=d[i]+d[i+1]+d[i+2];return s;})'''
    page.wait_for_timeout(400)
    before = page.evaluate(lit)
    assert len(before) == 10 and sum(v > 50000 for v in before) >= 8, before
    page.locator('.choice-swatch', has_text='Flames').click()
    page.wait_for_timeout(400)
    after = page.evaluate(lit)
    assert sum(a != b for a, b in zip(before, after)) >= 7, (before, after)
    print('PASS 79 palette swatches with filter, effect thumbnails rendered and following the palette')

    # Two-thumb ranges keep their order; the track fill follows both thumbs.
    page.locator('#tab-reaction').click()
    page.locator('.choices[data-for="audio-mode"] label', has_text='Spectrum Center').click()
    page.locator('#input-max').fill('100')
    page.locator('#input-min').focus()
    page.keyboard.press('End')
    assert page.evaluate("+$('input-min').value") == 99 and page.evaluate("+$('input-max').value") == 100
    page.locator('#audio-min').fill('200')
    page.locator('#audio-max').fill('120')
    assert page.evaluate("[+$('audio-min').value,+$('audio-max').value]") == [120, 120]
    fill = page.evaluate("getComputedStyle($('input-min').parentElement).getPropertyValue('--b').trim()")
    assert abs(float(fill) - 100 / 255) < .01, fill
    page.locator('#range-reset').click()
    assert page.evaluate("[+$('input-min').value,+$('input-max').value,+$('audio-min').value,+$('audio-max').value]") == [0, 255, 0, 255]
    print('PASS two-thumb ranges: signal window stays open, reaction from <= to, fill, reset')

    # Tabs: number keys and arrow keys.
    page.locator('body').click(position={'x': 5, 'y': 880})
    page.keyboard.press('4')
    assert page.locator('#tab-lamps').get_attribute('aria-selected') == 'true' and page.locator('#remote-address').is_visible()
    page.locator('#tab-lamps').focus()
    page.keyboard.press('ArrowRight')
    assert page.locator('#tab-analyzer').get_attribute('aria-selected') == 'true'
    page.keyboard.press('Home')
    assert page.locator('#tab-effect').get_attribute('aria-selected') == 'true', 'Music is not a tab on wide screens'
    page.locator('#lamp-chip').click()
    assert page.locator('#tab-lamps').get_attribute('aria-selected') == 'true'
    print('PASS tabs: 1-5 hotkeys, arrows / Home, lamps pill opens Lamps')

    # LED layout menu → a strip; a click on an LED moves the start there.
    page.locator('#tab-reaction').click()
    page.locator('.choices[data-for="audio-mode"] label', has_text='Line').first.click()
    assert page.evaluate("$('audio-mode').value") == '6'
    page.locator('#geometry-button').click()
    page.locator('#geometry-menu label', has_text='153 · ceiling').click()
    page.keyboard.press('Escape')
    page.wait_for_function("document.body.classList.contains('strip-layout') && STATE.stripLayout && STATE.modules.new.exports.get_width()===153")
    assert page.locator('#matrix-label').inner_text() == '153 LED · strip'
    target = page.evaluate('''() => {const L=STATE.stripLayout,k=20,r=$('canvas-new').getBoundingClientRect(),s=r.width/L.width;
        return {x:r.left+L.cx[k]*s,y:r.top+L.cy[k]*s}}''')
    assert page.evaluate('STATE.stripLayout.cy.every(v=>v===STATE.stripLayout.cy[0])'), 'a 1-row strip is drawn on one line'
    page.mouse.click(target['x'], target['y'])
    assert page.evaluate("+$('origin-shift').value") == 20
    assert 'LED 21 of 153' in page.locator('#origin-hint').inner_text()
    # A closed strip (Ring) is drawn round a rectangle; a click still picks its LED.
    page.evaluate("$('origin-ring').checked=true;$('origin-shift').value=0;refreshLabels()")
    page.wait_for_function('STATE.stripLayout.ring && STATE.stripLayout.height > 100')
    target = page.evaluate('''() => {const L=STATE.stripLayout,k=70,r=$('canvas-new').getBoundingClientRect(),s=r.width/L.width;
        return {x:r.left+L.cx[k]*s,y:r.top+L.cy[k]*s}}''')
    page.mouse.click(target['x'], target['y'])
    assert page.evaluate("+$('origin-shift').value") == 70
    page.evaluate("$('origin-ring').checked=false;refreshLabels()")
    print('PASS LED layout menu, a strip on one line, a closed strip round a rectangle, click-to-start on both')

    # Analyzer tab: the stage switches to the DSP view; touching a control opens its panel.
    page.locator('#tab-analyzer').click()
    assert page.locator('#stage-mode').is_visible()
    page.locator('#stage-mode label', has_text='DSP').click()
    assert page.evaluate("document.body.classList.contains('dsp-stage')") and page.locator('#dsp-canvas').is_visible()
    assert page.locator('#canvas-new').is_hidden()
    page.locator('#attack').focus()
    assert page.locator('[data-dsp="envelope"]').get_attribute('aria-selected') == 'true' and page.locator('#dsp-groups').is_visible()
    page.locator('#noise').focus()
    assert page.locator('[data-dsp="noise"]').get_attribute('aria-selected') == 'true' and page.locator('#dsp-groups').is_hidden()
    page.locator('[data-dsp="level"]').click()
    page.wait_for_timeout(400)
    assert 'Sensitivity' in page.locator('#dsp-caption').inner_text()
    drawn = page.evaluate("(()=>{const c=$('dsp-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n/(c.width*c.height);})()")
    assert drawn > .01, drawn
    page.locator('#stage-mode label', has_text='LEDs').click()
    assert page.locator('#canvas-new').is_visible() and page.locator('#dsp-view').is_hidden()
    page.locator('#stage-mode label', has_text='DSP').click()
    page.locator('#tab-effect').click()
    assert page.locator('#stage-mode').is_hidden() and page.locator('#canvas-new').is_visible()
    print('PASS DSP view: stage switch on the Analyzer tab, panel follows the touched control, curve drawn')

    # Views across settings stay while tuning; A/B runs the pinned settings on the same audio.
    page.locator('#tab-analyzer').click()
    page.locator('[data-dsp="chain"]').click()
    page.locator('#attack').focus()
    assert page.locator('[data-dsp="chain"]').get_attribute('aria-selected') == 'true' and page.locator('#dsp-groups').is_visible()
    page.locator('[data-dsp="map"]').click()
    page.locator('[data-dsp="ab"]').click()
    assert page.locator('#dsp-pin').is_visible() and page.locator('#dsp-unpin').is_hidden()
    page.locator('#empty-demo').click()
    page.wait_for_function('STATE.playing && DSP_HIST.filled > 60', timeout=10000)
    page.locator('#dsp-pin').click()
    page.wait_for_timeout(1000)
    same = "(()=>{const H=DSP_HIST,n=40;let d=0;for(let j=H.filled-n;j<H.filled;j++)for(let g=0;g<3;g++)d=Math.max(d,Math.abs(histAt(H.output[g],j)-histAt(H.abOutput[g],j)));return d;})()"
    assert page.evaluate(same) < 1e-6, page.evaluate(same)
    page.evaluate("$('release').value=700;$('release').dispatchEvent(new Event('input',{bubbles:true}))")
    page.wait_for_timeout(1200)
    assert page.evaluate(same) > .02, page.evaluate(same)
    assert page.locator('[data-dsp="ab"]').get_attribute('aria-selected') == 'true'
    assert page.evaluate("abDiffs(settings())") == ['Release 210 ms → 700 ms']
    page.locator('#dsp-unpin').click()
    assert page.evaluate('DSP.ab') is None
    page.locator('#play').click()
    page.evaluate("resetControls(['release']);refreshLabels()")
    print('PASS DSP views: Chain / Map stay while tuning, A/B matches until a setting changes, then differs')

    # Bands, Tempo, Spectrogram and Notes draw; their controls open them; the Onsets section's
    # group buttons pick the DSP group and show that group's settings.
    for panel in ['bands', 'tempo', 'spectrogram', 'notes']:
        page.locator(f'[data-dsp="{panel}"]').click()
        page.wait_for_timeout(300)
        assert page.evaluate("DSP.panel") == panel
        assert page.evaluate("(()=>{const c=$('dsp-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n/(c.width*c.height);})()") > .01, panel
    # The demo's notes reached the chroma history and the caption explains it.
    assert page.evaluate('Math.max(...DSP_HIST.chroma)') > .5
    assert 'pitch class' in page.locator('#dsp-caption').inner_text()
    page.locator('[data-dsp="level"]').click()
    for control, panel in [('tilt', 'bands'), ('eq-high', 'bands'), ('smoothing', 'bands'), ('bpm-min', 'tempo'), ('holdoff-0', 'onsets'),
                           ('onset-memory', 'onsets'), ('peak-hold', 'envelope'), ('window', 'resolution')]:
        page.locator(f'#{control}').focus()
        assert page.evaluate('DSP.panel') == panel, (control, page.evaluate('DSP.panel'))
    page.locator('#onset-groups button', has_text='High').click()
    assert page.evaluate('DSP.group') == 2 and page.locator('#dsp-groups [data-group="2"]').get_attribute('aria-pressed') == 'true'
    assert page.locator('#onset-trim-2').is_visible() and page.locator('#onset-trim-0').is_hidden()
    assert 'Bass: 1.0×, hold-off 160 ms' in page.locator('#onset-summary').inner_text()
    page.wait_for_timeout(300)
    assert 'High threshold' in page.locator('#dsp-caption').inner_text()
    # Groups keep a band each; the tempo range stays 10 BPM wide; negative compression expands.
    page.evaluate("for(const [id,v] of [['split-mid',15],['bpm-max',60]]){$(id).value=v;$(id).dispatchEvent(new Event('input',{bubbles:true}));}")
    assert page.evaluate("[+$('split-mid').value,+$('split-high').value,+$('bpm-min').value,+$('bpm-max').value]") == [14, 15, 50, 60]
    assert page.locator('#groups-value').inner_text() == '14 · 1 · 1 bands'
    page.evaluate("$('compression').value=-40;$('compression').dispatchEvent(new Event('input',{bubbles:true}))")
    assert page.locator('#compression-value').inner_text() == '−40% · expands'
    page.evaluate('pinCompare()')
    page.evaluate("$('tilt').value=6;$('tilt').dispatchEvent(new Event('input',{bubbles:true}))")
    assert page.evaluate('abDiffs(settings())') == ['Tilt 0 dB/oct → 3 dB/oct']
    page.evaluate('clearCompare()')
    # The window's leakage is on the Resolution panel and in its caption; peak hold reads "off" at 0.
    page.evaluate("$('window').value=2;$('window').dispatchEvent(new Event('change',{bubbles:true}))")
    page.locator('#window').focus()
    page.wait_for_timeout(300)
    assert 'Blackman-Harris' in page.locator('#dsp-caption').inner_text() and '−92 dB' in page.locator('#dsp-caption').inner_text(), page.locator('#dsp-caption').inner_text()
    assert page.locator('#peak-hold-value').inner_text() == 'off'
    page.evaluate("for(const [id,v] of [['eq-bass',-6],['peak-hold',120]]){$(id).value=v;$(id).dispatchEvent(new Event('input',{bubbles:true}));}")
    assert page.locator('#peak-hold-value').inner_text() == '120 ms'
    page.locator('#defaults').click()
    assert page.evaluate("['tilt','split-mid','split-high','bpm-min','bpm-max','compression','holdoff-0','window','eq-bass','peak-hold','onset-memory','smoothing'].map(id=>+$(id).value)") == [0, 5, 12, 65, 180, 82, 160, 0, 0, 0, 7, 0]
    print('PASS Bands / Tempo / Spectrogram views, per-group onset settings, group and tempo ranges, expansion, analyzer reset')

    if stored:
        # Remembered: effect, mode, layout, volume; the music column state. Reset all forgets them.
        page.evaluate("$('speed').value=40;$('speed').dispatchEvent(new Event('input',{bubbles:true}))")
        page.locator('#playback-volume').fill('30')
        page.locator('#library-toggle').click()
        page.wait_for_timeout(500)
        page.reload()
        page.wait_for_function('STATE.ready', timeout=15000)
        state = page.evaluate("({p:$('palette').value,m:$('audio-mode').value,g:$('geometry').value,s:$('speed').value,v:$('playback-volume').value,"
                              "checked:document.querySelector('[name=choice-palette]:checked')?.value,collapsed:document.body.classList.contains('library-collapsed'),"
                              "w:STATE.modules.new.exports.get_width()})")
        assert state == {'p': '26', 'm': '6', 'g': '153x1', 's': '40', 'v': '30', 'checked': '26', 'collapsed': True, 'w': 153}, state
        page.locator('#library-toggle').click()
        page.locator('#help-button').click()
        page.locator('#reset-all').click()
        assert page.evaluate("[$('palette').value,$('audio-mode').value,$('geometry').value,$('speed').value,$('playback-volume').value]") == ['4', '0', '16x16', '82', '100']
        page.reload()
        page.wait_for_function('STATE.ready', timeout=15000)
        assert page.evaluate("[$('palette').value,$('geometry').value,STATE.modules.new.exports.get_width()]") == ['4', '16x16', 16]
        page.evaluate('localStorage.clear()')
        print('PASS remembered settings and music column, Reset all settings')

    assert not errors, errors
    print('PASS no page errors')
    browser.close()
