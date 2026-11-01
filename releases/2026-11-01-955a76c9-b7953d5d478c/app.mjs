import {SYS,GFX} from './bridge-abi.mjs';
import {createRuntime} from './wasm-runtime.mjs';
import {WebGLHost} from './webgl.mjs';
import {SystemHost} from './system.mjs';
import {InputHost} from './input.mjs';
import {TextHost} from './text.mjs';
import {AssetHost} from './assets.mjs';
import {AudioHost} from './audio.mjs';
import {VersionedStore} from './storage.mjs';
import {importLegacy,validateSaveValue} from './save-transfer.mjs';
import {golubAssetPolicy} from './asset-policy.mjs';
import {releaseHash,fetchVerified} from './release-runtime.mjs';
import {RuntimeSession,waitForGraphics} from './session.mjs';
const canvas=document.querySelector('#game'),status=document.querySelector('#status'),errorBox=document.querySelector('#error'),query=new URLSearchParams(location.search);
let activeSession;
const testMode=query.get('test')==='1';
const gameMode=query.get('game')==='1'||!!globalThis.golubRelease&&query.get('showcase')!=='1';
const needsStart=!testMode&&gameMode,startScreen=document.querySelector('#start-screen');
let startAccepted=!needsStart,startContext,startResume=Promise.resolve(),acceptStart;
const startPromise=startAccepted?Promise.resolve():new Promise(resolve=>acceptStart=resolve);
function removeStartHandlers(){window.removeEventListener('keydown',startGesture,true);window.removeEventListener('pointerdown',startGesture,true);}
function hideStart(){startScreen.hidden=true;removeStartHandlers();}
function showStart(){if(startAccepted)return;startScreen.hidden=false;window.addEventListener('keydown',startGesture,true);window.addEventListener('pointerdown',startGesture,true);}
function startGesture(event){
 if(!event.isTrusted||event.repeat||event.ctrlKey||event.metaKey||navigator.userActivation&&!navigator.userActivation.isActive)return;
 event.preventDefault();event.stopImmediatePropagation();if(startAccepted)return;startAccepted=true;
 try{const Context=globalThis.AudioContext||globalThis.webkitAudioContext;if(Context){startContext=new Context({latencyHint:'interactive'});startResume=startContext.resume().catch(reason=>notice('Звук недоступен. '+reason.message));}}catch(reason){notice('Звук недоступен. '+reason.message);}
 acceptStart();
}
function notice(message){const element=document.querySelector('#notice');element.textContent=message;element.hidden=!message;}
async function restartGame(){const previousGL=activeSession?.graphics?.gl;activeSession?.dispose();activeSession=createGameSession(previousGL);await activeSession.boot();}
function createGameSession(previousGL){
const scope=new RuntimeSession();
let runtime,glHost,system,input,assets,audio,storage,request=0,running=false,inFrame=false,first=true,diagnosticAt=0;
let resourceAt=0,resourceCPU=0,resourceFrames=0;
function resourcePanel(elapsed){
 const panel=document.querySelector('#resources'),enabled=runtime.exportNames.includes('performance_overlay')&&runtime.call('performance_overlay')===1;
 panel.hidden=!enabled;if(!enabled){resourceAt=0;resourceCPU=0;resourceFrames=0;return;}
 const now=performance.now();resourceCPU+=elapsed;resourceFrames++;
 if(resourceAt&&now-resourceAt<500)return;
 const mib=n=>(n/1048576).toFixed(1)+' MiB',heap=performance.memory?.usedJSHeapSize;
 const fps=resourceAt?Math.round(resourceFrames*1000/(now-resourceAt)):null;
 const rows=[['gpu','GPU TEX','≈ '+mib(glHost.stats.gpuBytes)],['ram','WASM',mib(runtime.memory.buffer.byteLength)],['ram','JS',heap?'≈ '+mib(heap):'—'],['cpu','CPU',(resourceCPU/resourceFrames).toFixed(1)+' ms'],['fps','WEBGL2',fps===null?'— FPS':fps+' FPS']];
 panel.replaceChildren(...rows.map(([kind,label,value])=>{const row=document.createElement('span');row.className='meter '+kind;const b=document.createElement('b');b.textContent=label;const v=document.createElement('span');v.textContent=value;row.append(b,v);return row;}));
 panel.title='GPU: оценка текстур; WASM: память игры; JS: приблизительный heap; CPU: время кадра, не загрузка процессора.';
 resourceAt=now;resourceCPU=0;resourceFrames=0;
}
function error(error){if(scope.closed)return;hideStart();document.querySelector('#loading').hidden=true;running=false;cancelAnimationFrame(request);console.error(error);errorBox.hidden=false;errorBox.textContent='Не удалось продолжить работу.\n'+error.message.split('\n')[0];document.querySelector('#restart').hidden=false;status.textContent='Ошибка';window.engineFailure=error.message;}
function loadingProgress({completed,total,phase}){
 if(window.engineFailure)return;
 const progress=completed/Math.max(1,total),percent=needsStart&&!window.engineStartupReady?Math.round(phase==='data'?20*progress:20+80*progress):Math.round(progress*100),loading=document.querySelector('#loading');
 loading.hidden=false;document.querySelector('#loading-bar').style.width=percent+'%';document.querySelector('#loading-percent').textContent=percent+'%';document.querySelector('#loading-track').setAttribute('aria-valuenow',String(percent));
}
function audioWarning(reason){notice('Звук недоступен. Игра продолжится без звука.');console.warn('Audio: '+reason.message);audio?.stop();document.querySelector('#sound').textContent='Звук недоступен. Игра продолжится без звука.';}
async function restart(){
 if(scope.closed)return;await restartGame();
}
function resize(){if(scope.closed)return;const rect=canvas.parentElement.getBoundingClientRect(),ratio=devicePixelRatio||1,limits=glHost?.limits,maxWidth=Math.min(limits?.maxTextureSize||16384,limits?.maxRenderbufferSize||16384,limits?.maxViewport?.[0]||16384),maxHeight=Math.min(limits?.maxTextureSize||16384,limits?.maxRenderbufferSize||16384,limits?.maxViewport?.[1]||16384),scale=Math.min(ratio,maxWidth/Math.max(1,rect.width),maxHeight/Math.max(1,rect.height)),w=Math.max(1,Math.floor(rect.width*scale)),h=Math.max(1,Math.floor(rect.height*scale));if(w!==canvas.width||h!==canvas.height){canvas.width=w;canvas.height=h;if(runtime){runtime.call('resize');if(input){input.logicalWidth=runtime.call('logical_width');input.logicalHeight=runtime.call('logical_height');}}}}
function pascalError(){return new Error(runtime.text(runtime.call('error_ptr'),runtime.call('error_len'))||'Pascal engine failed');}
function updateLoading(s){
 if(!s.preload&&![...assets.schedulers.values()].some(q=>q.jobs.some((job,i)=>assets.wanted(job.path,q.group)&&!q.completed.has(i))))document.querySelector('#loading').hidden=true;
}
function tick(now){
 scope.check();
 if(glHost.lost)return state();
 if(inFrame)throw new Error('Reentrant frame callback');inFrame=true;
 const started=performance.now();let completed;
 try{if(first){runtime.call('suspend',now);first=false;}input.flush(runtime);const result=runtime.call('frame',now);if(result<0)throw pascalError();if(!result)running=false;completed=state();updateLoading(completed);return completed;}finally{inFrame=false;if(completed)resourcePanel(performance.now()-started);}
}
function state(){const p=runtime.call('state_ptr');return JSON.parse(runtime.text(p,runtime.call('state_len')));}
function frame(timestamp){
 if(!running||document.hidden)return;
 try{const begin=performance.now(),s=tick(timestamp/1000);if(s.title||s.game||s.dive)status.textContent='Голубь';
  if(query.has('debug')&&timestamp-diagnosticAt>250){diagnosticAt=timestamp;const stats=glHost.stats,cpu=Object.entries(s.cpuMs||{}).map(([key,ms])=>key+': '+ms.toFixed(2)).join(' · '),gpu=Object.entries(stats.gpuMs).map(([key,samples])=>{const sorted=[...samples].sort((a,b)=>a-b);return key+': '+(sorted[Math.ceil(sorted.length*.95)-1]||0).toFixed(3);}).join(' · ');
   document.querySelector('#diagnostics').textContent=stats.draws+' draw calls · '+stats.vertices+' вершин · '+(stats.gpuBytes/1048576).toFixed(1)+' МиБ текстур\nCPU мс: '+cpu+' · кадр '+(performance.now()-begin).toFixed(2)+'\nGPU p95 мс: '+(gpu||'таймер недоступен')+'\nWasm '+(runtime.memory.buffer.byteLength/1048576).toFixed(1)+' МиБ · bridge '+stats.calls+' · vertices '+stats.vertexBytes+' Б · upload '+stats.uploadBytes+' Б · audio underrun '+(audio.stats?.underrunFrames||0);
  }if(running)request=requestAnimationFrame(scope.guard(frame));
 }catch(e){if(!scope.closed)error(e);}
}

async function boot(){
 try{
  window.engineReady=false;window.engineBooted=false;window.engineStarted=false;window.engineStartupReady=false;hideStart();
  errorBox.hidden=true;document.querySelector('#restart').hidden=true;window.engineFailure=null;resize();
  await scope.wait(waitForGraphics(canvas,previousGL,{signal:scope.signal}));
  const memory=()=>{if(!runtime)throw new Error('Runtime memory is not initialized');return runtime.memory;};
  storage=await scope.wait(new VersionedStore({validatePayload:validateSaveValue,onState:scope.guard((s,message)=>{const label=document.querySelector('#storage');if(s==='failed')notice('Постоянные сохранения недоступны. Игра продолжится.');label.textContent=(s==='failed'?'Постоянные сохранения недоступны. Игра продолжится. ':'')+(message||(s==='ready'?'':s==='opening'?'Открываем сохранения…':''));if(message)label.closest('details').open=true;})}).open().then(value=>scope.own(value,s=>s.close())));
  const shaders=JSON.parse(new TextDecoder().decode(await scope.wait(fetchVerified('./shaders.json',releaseHash('./shaders.json'),{signal:scope.signal}))));
  glHost=scope.own(new WebGLHost(canvas,memory,{
   shaders,profile:testMode||query.has('debug'),onError:scope.guard(error),restoreAsset:(id,path)=>assets.restoreTexture(id,path),
   onLost:scope.guard(()=>{cancelAnimationFrame(request);assets?.contextLost();input?.blur();if(runtime)runtime.call('suspend',performance.now()/1000);status.textContent='Восстановление графики…';}),
   onRestored:scope.guard(()=>{assets?.finishRestore();input?.blur();if(runtime)runtime.call('suspend',performance.now()/1000);first=true;status.textContent='Графика восстановлена';if(running&&!testMode)request=requestAnimationFrame(scope.guard(frame));})
  }),g=>g.call(GFX.SHUTDOWN,0,0,0,0,0,0));
  system=new SystemHost(canvas,memory,{onError:scope.guard(error)});const text=new TextHost(memory,{trace:testMode});
  assets=scope.own(new AssetHost(system,glHost,{configuration:query.get('configuration')==='Debug'?'Debug':'Release',onProgress:scope.guard(loadingProgress),onPrepare:golubAssetPolicy(system),fontFaces:[{family:'Rubik',file:'/fonts/Rubik-Variable.ttf',weight:'300 900'},{family:'Golub Serif',file:'/fonts/GolubSerif-Regular.ttf'},{family:'Golub Serif',file:'/fonts/GolubSerif-Bold.ttf',weight:'700'},{family:'Golub Serif',file:'/fonts/GolubSerif-Italic.ttf',style:'italic'}]}),a=>a.close());
  audio=scope.own(new AudioHost(memory,{configuration:query.get('configuration')==='Debug'?'Debug':'Release',autoGesture:!needsStart,onState:scope.guard(s=>document.querySelector('#sound').textContent=s),onError:scope.guard(audioWarning)}),a=>a.stop());
  const original=system.call.bind(system);system.call=(op,a,b,c,p,n)=>{if(op>=SYS.STORE_SNAPSHOT&&op<=SYS.STORE_LAST_ERROR_READ)return storage.call(op,a,b,c,p,n,system);if(op===SYS.SAVE_DIALOG){document.querySelector('#storage-dialog').showModal();return 1;}if(op===SYS.PREPARE_GROUP)return assets.prepare(system.text(p,n))?1:0;if(op>=SYS.DECODE_CREATE&&op<=SYS.DECODE_CLOSE)return assets.call(op,a,b,c,p,n);if(op>=SYS.AUDIO_INIT&&op<=SYS.AUDIO_PLAYING)return audio.call(op,a,p,n);if(op===SYS.FONTS_READY){if(document.fonts.status!=='loaded')throw new Error('Fonts are not ready');return document.fonts.size;}if(op===SYS.FONT_FAMILY){const [name]=system.text(p,n).split('\n');text.families.set(name,name==='PT Serif'?'Golub Serif':name);return 1;}return original(op,a,b,c,p,n);};
  input=scope.own(new InputHost(canvas,system),i=>i.destroy());system.restoreLocalFiles();
  if(gameMode)document.querySelector('#brand').textContent='Голубь · Wasm';
  if(gameMode)await scope.wait(assets.initializeCatalog(new URL('./catalog.json',import.meta.url)));
  const configuration=query.get('configuration')==='Debug'?'Debug':'Release',moduleUrl=`./${configuration}/engine.wasm`;
  runtime=await scope.wait(createRuntime(await scope.wait(fetchVerified(moduleUrl,releaseHash(moduleUrl),{signal:scope.signal})),{host:{gfx:glHost.call.bind(glHost),system:system.call.bind(system),now:()=>performance.now()/1000,text:text.call.bind(text)},log:s=>console.log(s)}).then(r=>scope.own(r,value=>value.call('shutdown'))));runtime.initialize();
  let bootResult;
  if(gameMode){const level=new TextEncoder().encode(query.get('level')||''),p=runtime.call('allocate',level.length);new Uint8Array(runtime.memory.buffer,p,level.length).set(level);bootResult=runtime.call('boot_game',p,level.length,testMode?(query.has('persist')?2:3):0);runtime.call('deallocate',p);}else if(query.get('showcase')==='1')bootResult=runtime.call('boot_showcase',testMode?1:0);else bootResult=runtime.call('boot',query.get('fixed')==='1'?1:0);
  if(bootResult!==1)throw pascalError();
  input.logicalWidth=runtime.call('logical_width');input.logicalHeight=runtime.call('logical_height');
  first=true;running=false;status.textContent=gameMode?'Загрузка ресурсов…':'Витрина движка · игровой перенос продолжается';
  window.engineApp={runtime,gl:glHost.gl,graphics:glHost,system,input,assets,audio,storage,text,tick,state,resize,stop(){running=false;cancelAnimationFrame(request);},restart};
  window.engineBooted=true;
  if(needsStart){
   while(true){
    if(window.engineFailure)throw new Error(window.engineFailure);
    if(!glHost.lost){const ready=runtime.call('prepare_startup');if(ready<0)throw pascalError();if(ready===1)break;}
    await scope.wait(new Promise(resolve=>requestAnimationFrame(resolve)));
   }
   await scope.wait(document.fonts.ready);await scope.wait(document.fonts.load('italic 36px "Golub Serif"'));await scope.wait(document.fonts.load('400 18px Rubik'));
   loadingProgress({completed:1,total:1});document.querySelector('#loading').hidden=true;window.engineStartupReady=true;showStart();
   await scope.wait(startPromise);if(startContext?.state!=='closed')audio.context=startContext;await scope.wait(audio.enable().catch(scope.guard(audioWarning)));
   input.blur();if(runtime.call('present_game')!==1)throw pascalError();
  }
  hideStart();canvas.focus();running=true;window.engineReady=true;window.engineStarted=!testMode;if(!testMode)request=requestAnimationFrame(scope.guard(frame));
 }catch(e){if(!scope.closed){error(e);dispose();}}
}
function dispose(){running=false;cancelAnimationFrame(request);for(const error of scope.close()||[])console.warn('Session cleanup: '+error.message);}
function visibility(){resourceAt=0;resourceCPU=0;resourceFrames=0;if(!runtime||scope.closed)return;input.blur();runtime.call('suspend',performance.now()/1000);audio.visibility(document.hidden).catch(scope.guard(audioWarning));first=true;cancelAnimationFrame(request);if(!document.hidden&&running&&!testMode)request=requestAnimationFrame(scope.guard(frame));}
return {boot,dispose,resize,visibility,get storage(){return storage;},get graphics(){return glHost;}};
}
document.querySelector('#storage-dialog').addEventListener('keydown',event=>event.stopPropagation());
document.querySelector('#storage-dialog').addEventListener('close',()=>canvas.focus());
new ResizeObserver(()=>activeSession?.resize()).observe(canvas.parentElement);
document.addEventListener('visibilitychange',()=>activeSession?.visibility());
document.querySelector('#restart').addEventListener('click',()=>void restartGame());
document.querySelector('#export').addEventListener('click',()=>{try{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([activeSession.storage.export()],{type:'application/json'}));a.href=url;a.download='golub-play-v2-saves.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){document.querySelector('#storage').textContent='Не удалось экспортировать сохранения. '+error.message;}});
document.querySelector('#import').addEventListener('change',async event=>{try{const file=event.target.files[0];if(file){await activeSession.storage.importFile(await file.text());document.querySelector('#storage').textContent='Копия добавлена. Перезапустите игру, чтобы обновить меню.';}}catch(e){document.querySelector('#storage').textContent=e.message;}event.target.value='';});
document.querySelector('#legacy').addEventListener('click',async()=>{try{const count=await importLegacy(activeSession.storage);document.querySelector('#storage').textContent=`Добавлено записей: ${count}. Перезапустите игру, чтобы обновить меню.`;}catch(e){document.querySelector('#storage').textContent=e.message;}});
void restartGame();
