"""Library loader in Chromium: a slow folder of the last visit is listed with
the loader (counts grow, the empty-library hint stays hidden), Cancel keeps
the list as it was and offers "Reopen", and a folder from the directory picker
shows the same loader. The folder is an in-page fake directory handle: a few
hundred tracks in subfolders, every entry a little late like a slow disk.
Run: python tests/test_loader_browser.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
errors=[]
# fakeFolder(name, folders, tracks per folder, ms per entry): a handle like the
# directory picker's; the file handles are never read (nothing plays here).
FAKE='''() => {
  const file=name=>({kind:'file',name,getFile:async()=>new File([new Uint8Array(8)],name)});
  const dir=(name,children,delay)=>({kind:'directory',name,
    queryPermission:async()=>'granted',requestPermission:async()=>'granted',
    async *entries(){for(const c of children){await new Promise(ok=>setTimeout(ok,delay));yield [c.name,c];}}});
  window.fakeFolder=(name,folders,per,delay)=>dir(name,Array.from({length:folders},(_,f)=>
    dir(`Album ${f+1}`,Array.from({length:per},(_,t)=>file(`${t+1} Track.${t%4?'mp3':'flac'}`)).concat(file('cover.jpg')),delay)),delay);
}'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,
        args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page(viewport={'width':1440,'height':860})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.evaluate(FAKE)
    page.set_content((ROOT/'dist'/'standalone.html').read_text())
    page.wait_for_function('STATE.ready',timeout=15000)
    assert page.locator('#pl-loading').is_hidden() and page.locator('#pl-empty').is_visible()

    # The folder of the last visit: 12 albums × 30 tracks, 3 ms an entry (~1.1 s).
    page.evaluate("void(window.__restore=restoreFolder(fakeFolder('Music',12,30,3)))")
    page.wait_for_function("!$('pl-loading').hidden",timeout=2000)
    assert page.locator('#pl-loading-text').inner_text()=='Reading «Music»…'
    assert page.locator('#pl-empty').is_hidden(),'no empty-library hint while the folder is read'
    seen=[]
    for _ in range(40):
        if page.locator('#pl-loading').is_hidden():break
        assert page.locator('#pl-empty').is_hidden()
        seen.append(page.locator('#pl-loading-detail').inner_text())
        page.wait_for_timeout(50)
    counts=[int(s.split(' ')[0].replace(',','')) for s in seen if s]
    assert len(set(counts))>=3 and counts==sorted(counts),f'counts grow while reading: {seen}'
    assert any('Album' in s for s in seen),f'the folder being read is named: {seen}'
    page.evaluate('__restore')
    assert page.locator('#pl-loading').is_hidden()
    assert page.evaluate('PL.tracks.length')==360 and page.evaluate("PL.folder")=='Music'
    assert page.locator('#pl-count').inner_text()=='360 tracks'
    assert page.locator('#pl-empty').is_hidden() and page.locator('#pl-reopen').is_hidden()
    assert page.locator('#status').inner_text()=='Folder «Music»: 360 tracks'
    print('PASS restored folder: loader with growing counts, then 360 tracks; no empty hint meanwhile')

    # Cancel while restoring into an empty library: still empty, and one click reopens it.
    page.evaluate("$('pl-clear').click()")  # in the sources menu
    assert page.locator('#pl-empty').is_visible()
    page.evaluate("void(window.__restore=restoreFolder(fakeFolder('Slow',20,40,5)))")
    page.wait_for_function("!$('pl-loading').hidden && PL.tracks.length===0 && /\\d+ track/.test($('pl-loading-detail').textContent) && parseInt($('pl-loading-detail').textContent)>20",timeout=5000)
    page.locator('#pl-loading-cancel').click()
    page.evaluate('__restore')
    assert page.locator('#pl-loading').is_hidden()
    assert page.evaluate('PL.tracks.length')==0 and page.locator('#pl-empty').is_visible()
    assert page.locator('#pl-reopen').is_visible() and page.locator('#pl-reopen').inner_text()=='Reopen «Slow»'
    assert page.locator('#status').inner_text()=='Reading the folder was cancelled'
    print('PASS cancel: the list stays empty, "Reopen «Slow»" is offered')

    # Cancel keeps a list that was already there.
    page.evaluate("addTracks([{path:'Kept.wav',file:new File([new Uint8Array(8)],'Kept.wav')}],true)")
    page.evaluate("window.showDirectoryPicker=async()=>fakeFolder('Other',20,40,5)")
    page.locator('#folder').click()
    page.wait_for_function("!$('pl-loading').hidden",timeout=2000)
    assert page.locator('#pl-loading-text').inner_text()=='Reading «Other»…'
    page.locator('#pl-loading-cancel').click()
    page.wait_for_timeout(100)
    assert page.evaluate('PL.tracks.map(t=>t.name)')==['Kept'] and page.evaluate('PL.folder') is None
    print('PASS cancel keeps the list that was there')

    # The directory picker: the same loader, then the new folder replaces the list.
    page.evaluate("window.showDirectoryPicker=async()=>fakeFolder('Picked',4,25,2)")
    page.locator('#folder').click()
    page.wait_for_function("!$('pl-loading').hidden",timeout=2000)
    assert page.locator('#pl-loading-text').inner_text()=='Reading «Picked»…'
    page.wait_for_function("$('pl-loading').hidden",timeout=5000)
    assert page.evaluate('PL.tracks.length')==100 and page.evaluate("PL.folder")=='Picked'
    assert page.evaluate("PL.tracks[0].path")=='Album 1/1 Track.flac'
    print('PASS directory picker: loader, then 100 tracks in natural order')
    assert not errors,errors
    browser.close()
