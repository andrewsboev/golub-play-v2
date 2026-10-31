import {createRuntime} from './wasm-runtime.mjs';
import {WebGLHost} from './webgl.mjs';
import {SystemHost} from './system.mjs';
import {InputHost} from './input.mjs';
import {TextHost} from './text.mjs';
import {AssetHost} from './assets.mjs';
import {AudioHost} from './audio.mjs';
import {VersionedStore} from './storage.mjs';
const canvas=document.querySelector('#game'),status=document.querySelector('#status'),errorBox=document.querySelector('#error'),query=new URLSearchParams(location.search);
let runtime,glHost,system,input,assets,audio,storage,request=0,running=false,inFrame=false,first=true;
const testMode=query.get('test')==='1';
function error(error){running=false;cancelAnimationFrame(request);errorBox.hidden=false;errorBox.textContent='Не удалось продолжить работу.\n'+error.message;document.querySelector('#restart').hidden=false;status.textContent='Ошибка';window.engineFailure=error.message;}
function resize(){const rect=canvas.parentElement.getBoundingClientRect(),ratio=devicePixelRatio||1,w=Math.max(1,Math.round(rect.width*ratio)),h=Math.max(1,Math.round(rect.height*ratio));if(w!==canvas.width||h!==canvas.height){canvas.width=w;canvas.height=h;if(runtime)runtime.call('resize');}}
function pascalError(){return new Error(runtime.text(runtime.call('error_ptr'),runtime.call('error_len'))||'Pascal engine failed');}
function tick(now){
 if(glHost.lost)return state();
 if(inFrame)throw new Error('Reentrant frame callback');inFrame=true;
 try{if(first){runtime.call('suspend',now);first=false;}input.flush(runtime);const result=runtime.call('frame',now);if(result<0)throw pascalError();if(!result)running=false;return state();}finally{inFrame=false;}
}
function state(){const p=runtime.call('state_ptr');return JSON.parse(runtime.text(p,runtime.call('state_len')));}
function frame(timestamp){if(!running||document.hidden)return;try{const s=tick(timestamp/1000);if(s.title||s.game||s.dive)status.textContent='Голубь · предварительная версия';if(query.has('debug'))document.querySelector('#diagnostics').textContent=`${glHost.stats.draws} draw calls · ${glHost.stats.vertices} вершин · ${(glHost.stats.gpuBytes/1048576).toFixed(1)} МиБ текстур`;if(running)request=requestAnimationFrame(frame);}catch(e){error(e);}}
async function boot(){
 try{
  errorBox.hidden=true;window.engineFailure=null;resize();
  const memory=()=>{if(!runtime)throw new Error('Runtime memory is not initialized');return runtime.memory;};
  storage=await new VersionedStore({onState:(s,message)=>{document.querySelector('#storage').textContent=message||(s==='ready'?'':s==='opening'?'Открываем сохранения…':'');}}).open();
  const shaders=await fetch('./shaders.json').then(r=>r.ok?r.json():{});
  glHost=new WebGLHost(canvas,memory,{shaders,onError:error,restoreAsset:(id,path)=>assets.restoreTexture(id,path),onLost(){cancelAnimationFrame(request);assets?.contextLost();input?.blur();if(runtime)runtime.call('suspend',performance.now()/1000);status.textContent='Восстановление графики…';},onRestored(){assets?.finishRestore();input?.blur();if(runtime)runtime.call('suspend',performance.now()/1000);first=true;status.textContent='Графика восстановлена';if(running&&!testMode)request=requestAnimationFrame(frame);}});system=new SystemHost(canvas,memory,{onError:error});const text=new TextHost(memory);
  assets=new AssetHost(system,glHost,{configuration:query.get('configuration')==='Debug'?'Debug':'Release',onProgress:s=>status.textContent='Загрузка ресурсов…'});
  audio=new AudioHost(memory,{configuration:query.get('configuration')==='Debug'?'Debug':'Release',onState:s=>document.querySelector('#sound').textContent=s,onError:error});
  const original=system.call.bind(system);system.call=(op,a,b,c,p,n)=>{if(op>=70&&op<=75)return storage.call(op,a,b,c,p,n,system);if(op>=50&&op<=56)return assets.call(op,a,b,c,p,n);if(op>=60&&op<=64)return audio.call(op,a,p,n);if(op===40){if(document.fonts.status!=='loaded')throw new Error('Fonts are not ready');return document.fonts.size;}if(op===41){const [name]=system.text(p,n).split('\n');text.families.set(name,name==='PT Serif'?'Golub Serif':name);return 1;}return original(op,a,b,c,p,n);};
  input=new InputHost(canvas,system);system.restoreLocalFiles();
  const gameMode=query.get('game')==='1';
  if(gameMode)document.querySelector('#brand').textContent='Голубь · Wasm';
  if(gameMode)await assets.initializeCatalog(new URL('./catalog.json',import.meta.url));
  const configuration=query.get('configuration')==='Debug'?'Debug':'Release',response=await fetch(`./${configuration}/engine.wasm`);if(!response.ok)throw new Error('HTTP '+response.status);
  runtime=await createRuntime(await response.arrayBuffer(),{host:{gfx:glHost.call.bind(glHost),system:system.call.bind(system),now:()=>performance.now()/1000,text:text.call.bind(text)},log:s=>console.log(s)});runtime.initialize();
  let bootResult;
  if(gameMode){const level=new TextEncoder().encode(query.get('level')||''),p=runtime.call('allocate',level.length);new Uint8Array(runtime.memory.buffer,p,level.length).set(level);bootResult=runtime.call('boot_game',p,level.length,testMode?(query.has('persist')?2:3):0);runtime.call('deallocate',p);}else bootResult=runtime.call('boot',query.get('fixed')==='1'?1:0);
  if(bootResult!==1)throw pascalError();
  input.logicalWidth=runtime.call('logical_width');input.logicalHeight=runtime.call('logical_height');
  first=true;running=true;status.textContent=gameMode?'Загрузка ресурсов…':'Витрина движка · игровой перенос продолжается';
  window.engineApp={runtime,gl:glHost.gl,graphics:glHost,system,input,assets,audio,storage,tick,state,resize,stop(){running=false;cancelAnimationFrame(request);},async restart(){running=false;cancelAnimationFrame(request);input.destroy();runtime.call('shutdown');audio.stop();storage.close();runtime=null;await boot();}};
  window.engineReady=true;if(!testMode)request=requestAnimationFrame(frame);
 }catch(e){error(e);}
}
new ResizeObserver(resize).observe(canvas.parentElement);
document.addEventListener('visibilitychange',()=>{if(!runtime)return;input.blur();runtime.call('suspend',performance.now()/1000);audio.visibility(document.hidden).catch(error);first=true;cancelAnimationFrame(request);if(!document.hidden&&running&&!testMode)request=requestAnimationFrame(frame);});
document.querySelector('#restart').addEventListener('click',()=>window.engineApp?.restart());
document.querySelector('#export').addEventListener('click',()=>{const a=document.createElement('a'),url=URL.createObjectURL(new Blob([storage.export()],{type:'application/json'}));a.href=url;a.download='golub-play-v2-saves.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
document.querySelector('#import').addEventListener('change',async event=>{try{const file=event.target.files[0];if(file){await storage.importFile(await file.text());document.querySelector('#storage').textContent='Копия добавлена. Перезапустите игру, чтобы обновить меню.';}}catch(e){document.querySelector('#storage').textContent=e.message;}event.target.value='';});
document.querySelector('#legacy').addEventListener('click',async()=>{try{const count=await storage.importLegacy();document.querySelector('#storage').textContent=`Добавлено записей: ${count}. Перезапустите игру, чтобы обновить меню.`;}catch(e){document.querySelector('#storage').textContent=e.message;}});
await boot();
