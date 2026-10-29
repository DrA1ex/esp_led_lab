"""Regression coverage for file replay, mic capture and new-only input meter.
Run: python tests/test_audio_sources.py
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
errors=[]

try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,args=[
      '--no-sandbox','--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'])
  context=browser.new_context(viewport={'width':1280,'height':900})
  page=context.new_page()
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content((ROOT/'dist'/'standalone.html').read_text())
  page.wait_for_function('STATE.ready===true',timeout=30000)
  # A file reaching natural onended must replay from the beginning without reset.
  page.evaluate('''async () => {
    await ensureAudio();
    const a=demoAudio(),length=16000;
    const mono=STATE.context.createBuffer(1,length,16000), pcm=a.pcm.slice(0,length);
    mono.getChannelData(0).set(pcm);
    loadBuffer(mono,pcm,'replay fixture');
    await playAudio();
  }''')
  page.wait_for_function('STATE.playing && STATE.nextSample > 1536',timeout=15000)
  page.wait_for_function('!STATE.playing && STATE.source===null',timeout=15000)
  assert page.evaluate('STATE.pausedAt===0 && STATE.silenceFrom!==Infinity'), 'natural end must rewind and release on silence'
  page.locator('#play').click()
  page.wait_for_function('STATE.playing && STATE.nextSample > 1536',timeout=15000)
  assert page.evaluate('STATE.newParam>0.01 && STATE.newSpectrum.some(x=>x>0.01)'), 'DSP must react on second run'
  print('PASS file replay: natural end, next play resumes WASM DSP without reset')
  # Pause is silence: the spectrum releases instead of freezing; resume continues from the pause.
  page.evaluate('''async () => {await ensureAudio();const a=demoAudio();loadBuffer(a.buffer,a.pcm,'pause fixture');await playAudio();}''')
  page.wait_for_function('STATE.playing && Math.max(...STATE.newSpectrum)>0.05',timeout=15000)
  page.wait_for_timeout(800)
  page.locator('#play').click()
  page.wait_for_function('!STATE.playing',timeout=5000)
  page.wait_for_function('Math.max(...STATE.newSpectrum)<0.02 && STATE.newLoudness<0.02',timeout=5000)
  paused=page.evaluate('STATE.pausedAt')
  assert paused>0.1,paused
  page.locator('#play').click()
  page.wait_for_function('STATE.playing && Math.max(...STATE.newSpectrum)>0.05',timeout=15000)
  pos=page.evaluate('(STATE.context.currentTime-STATE.playStart)')
  assert paused-0.05<=pos<paused+1.5,(paused,pos)
  print('PASS pause: spectrum releases on silence, resume continues at',round(paused,2),'s')
  # Dragging the position slider during playback is not overwritten by the animation loop.
  page.evaluate('''() => {const s=document.getElementById('seek');s.dispatchEvent(new PointerEvent('pointerdown'));s.value=800;s.dispatchEvent(new Event('input'));}''')
  page.wait_for_timeout(300)
  assert page.evaluate('+document.getElementById("seek").value')==800
  page.evaluate('''() => {const s=document.getElementById('seek');s.dispatchEvent(new Event('change'));s.dispatchEvent(new PointerEvent('pointerup'));}''')
  page.wait_for_function('STATE.playing && (STATE.context.currentTime-STATE.playStart)>STATE.buffer.duration*0.75',timeout=5000)
  print('PASS seek: held slider keeps its value, release jumps to it')
  # The visual meter is exclusively new/control, and is actually driven by signal.
  page.locator('#audio-mode').select_option('8',force=True)
  page.locator('#param-source').select_option('bass',force=True)
  page.wait_for_timeout(350)
  assert page.locator('#control-visual').is_visible()
  data=page.evaluate('''() => ({label:document.getElementById('control-source-label').textContent,
      width:parseFloat(document.getElementById('control-fill').style.width),
      text:document.getElementById('control-visual').textContent})''')
  assert 'Bass' in data['label'] and 'legacy' not in data['text'].lower(),data
  print('PASS visual meter: only selected new DSP signal',data['label'])
  # Real browser capture API, with a synthetic (not real-user) microphone.
  # Chromium in this environment disallows navigation to local/HTTPS URLs and
  # about:blank is not secure. Inject a synthetic MediaStream to cover the
  # complete real AudioContext -> resampling -> WASM capture fallback path.
  page.evaluate('''() => {
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia: async () => {
      const c=STATE.context,osc=c.createOscillator(),out=c.createMediaStreamDestination();
      osc.frequency.value=183;osc.connect(out);osc.start();return out.stream;
    }}});
  }''')
  page.locator('#mic-source').click()
  page.wait_for_function('STATE.mic && STATE.mic.written>4096',timeout=20000)
  mic=page.evaluate('''() => ({mode:STATE.inputMode, rate:STATE.mic.nativeRate,
    samples:STATE.mic.written, playing:STATE.playing, bands:STATE.newSpectrum.slice(),
    worklet:!!STATE.mic.worklet, fallback:!!STATE.mic.processor})''')
  assert mic['mode']=='microphone' and mic['playing'] and max(mic['bands'])>0.001,mic
  print('PASS microphone: synthetic MediaStream ->',mic['rate'],'Hz -> 16k -> WASM, worklet',mic['worklet'])
  page.locator('#play').click()
  page.wait_for_function('!STATE.playing && STATE.mic===null')
  page.locator('#play').click()
  page.wait_for_function('STATE.playing && STATE.mic && STATE.mic.written>4096',timeout=20000)
  assert page.evaluate('STATE.newSpectrum.some(x=>x>0.001)')
  print('PASS microphone stop/restart: DSP resumes after capture is stopped')
  page.locator('#mic-source').click()  # second click: back to the file side
  page.wait_for_function('!STATE.mic && STATE.inputMode==="file"')
  assert page.locator('#seek').is_enabled()
  assert not errors,errors
  print('PASS source switching: microphone tracks released, file transport restored')
  context.close();browser.close()
finally:
 pass
