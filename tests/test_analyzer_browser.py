"""Analyzer timing, source-aware resampling and resolved FFT display in Chromium."""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
# Browser decoding resamples to its context. The WAV header must remain the
# source of truth, especially when a low-rate file is decoded at 48 kHz.
TONE='''async rate => {
 const sec=4,n=rate*sec,b=new ArrayBuffer(44+n*2),v=new DataView(b);
 const w=(o,s)=>[...s].forEach((c,i)=>v.setUint8(o+i,c.charCodeAt(0)));
 w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
 v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);
 for(let i=0;i<n;i++){const t=i/rate;v.setInt16(44+i*2,Math.sin(2*Math.PI*1000*t)*(0.2+0.15*Math.sin(2*Math.PI*3*t))*32767,true);}
 await loadFile(new File([b],'native-'+rate+'.wav',{type:'audio/wav'}));
 STATE.loopDemo=true;STATE.source.loop=true;
}'''
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM') or None,args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
 page=browser.new_page(viewport={'width':1440,'height':900})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.set_content((ROOT/'dist/standalone.html').read_text())
 page.wait_for_function('STATE.ready')
 assert page.locator('#fft option[value="64"]').count()==1
 assert page.locator('#fft option[value="128"]').count()==1
 page.evaluate(TONE,48000)
 page.wait_for_function('STATE.newSpectrum.some(v=>v>.01)')
 assert page.evaluate('STATE.fileSampleRate')==48000
 page.evaluate('window.__source=STATE.source;window.__playStart=STATE.playStart;window.__lowHz=frequencyRange().lo')
 for rate in [8000,16000,32000,48000]:
  page.locator('#sample-rate').select_option(str(rate),force=True)
  page.wait_for_function(f'fs==={rate} && !$("sample-rate").hasAttribute("aria-busy")')
  assert page.evaluate(f'STATE.pcm.length===4*{rate} && STATE.source===__source && STATE.playStart===__playStart && STATE.playing')
  assert page.evaluate('frequencyRange().hi')==rate/2
  assert page.evaluate('frequencyRange().lo===__lowHz'), 'rate changes drifted the chosen low frequency'
  assert str(rate//2000)+' kHz' in page.locator('#sample-rate-hint').inner_text()
 page.locator('#fft').select_option('64',force=True)
 page.wait_for_function('$("new-mini-bars").dataset.spectrum===SPECTRUM.key && STATE.displaySpectrum.length===SPECTRUM.groups.length')
 small=page.locator('#new-mini-bars .bar').count()
 assert 1<small<32,small
 page.locator('#fft').select_option('128',force=True)
 page.wait_for_function('$("new-mini-bars").dataset.spectrum===SPECTRUM.key && STATE.displaySpectrum.length===SPECTRUM.groups.length')
 medium=page.locator('#new-mini-bars .bar').count()
 assert small<medium,(small,medium)
 page.locator('#fft').select_option('2048',force=True)
 page.wait_for_function('$("new-mini-bars").dataset.spectrum===SPECTRUM.key && SPECTRUM.key.startsWith("2048:")')
 large=page.locator('#new-mini-bars .bar').count()
 assert medium<large,(small,medium,large)
 assert 'Hz/bin' in page.locator('#spectrum-detail').inner_text()
 print('PASS file resampling 8/16/32/48 kHz preserves playback; FFT display groups:',small,medium,large)
 # Resetting the analyzer after multiple demo loops must not rewind the remote
 # DSP back to the beginning of that loop indefinitely.
 page.evaluate('STATE.playStart=STATE.context.currentTime-8.5')
 page.locator('#fft').select_option('64',force=True)
 page.wait_for_function('STATE.nextSample > fs*8.4 && RS.visual && RS.visual.sample>fs*8.3',timeout=5000)
 page.wait_for_timeout(300)
 assert page.evaluate('STATE.nextSample > (STATE.context.currentTime-STATE.playStart-.1)*fs')
 print('PASS analyzer reset on a later demo loop keeps the absolute stream timeline')
 # Metadata, rather than the already-resampled AudioBuffer, caps useful rates.
 page.evaluate(TONE,8000)
 assert page.evaluate('STATE.fileSampleRate===8000 && STATE.buffer.sampleRate===8000 && fs===8000 && STATE.pcm.length===32000')
 assert page.locator('#sample-rate option[value="16000"]').is_disabled()
 assert page.locator('#sample-rate option[value="48000"]').is_disabled()
 page.evaluate('changeAnalysisRate(48000)')
 assert page.evaluate('fs')==8000
 page.evaluate(TONE,6000)
 assert page.evaluate('fs===8000 && frequencyRange().hi===3000')
 assert 'minimum' in page.locator('#sample-rate-hint').inner_text()
 page.evaluate(TONE,22050)
 assert page.evaluate('STATE.buffer.sampleRate')==22050
 page.locator('#sample-rate').select_option('22050',force=True)
 page.wait_for_function('fs===22050 && STATE.pcmRate===22050')
 assert page.locator('#sample-rate option[value="32000"]').is_disabled()
 page.evaluate('Promise.all([changeAnalysisRate(8000),changeAnalysisRate(22050)])')
 assert page.evaluate('fs===22050 && STATE.pcmRate===22050 && !$("sample-rate").hasAttribute("aria-busy")')
 print('PASS original 8/22.05 kHz file metadata, source caps, native-rate option and latest request wins')
 # A captured track can differ from the AudioContext rate. Use track settings
 # for the source limit and context rate for the actual incoming PCM stream.
 page.evaluate('''() => Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
  const c=STATE.context,osc=c.createOscillator(),out=c.createMediaStreamDestination();osc.frequency.value=1000;osc.connect(out);osc.start();
  const track=out.stream.getAudioTracks()[0];Object.defineProperty(track,'getSettings',{value:()=>({sampleRate:44100})});return out.stream;
 }}})''')
 page.evaluate("setInputMode('microphone')")
 page.wait_for_function('STATE.playing && STATE.mic?.written>1000',timeout=10000)
 page.evaluate('window.__micStream=STATE.mic.stream')
 page.locator('#sample-rate').select_option('44100',force=True)
 page.wait_for_function('fs===44100 && STATE.mic.written>1000')
 assert page.locator('#sample-rate option[value="48000"]').is_disabled()
 assert page.evaluate('STATE.mic.stream===__micStream && STATE.mic.lowpass1.frequency.value>19000')
 page.locator('#sample-rate').select_option('8000',force=True)
 page.wait_for_function('fs===8000 && STATE.mic.written>1000')
 assert page.evaluate('STATE.mic.stream===__micStream && STATE.mic.lowpass1.frequency.value===3500')
 page.locator('#sample-rate').select_option('44100',force=True)
 page.wait_for_function('fs===44100')
 page.evaluate("setInputMode('file')")
 page.wait_for_function('STATE.mic===null && fs===22050 && STATE.pcmRate===22050')
 assert page.evaluate('STATE.pcm.length===88200')
 print('PASS microphone 44.1 kHz cap, live rate/filter changes preserve capture, returning to file reconverts PCM')
 page.locator('.tabs [data-tab="dsp"]').click()
 page.screenshot(path=str(ROOT/'tests'/'analyzer_dsp.png'))
 # A low-rate playback device must not discard a high-rate file's data
 # before the analyzer chooses its own rate.
 second=browser.new_page()
 second.on('pageerror',lambda e:errors.append(str(e)))
 second.set_content((ROOT/'dist/standalone.html').read_text());second.wait_for_function('STATE.ready')
 second.evaluate('STATE.context=new AudioContext({sampleRate:16000})')
 second.evaluate(TONE,48000)
 assert second.evaluate('STATE.context.sampleRate===16000 && STATE.buffer.sampleRate===48000 && STATE.fileSampleRate===48000')
 second.locator('#sample-rate').select_option('48000',force=True)
 second.wait_for_function('fs===48000 && STATE.pcmRate===48000')
 print('PASS 48 kHz source decoding is independent of a 16 kHz playback context')
 assert not errors,errors
 browser.close()
