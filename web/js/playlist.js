'use strict';
// Playlist: a folder or files from disk plus the pinned Demo / Microphone
// sources; next / previous, repeat and shuffle, drag and drop, hotkeys and the
// Media Session. Tracks keep a File or a directory-picker handle; nothing is
// decoded until a track is played.
const AUDIO_EXT=/\.(mp3|wav|ogg|oga|flac|m4a|aac|opus|webm)$/i;
const PL={tracks:[],current:-1,active:false,ticket:0,repeat:'off',shuffle:false,order:[],history:[],folder:null,filter:''};
const naturalOrder=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
const trackName=path=>path.split('/').pop().replace(/\.[^.]+$/,'');
const trackDir=path=>path.split('/').slice(0,-1).join(' / ');
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// items: [{path, file} | {path, handle}]. A folder replaces the list, files append.
function addTracks(items,replace){
 const fresh=items.filter(x=>AUDIO_EXT.test(x.path)).sort((a,b)=>naturalOrder.compare(a.path,b.path))
  .map(x=>({...x,name:trackName(x.path),dir:trackDir(x.path),failed:false}));
 if(replace){PL.tracks=fresh;PL.current=-1;PL.active=false;PL.history=[];}
 else PL.tracks.push(...fresh);
 shuffleOrder();renderPlaylist();
 return replace?0:PL.tracks.length-fresh.length; // index of the first new track
}
function shuffleOrder(){
 const o=PL.tracks.map((_,i)=>i);
 for(let i=o.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[o[i],o[j]]=[o[j],o[i]];}
 // Keep the playing track first so "next" never repeats it within a cycle.
 if(PL.current>=0){o.splice(o.indexOf(PL.current),1);o.unshift(PL.current);}
 PL.order=o;
}
// Next playable index in play order (dir ±1), skipping tracks that failed; -1 at the end.
function stepTrack(from,dir){
 const order=PL.shuffle?PL.order:PL.tracks.map((_,i)=>i),n=order.length;
 const pos=order.indexOf(from);
 for(let k=1;k<=n;k++){
  let p=(pos<0&&dir<0?n:pos)+dir*k;
  if(p<0||p>=n){if(PL.repeat!=='all')return -1;p=((p%n)+n)%n;}
  if(!PL.tracks[order[p]].failed)return order[p];
 }
 return -1;
}
// Only the latest request loads: fast next/next skips the tracks in between.
async function playTrack(i,dir=1){
 const t=PL.tracks[i];if(!t)return;
 const ticket=++PL.ticket;
 if(PL.shuffle&&PL.current>=0&&PL.current!==i&&dir>0)PL.history.push(PL.current);
 PL.current=i;PL.active=true;renderPlaylist();
 $('filename').textContent=t.name;
 try{
  const file=t.file||await t.handle.getFile();
  if(ticket!==PL.ticket)return;
  if(await loadFile(file,t.name,()=>ticket===PL.ticket))mediaSession();
 }catch(err){
  if(ticket!==PL.ticket)return;
  console.error(err);t.failed=true;renderPlaylist();
  const n=stepTrack(i,dir);
  if(n>=0&&n!==i)playTrack(n,dir);
  else{PL.active=false;$('status').textContent='Could not play: '+err.message;}
 }
}
function playPosition(){return STATE.playing&&STATE.context?STATE.context.currentTime-STATE.playStart:STATE.pausedAt;}
function nextTrack(){
 if(!PL.tracks.length)return;
 const n=PL.active?stepTrack(PL.current,1):PL.current>=0?PL.current:stepTrack(-1,1);
 if(n>=0)playTrack(n,1);else $('status').textContent='End of the playlist';
}
// ⏮ restarts the track after 3 s, otherwise goes to the previous one.
function prevTrack(){
 const restart=()=>seekTo(0);
 if(!PL.active||playPosition()>3)return restart();
 const n=PL.shuffle&&PL.history.length?PL.history.pop():stepTrack(PL.current,-1);
 if(n>=0)playTrack(n,-1);else restart();
}
// Called by playAudio's onended (never for the looped demo).
function onTrackEnded(){
 if(!PL.active||STATE.loopDemo||STATE.inputMode!=='file')return;
 if(PL.repeat==='one'){playAudio();return;}
 const n=stepTrack(PL.current,1);
 if(n>=0)playTrack(n,1);else{$('status').textContent='Playlist finished';mediaSession();}
}
// A pinned source (demo / microphone) takes over from the playlist.
function leavePlaylist(){PL.ticket++;PL.active=false;}
async function playDemo(){
 leavePlaylist();
 try{await ensureAudio();const a=demoAudio();loadBuffer(a.buffer,a.pcm,'Demo beat · 120 BPM',true);await playAudio();}
 catch(err){console.error(err);$('status').textContent='Error: '+err.message;}
 renderPlaylist();mediaSession();
}
async function toggleMicrophone(){
 if(STATE.inputMode==='microphone')return setInputMode('file');
 leavePlaylist();await setInputMode('microphone');mediaSession();
}

