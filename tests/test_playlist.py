"""Playlist and lamp controls in Chromium.
Pickers cannot be driven headless, so tracks are injected as File objects through
the playlist API (addTracks); lamps are in-page fake WebSockets that answer like
firmware with the "control" capability, plus one older lamp without it.
Run: python tests/test_playlist.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
errors=[]
FAKES='''() => {
  window.__control=[];window.__http=[];window.__lamps={};
  const realFetch=window.fetch;
  window.fetch=(url,opts)=>{if(String(url).includes('/api/')){__http.push(String(url));return Promise.resolve(new Response(''));}return realFetch(url,opts);};
  window.WebSocket=class FakeSocket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.bufferedAmount=0;
      this.lamp=__lamps[url]||={power:true,brightness:100,control:!url.includes(':8767')};
      setTimeout(()=>{this.readyState=1;this.onopen?.({});},2);}
    send(data){
      if(data instanceof ArrayBuffer)return;
      const msg=JSON.parse(data),lamp=this.lamp,state=lamp.control?{power:lamp.power,brightness:lamp.brightness}:{};
      __control.push({url:this.url,...msg});
      const reply=obj=>setTimeout(()=>this.onmessage?.({data:JSON.stringify(obj)}),2);
      if(msg.type==='hello')reply({type:'hello_ack',version:1,band_counts:[16,32,64],width:16,height:16,
        capabilities:['sync','clock','config','status','tuning'].concat(lamp.control?['control']:[]),...state});
      if(msg.type==='sync')reply({type:'sync_ack',id:msg.id,t1:performance.now(),t2:performance.now()});
      if(msg.type==='clock')reply({type:'clock_ack'});
      if(msg.type==='status')reply({type:'status',playing:false,received_frames:0,buffer_occupancy:0,...state});
      if(msg.type==='power'){lamp.power=msg.on;reply({type:'control_ack',power:lamp.power,brightness:lamp.brightness});}
      if(msg.type==='brightness'){lamp.brightness=msg.value;reply({type:'control_ack',power:lamp.power,brightness:lamp.brightness});}
    }
    close(){this.readyState=3;setTimeout(()=>this.onclose?.({code:1000}),1);}
  };
}'''
# 16 kHz mono 16-bit WAV of `sec` seconds; a broken "mp3" and a text file are mixed in.
TRACKS='''(sec) => {
  const wav=(freq)=>{const rate=16000,n=Math.round(rate*sec),b=new ArrayBuffer(44+n*2),v=new DataView(b);
    const w=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
    w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
    v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);
    for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(2*Math.PI*freq*i/rate)*9000,true);return b;};
  const f=(path,freq)=>({path,file:new File([wav(freq)],path.split('/').pop(),{type:'audio/wav'})});
  return addTracks([f('Album/10 Last.wav',300),f('Album/2 Second.wav',500),
    {path:'Album/3 Broken.mp3',file:new File([new Uint8Array(64)],'3 Broken.mp3')},
    f('1 First.wav',700),{path:'cover.txt',file:new File(['x'],'cover.txt')}],true);
}'''
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,
        args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    page=browser.new_page(viewport={'width':1440,'height':860})
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.evaluate(FAKES)
    page.set_content((ROOT/'dist'/'standalone.html').read_text())
    page.wait_for_function('STATE.ready',timeout=15000)

    # List: audio only, natural order by path, rendered rows with the folder as a second line.
    page.evaluate(TRACKS,1.0)
    paths=page.evaluate('PL.tracks.map(t=>t.path)')
    assert paths==['1 First.wav','Album/2 Second.wav','Album/3 Broken.mp3','Album/10 Last.wav'],paths
    assert page.locator('#playlist .track').count()==4 and page.locator('#pl-count').inner_text()=='4 tracks'
    assert page.locator('#playlist .track').nth(1).locator('small').inner_text()=='Album'
    print('PASS list: audio files only, natural sort by path')

    # Click a row; at its natural end the next playable track starts, the broken one is skipped.
    page.locator('#playlist .track').first.click()
    page.wait_for_function('STATE.playing && PL.current===0',timeout=10000)
    assert page.locator('#filename').inner_text()=='1 First'
    page.wait_for_function('STATE.playing && PL.current===1',timeout=10000)
    page.wait_for_function('STATE.playing && PL.current===3',timeout=10000)
    assert page.evaluate('PL.tracks[2].failed') and page.locator('#playlist .track.failed').count()==1
    page.wait_for_function('!STATE.playing && PL.current===3',timeout=10000)
    assert page.locator('#status').inner_text()=='Playlist finished'
    print('PASS auto-advance at natural end, undecodable track skipped, stops at the end (repeat off)')

    # ⏭ / ⏮: previous within 3 s goes back, after 3 s restarts the track.
    page.evaluate(TRACKS,6.0)
    page.locator('#playlist .track').first.click()
    page.wait_for_function('STATE.playing && PL.current===0',timeout=10000)
    page.locator('#next').click()
    page.wait_for_function('STATE.playing && PL.current===1',timeout=10000)
    page.locator('#prev').click()
    page.wait_for_function('STATE.playing && PL.current===0',timeout=10000)
    page.evaluate('seekTo(4)')
    page.wait_for_timeout(200)
    page.locator('#prev').click()
    page.wait_for_function('STATE.playing && PL.current===0 && STATE.context.currentTime-STATE.playStart<1.5',timeout=5000)
    # Fast next/next: only the latest request loads (track 2 is skipped as broken).
    page.locator('#next').click();page.locator('#next').click()
    page.wait_for_function('STATE.playing && PL.current===3 && STATE.fileName==="10 Last"',timeout=10000)
    page.keyboard.press('p')
    page.wait_for_function('STATE.playing && PL.current===1',timeout=10000)
    print('PASS next / previous / restart after 3 s / fast next / P hotkey')

    # Repeat one: the same track starts again at its end.
    page.evaluate(TRACKS,0.8)
    page.locator('#repeat').click();page.locator('#repeat').click()
    assert page.evaluate('PL.repeat')=='one' and page.locator('#repeat').get_attribute('aria-pressed')=='true'
    page.locator('#playlist .track').first.click()
    page.wait_for_function('STATE.playing && PL.current===0',timeout=10000)
    start=page.evaluate('STATE.playStart')
    page.wait_for_function(f'STATE.playing && PL.current===0 && STATE.playStart>{start}+0.5',timeout=5000)
    page.locator('#repeat').click()
    assert page.evaluate('PL.repeat')=='off'
    print('PASS repeat one')

    # Pinned sources take over; the demo loops and never advances the playlist.
    page.locator('#demo').click()
    page.wait_for_function('STATE.playing && STATE.loopDemo && !PL.active',timeout=10000)
    assert 'current' in page.locator('#demo').get_attribute('class')
    assert page.locator('#playlist .track.current').count()==0
    page.locator('#pl-clear').click()
    assert page.evaluate('PL.tracks.length')==0 and page.locator('#pl-empty').is_visible()
    print('PASS demo row, clear list')

    # Lamps: connect all, then power and brightness for every connected lamp.
    for port in [8765,8766,8767]:
        page.locator('#remote-address').fill(f'127.0.0.1:{port}')
        page.locator('#remote-add').click()
    page.evaluate('REMOTE.disconnectAll()')
    page.wait_for_function("document.getElementById('lamps-connect').textContent==='Connect all'")
    assert page.locator('#lamps-on').is_disabled() and page.locator('#lamps-brightness').is_disabled()
    page.locator('#lamps-connect').click()
    page.wait_for_function('REMOTE.controllable.length===3',timeout=10000)
    page.wait_for_function("document.getElementById('lamps-connect').textContent==='Disconnect all'")
    assert page.locator('#lamps-brightness-value').inner_text()=='39%' # 100/255 on the two "control" lamps
    page.locator('#lamps-off').click()
    page.wait_for_function("Object.values(__lamps).filter(l=>l.control).every(l=>!l.power)")
    page.wait_for_function("document.getElementById('lamps-off').classList.contains('active')")
    page.locator('#lamps-brightness').fill('80')
    page.wait_for_function("Object.values(__lamps).filter(l=>l.control).every(l=>l.brightness===204)")
    page.locator('#lamps-on').click()
    page.wait_for_function("Object.values(__lamps).filter(l=>l.control).every(l=>l.power)")
    # The older lamp gets the HTTP API instead (brightness in %).
    http=page.evaluate('__http')
    assert 'http://127.0.0.1:8767/api/power?value=0' in http and 'http://127.0.0.1:8767/api/brightness?value=80' in http and \
        'http://127.0.0.1:8767/api/power?value=1' in http, http
    assert not any(':8765' in u or ':8766' in u for u in http), http
    # Per-lamp power button, and a change made on the lamp shows up with the next status.
    page.locator('.lamp').nth(1).locator('.lamp-power').click()
    page.wait_for_function("!__lamps['ws://127.0.0.1:8766/audio'].power && __lamps['ws://127.0.0.1:8765/audio'].power")
    page.evaluate("__lamps['ws://127.0.0.1:8765/audio'].brightness=51")
    page.wait_for_function("REMOTE.devices[0].brightness===51",timeout=5000)
    page.wait_for_function("document.querySelector('.lamp .lamp-ctl .value').textContent==='20%'")
    assert 'older firmware: power and brightness over HTTP' in page.locator('.lamp').nth(2).inner_text()
    print('PASS connect all, all on/off, all brightness, per-lamp power, HTTP fallback for older firmware')

    assert not errors,errors
    print('PASS no page errors')
    browser.close()
