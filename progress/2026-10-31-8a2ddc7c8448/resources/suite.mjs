import { DecoderClient } from './decoder-client.mjs';
import { uploadPixels, drawTexture } from './upload.mjs';
import { startAudio, percentile } from './audio-test.mjs';
import { createRuntime } from './wasm-runtime.mjs';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const readJson = async file => { const r = await fetch(new URL(file, import.meta.url)); check(r.ok, `${file}: HTTP ${r.status}`); return r.json(); };
const bytes = async file => { const r = await fetch(new URL(file, import.meta.url)); check(r.ok, `${file}: HTTP ${r.status}`); return r.arrayBuffer(); };
const digest = async data => [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2,'0')).join('');
const adler = buffer => {
  let a = 1, b = 0; for (const value of new Uint8Array(buffer)) { a = (a + value) % 65521; b = (b + a) % 65521; }
  return ((b * 65536 + a) >>> 0).toString(16).padStart(8,'0').toUpperCase();
};
export async function decoderChecks(configuration, canvas, update = () => {}) {
  const assets = await readJson('test-assets.json'), reference = await readJson('native-reference.json');
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
  check(gl, 'WebGL2 недоступен');
  const reports = []; let client = await new DecoderClient(configuration).initialize();
  const small = assets.find(a => a.path === 'ui/cursor.webp');
  try {
    for (const entry of assets) {
      update(`Декодирование ${entry.path}…`);
      const compressed = await bytes(entry.url);
      const job = client.decode(entry, compressed);
      check(compressed.byteLength === 0, 'compressed buffer was not detached');
      const result = await job;
      const native = reference.find(r => r.path === entry.path);
      for (const key of ['pixels','mask','small']) check(adler(result[key]) === native[key], `${entry.path}: ${key} differs from native`);
      const thumb = new Float32Array(result.thumb);
      native.thumb.forEach((value,i) => check(Math.abs(value-thumb[i]) < 0.000001, 'thumbnail differs from native'));
      const uploaded = await uploadPixels(gl,result); drawTexture(gl,uploaded.texture); gl.deleteTexture(uploaded.texture);
      reports.push({ path: entry.path, width:result.width,height:result.height, heap:result.heap, heapAfterFree:result.heapAfterFree,
        transferredBytes: result.pixels.byteLength+result.mask.byteLength+result.thumb.byteLength+result.small.byteLength,
        nativePixels:'passed', nativePreparation:'passed', gpuReadback:'passed', timings:{...result.timings,allocationMs:uploaded.allocationMs,
          uploadP95Ms:percentile(uploaded.portions,0.95),uploadWorstMs:Math.max(...uploaded.portions),portions:uploaded.portions.length}, flags:entry.flags });
    }
    // Ошибка decoder (hash валиден), ошибка hash и повторная загрузка.
    const invalid = new Uint8Array([1,2,3,4]).buffer;
    const corrupt = { ...small, sha256:await digest(invalid) };
    let rejected = false; try { await client.decode(corrupt,invalid); } catch { rejected=true; } check(rejected,'corrupt image accepted');
    rejected=false; try { await client.decode({...small,sha256:'0'.repeat(64)},await bytes(small.url)); } catch { rejected=true; } check(rejected,'wrong hash accepted');
    const large = assets[0];
    const stale = client.decode(large,await bytes(large.url));
    const staleResult = stale.then(()=>false,error=>error.name==='AbortError'); client.cancelGeneration();
    check(await staleResult,'cancelled generation leaked result'); check(client.discarded===1,'stale result was not discarded');
    const reload=await client.decode(small,await bytes(small.url)); check(reload.width===small.width,'reload failed');
    // Прерывание собственного worker — активный Promise обязан завершиться отказом.
    const stopped=client.decode(large,await bytes(large.url)); const stopResult=stopped.then(()=>false,()=>true); client.close(); check(await stopResult,'termination did not reject pending job');
    client=await new DecoderClient(configuration).initialize();
    client.worker.postMessage({type:'crash-test'});
    for(let i=0;i<100&&!client.closed;i++) await new Promise(resolve=>setTimeout(resolve,10));
    check(client.closed,'worker crash was not handled');
    client=await new DecoderClient(configuration).initialize(); await client.decode(small,await bytes(small.url));
    return {status:'passed',configuration,reports,maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),faults:{corrupt:'passed',wrongHash:'passed',cancel:'passed',reload:'passed',termination:'passed',crash:'passed'}};
  } finally {client.close();}
}
export async function pcmParity(configuration) {
  const runtime=await createRuntime(await bytes(`${configuration}/pcm.wasm`),{log(){}}); runtime.initialize(); runtime.call('reset',1);
  const expected=new Float32Array(await bytes('native-reference.pcm'));
  let maxDifference=0,sumSquares=0;
  for(let start=0;start<expected.length;start+=1024){
    const ptr=runtime.call('mix',1024),samples=new Float32Array(runtime.memory.buffer,ptr,1024);
    for(let i=0;i<Math.min(1024,expected.length-start);i++){
      // Native MixOffline intentionally quantizes as waveOut; compare equivalent quantization.
      const value=Math.round(samples[i]*32000)/32000;
      maxDifference=Math.max(maxDifference,Math.abs(value-expected[start+i])); sumSquares+=value*value;
    }
  }
  check(maxDifference<=0.0002,`PCM native/Wasm difference ${maxDifference}`);
  return {status:'passed',samples:expected.length,maxDifference,rms:Math.sqrt(sumSquares/expected.length),heap:runtime.memory.buffer.byteLength,tolerance:0.0002};
}
export async function runResourceSuite({configuration='Release',durationMs=15000,full=false,canvas,update=()=>{},onStats=()=>{}}) {
  check(['Debug','Release'].includes(configuration),'invalid configuration');
  const started=performance.now(),audioReports=[],latencies=[];
  let audio=await startAudio({candidate:'worker',requestedRate:48000,configuration,onStats});
  let hidden=false; const visibility=()=>{if(document.hidden)hidden=true;}; document.addEventListener('visibilitychange',visibility);
  const effectTimer=setInterval(()=>audio?.effect(),300);
  let loadCount=0;
  const loadTimer=setInterval(()=>{const end=performance.now()+50;while(performance.now()<end){}loadCount++;},1000);
  let decoder,pcm;
  try {
    decoder=await decoderChecks(configuration,canvas,update); pcm=await pcmParity(configuration);
    const audioStarted=performance.now();
    while(performance.now()-audioStarted<durationMs){
      update(`Звук: ${Math.ceil((durationMs-(performance.now()-audioStarted))/1000)} с; оставьте вкладку на экране.`);
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    audioReports.push(await audio.stop()); audio=null;
    clearInterval(loadTimer);
    // Другая частота и main-thread candidate — отдельные короткие прогоны, не 10-минутная приёмка.
    for(const [candidate,rate] of [['worker',44100],['main',48000]]){
      audio=await startAudio({candidate,requestedRate:rate,configuration,onStats});
      for(let i=0;i<12;i++){
        audio.effect(); await new Promise(resolve=>setTimeout(resolve,250));
        if(candidate==='main'){const end=performance.now()+50;while(performance.now()<end){}}
      }
      audioReports.push(await audio.stop());audio=null;
    }
  } finally {clearInterval(effectTimer);clearInterval(loadTimer);document.removeEventListener('visibilitychange',visibility);if(audio)await audio.stop();}
  const selected=audioReports[0];
  check(!selected.overflowFrames,'audio exceeded hard queue limit');
  check(selected.latencies?.length>0,'no event-to-worklet latency measurements');
  const audioPassed=selected.underrunFrames===0&&selected.p95LatencyMs<=100&&!hidden;
  const budget=await readJson('resource-budget.json');
  return {schemaVersion:1,status:audioPassed?'passed':'needs-attention',checkedAt:new Date().toISOString(),configuration,full,
    durationMs:performance.now()-started,foreground:!hidden,loadCount,decoder,pcm,audio:audioReports,
    tenMinuteAudioPassed:full&&durationMs>=600000&&audioPassed,
    a1Complete:false,stage3Allowed:false,
    resourceBudget:budget.scenarios.map(s=>({id:s.id,cpuBytesWithReserve:s.cpuBytesWithReserve,gpuBytesWithReserve:s.gpuBytesWithReserve,profiles:s.profiles})),
    pending:['Бюджеты наземных ресурсов пока превышены; группы предварительные.','Результат телефона требуется для A1; desktop не заменяет телефон.','Полная приёмка Safari/A0 остаётся отдельной.'],
    device:{userAgent:navigator.userAgent,platform:navigator.platform,hardwareConcurrency:navigator.hardwareConcurrency,deviceMemory:navigator.deviceMemory??null,devicePixelRatio,screen:{width:screen.width,height:screen.height}}};
}