// List rendering. Rows are rebuilt on change only (a few thousand rows at most).
function renderPlaylist(){
 const list=$('playlist');if(!list)return;
 const q=PL.filter.trim().toLowerCase(),mic=STATE.inputMode==='microphone';
 $('demo').classList.toggle('current',!mic&&STATE.loopDemo&&!!STATE.buffer);
 $('mic-source').classList.toggle('current',mic);
 $('demo').setAttribute('aria-current',String(!mic&&STATE.loopDemo&&!!STATE.buffer));
 $('mic-source').setAttribute('aria-current',String(mic));
 const rows=[];
 PL.tracks.forEach((t,i)=>{
  if(q&&!(t.name+' '+t.dir).toLowerCase().includes(q))return;
  const cur=PL.active&&i===PL.current&&!mic;
  rows.push(`<li class="track${cur?' current':''}${t.failed?' failed':''}" data-i="${i}"${cur?' aria-current="true"':''} title="${esc(t.path)}"><span class="track-n">${cur&&STATE.playing?'▶':i+1}</span><span class="track-name">${esc(t.name)}${t.dir?`<small>${esc(t.dir)}</small>`:''}</span>${t.failed?'<span class="track-err" title="Could not decode">!</span>':''}</li>`);
 });
 const html=rows.join('');
 if(list.dataset.html!==html){list.innerHTML=html;list.dataset.html=html;list.querySelector('.current')?.scrollIntoView?.({block:'nearest'});}
 const n=PL.tracks.length;
 $('pl-count').textContent=n?(q?`${rows.length} of ${n}`:`${n} track${n===1?'':'s'}`):'';
 $('pl-empty').hidden=n>0;$('pl-search').hidden=n<8&&!q;$('pl-clear').disabled=!n&&!PL.folder;
 $('next').disabled=!n;
}
let lastPlaying=null;
setInterval(()=>{if(STATE.playing!==lastPlaying){lastPlaying=STATE.playing;renderPlaylist();mediaSession();}},250);

// Folder: the directory picker (Chrome / Edge) or <input webkitdirectory>.
async function scanDirectory(dir,prefix=''){
 const out=[];
 for await(const [name,h] of dir.entries()){
  if(h.kind==='directory')out.push(...await scanDirectory(h,prefix+name+'/'));
  else if(AUDIO_EXT.test(name))out.push({path:prefix+name,handle:h});
 }
 return out;
}
async function openDirectory(dir){
 $('status').textContent='Reading the folder…';
 const items=await scanDirectory(dir);
 PL.folder=dir.name;addTracks(items,true);rememberFolder(dir);showReopen(null);
 $('status').textContent=items.length?`Folder «${dir.name}»: ${items.length} tracks`:`No audio files in «${dir.name}»`;
 return items.length;
}
async function pickFolder(){
 if(typeof window.showDirectoryPicker==='function'){
  try{const dir=await window.showDirectoryPicker({id:'esp-led-lab-music',mode:'read'});if(await openDirectory(dir))autoplay(0);return;}
  catch(err){if(err?.name==='AbortError')return;console.warn('Directory picker unavailable, using the file input:',err);}
 }
 $('folder-input').click();
}
// Start the first new track only when nothing is playing.
function autoplay(i){if(!STATE.playing&&PL.tracks[i])playTrack(i);}
$('folder').onclick=pickFolder;
$('folder-input').onchange=ev=>{
 const files=[...ev.target.files];ev.target.value='';if(!files.length)return;
 // webkitRelativePath starts with the picked folder's own name; drop it like the picker does.
 const root=(files[0].webkitRelativePath||'').split('/')[0];
 const items=files.map(f=>({file:f,path:(f.webkitRelativePath||f.name).split('/').slice(root?1:0).join('/')}));
 PL.folder=root||null;forgetFolder();showReopen(null);
 if(addTracks(items,true)===0&&PL.tracks.length)autoplay(0);
};
$('choose').onclick=()=>$('file').click();
$('file').onchange=ev=>{
 const files=[...ev.target.files];ev.target.value='';if(!files.length)return;
 autoplay(addTracks(files.map(f=>({file:f,path:f.name})),false));
};
$('pl-clear').onclick=()=>{PL.tracks=[];PL.current=-1;PL.active=false;PL.history=[];PL.folder=null;PL.filter='';$('pl-search').value='';forgetFolder();showReopen(null);shuffleOrder();renderPlaylist();};
$('pl-search').oninput=e=>{PL.filter=e.target.value;renderPlaylist();};
$('playlist').onclick=e=>{const row=e.target.closest('.track');if(row)playTrack(+row.dataset.i);};
$('demo').onclick=playDemo;
$('mic-source').onclick=toggleMicrophone;

// Remember the picked folder between reloads (Chrome / Edge: handles can be
// stored in IndexedDB). Storage may be unavailable; everything is optional.
const IDB_NAME='esp-led-lab',IDB_STORE='kv',FOLDER_KEY='folder';
function idb(mode,fn){
 return new Promise((resolve,reject)=>{
  try{
   const open=indexedDB.open(IDB_NAME,1);
   open.onupgradeneeded=()=>open.result.createObjectStore(IDB_STORE);
   open.onerror=()=>reject(open.error);
   open.onsuccess=()=>{const db=open.result,tx=db.transaction(IDB_STORE,mode),req=fn(tx.objectStore(IDB_STORE));
    tx.oncomplete=()=>{db.close();resolve(req?.result);};tx.onerror=()=>{db.close();reject(tx.error);};};
  }catch(err){reject(err);}
 });
}
function rememberFolder(dir){idb('readwrite',s=>s.put(dir,FOLDER_KEY)).catch(()=>{});}
function forgetFolder(){idb('readwrite',s=>s.delete(FOLDER_KEY)).catch(()=>{});}
function showReopen(dir){
 const b=$('pl-reopen');b.hidden=!dir;if(!dir)return;
 b.textContent=`↻ Reopen «${dir.name}»`;
 b.onclick=async()=>{
  try{if(await dir.requestPermission({mode:'read'})!=='granted')return;if(await openDirectory(dir))autoplay(0);}
  catch(err){console.warn(err);showReopen(null);$('status').textContent='The folder is no longer available';}
 };
}
(async()=>{
 try{
  const dir=await idb('readonly',s=>s.get(FOLDER_KEY));
  if(!dir||typeof dir.queryPermission!=='function'||PL.tracks.length)return;
  // Permission kept by the browser: just list the folder; otherwise one click asks again.
  if(await dir.queryPermission({mode:'read'})==='granted')await openDirectory(dir);
  else showReopen(dir);
 }catch(_){}
})();

// Drag and drop of files and folders anywhere on the page (appends).
async function entryItems(entry,prefix=''){
 if(entry.isFile)return AUDIO_EXT.test(entry.name)?[{file:await new Promise((ok,fail)=>entry.file(ok,fail)),path:prefix+entry.name}]:[];
 if(!entry.isDirectory)return [];
 const reader=entry.createReader(),out=[];
 // readEntries returns at most ~100 entries per call; loop until it is empty.
 for(;;){
  const batch=await new Promise((ok,fail)=>reader.readEntries(ok,fail));
  if(!batch.length)break;
  for(const e of batch)out.push(...await entryItems(e,prefix+entry.name+'/'));
 }
 return out;
}
const isFileDrag=e=>[...(e.dataTransfer?.types||[])].includes('Files');
let dragDepth=0;
document.addEventListener('dragenter',e=>{if(!isFileDrag(e))return;dragDepth++;document.body.classList.add('dropping');});
document.addEventListener('dragleave',e=>{if(!isFileDrag(e))return;if(--dragDepth<=0){dragDepth=0;document.body.classList.remove('dropping');}});
document.addEventListener('dragover',e=>{if(isFileDrag(e)){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
document.addEventListener('drop',async e=>{
 if(!isFileDrag(e))return;
 e.preventDefault();dragDepth=0;document.body.classList.remove('dropping');
 // Entries must be taken synchronously, before the first await.
 const entries=[...e.dataTransfer.items].map(i=>i.webkitGetAsEntry?.()).filter(Boolean);
 const loose=entries.length?[]:[...e.dataTransfer.files].map(f=>({file:f,path:f.name}));
 const items=[...loose];
 for(const entry of entries)items.push(...await entryItems(entry));
 if(!items.length){$('status').textContent='No audio files in the drop';return;}
 autoplay(addTracks(items,false));
});

// Transport: ⏮ ⏭, shuffle, repeat off → all → one.
$('prev').onclick=prevTrack;$('next').onclick=nextTrack;
$('shuffle').onclick=()=>{
 PL.shuffle=!PL.shuffle;PL.history=[];shuffleOrder();
 $('shuffle').setAttribute('aria-pressed',String(PL.shuffle));$('shuffle').title=PL.shuffle?'Shuffle: on':'Shuffle';
};
$('repeat').onclick=()=>{
 PL.repeat={off:'all',all:'one',one:'off'}[PL.repeat];
 const b=$('repeat'),label={off:'Repeat: off',all:'Repeat: all',one:'Repeat: one track'}[PL.repeat];
 b.textContent=PL.repeat==='one'?'🔂':'🔁';b.title=label;b.setAttribute('aria-label',label);b.setAttribute('aria-pressed',String(PL.repeat!=='off'));
};

// Hotkeys: Space play/pause, ←/→ seek ±5 s, N/P next/previous. Not while typing.
document.addEventListener('keydown',e=>{
 if(e.ctrlKey||e.metaKey||e.altKey)return;
 const tag=document.activeElement?.tagName;
 if(['INPUT','SELECT','TEXTAREA'].includes(tag)||document.activeElement?.isContentEditable)return;
 if(e.code==='Space'){
  if(tag==='BUTTON')return; // the focused button handles Space itself
  e.preventDefault();if(STATE.playing)pauseAudio();else if(STATE.buffer||STATE.inputMode==='microphone')playAudio();
 }else if(e.key==='ArrowLeft'||e.key==='ArrowRight'){
  if(!STATE.buffer||STATE.inputMode!=='file')return;
  e.preventDefault();seekTo(playPosition()+(e.key==='ArrowRight'?5:-5));
 }else if(e.key==='n'||e.key==='N'){nextTrack();}
 else if(e.key==='p'||e.key==='P'){prevTrack();}
});

// Media Session: hardware media keys and the browser's media controls.
function mediaSession(){
 const ms=navigator.mediaSession;if(!ms)return;
 try{
  const title=STATE.inputMode==='microphone'?'Microphone':STATE.fileName||'ESP LED Music Lab';
  if(ms.metadata?.title!==title&&typeof MediaMetadata==='function')ms.metadata=new MediaMetadata({title,artist:'ESP LED Music Lab'});
  ms.playbackState=STATE.playing?'playing':STATE.buffer?'paused':'none';
 }catch(_){}
}
try{
 const ms=navigator.mediaSession;
 if(ms){
  const actions={play:()=>playAudio(),pause:()=>pauseAudio(),previoustrack:prevTrack,nexttrack:nextTrack,
   seekto:d=>{if(Number.isFinite(d.seekTime))seekTo(d.seekTime);}};
  for(const [a,fn] of Object.entries(actions))try{ms.setActionHandler(a,fn);}catch(_){}
 }
}catch(_){}
