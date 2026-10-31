import { createRuntime } from './wasm-runtime.mjs';
import { Resampler } from './resampler.mjs';
export async function createProducer({ port, module, sampleRate, audioOrigin, targetMs=60, lowMs=40, emit = () => {} }) {
  const response = await fetch(module);
  if (!response.ok) throw new Error(`PCM HTTP ${response.status}`);
  const runtime = await createRuntime(await response.arrayBuffer(), { log() {} }); runtime.initialize(); runtime.call('reset', 0);
  const resampler = new Resampler(44100, sampleRate);
  let produced = 0, played = 0, started = false, stopped = false, paused=false,pumping = false, lastReport = 0;
  let feedback = { queued: 0, underrunFrames: 0, overflowFrames: 0 },commandSequence=0;
  const markers = [], latencies = [], production = [], queueDepth = [], history = [];
  let bucketMin=Infinity,bucketMax=0,minimumQueue=Infinity,maximumQueue=0;
  const target = Math.ceil(sampleRate * targetMs/1000), low = Math.ceil(sampleRate * lowMs/1000), high = Math.ceil(sampleRate * 0.08), hardMax = Math.ceil(sampleRate * 0.1);
  const absoluteNow = () => performance.timeOrigin + performance.now();
  function pump() {
    if (stopped || paused || pumping) return;
    if(started&&produced-played>=low)return;
    pumping = true;
    try {
      let iterations = 0;
      while (produced - played < target && produced-played < high && iterations++ < 8) {
        const start = performance.now(), ptr = runtime.call('mix', 512);
        if (!ptr) throw new Error('PCM producer rejected block');
        const samples = resampler.process(new Float32Array(runtime.memory.buffer, ptr, 512));
        if (produced - played + samples.length > hardMax) throw new Error('PCM queue hard maximum exceeded');
        const events = markers.splice(0).map(marker => ({ ...marker, offset: 1 }));
        produced += samples.length;
        port.postMessage({ type: 'pcm', samples: samples.buffer, markers: events }, [samples.buffer]);
        production.push(performance.now() - start);
        if (production.length > 4000) production.shift();
      }
      if (!started && produced - played >= target) { started = true; port.postMessage({ type: 'start' }); }
    } finally { pumping = false; }
  }
  function report() {
    if(bucketMin!==Infinity){history.push({at:performance.now(),minimumMs:bucketMin,maximumMs:bucketMax});if(history.length>1800)history.shift();bucketMin=Infinity;bucketMax=0;}
    emit({ type: 'stats', sampleRate, sourceRate: 44100, heap: runtime.memory.buffer.byteLength,
      produced, played, queueDepth: [...queueDepth], underrunFrames: feedback.underrunFrames, overflowFrames: feedback.overflowFrames,
      latencies: [...latencies], production: [...production], history:[...history],minimumQueueMs:minimumQueue,maximumQueueMs:maximumQueue,
      outputPeak:feedback.outputPeak,commandSequence,musicToken:runtime.exportNames.includes('music_token')?runtime.call('music_token'):0,
      policy:{targetMs,lowMs,highMs:80,hardMaximumMs:100},started });
  }
  port.onmessage = ({ data }) => {
    if (data.type === 'feedback') {
      played = data.played; feedback = data;
      const milliseconds=data.queued*1000/sampleRate;
      if(data.started){bucketMin=Math.min(bucketMin,milliseconds);bucketMax=Math.max(bucketMax,milliseconds);minimumQueue=Math.min(minimumQueue,milliseconds);maximumQueue=Math.max(maximumQueue,milliseconds);}
      queueDepth.push(data.queued * 1000 / sampleRate); if (queueDepth.length > 4000) queueDepth.shift();
      pump();
      if (performance.now() - lastReport > 500) { lastReport = performance.now(); report(); }
    } else if (data.type === 'played') {
      const latency = audioOrigin + data.audioTime * 1000 - data.acceptedAt;
      latencies.push({ sequence: data.sequence, milliseconds: latency });
      if (latencies.length > 2000) latencies.shift();
    }
  };
  port.start(); pump();
  const timer = setInterval(pump, 5);
  return {
    command(op,bytes,sequence,acceptedAt=absoluteNow()){
      const ptr=runtime.call('allocate',bytes.byteLength);
      try{new Uint8Array(runtime.memory.buffer,ptr,bytes.byteLength).set(new Uint8Array(bytes));if(runtime.call('command',op,ptr,bytes.byteLength)!==1)throw new Error(runtime.text(runtime.call('error_ptr'),runtime.call('error_len')));}finally{runtime.call('deallocate',ptr);}
      commandSequence=sequence;if(op===1||op===2)markers.push({sequence,acceptedAt});pump();
    },
    pause(value,origin){paused=value;if(origin!==undefined)audioOrigin=origin;if(!paused)pump();},
    effect(sequence, acceptedAt = absoluteNow()) { runtime.call('effect'); markers.push({ sequence, acceptedAt }); pump(); },
    report,
    stop() { stopped = true; clearInterval(timer); port.postMessage({ type: 'stop' }); report(); port.close(); },
  };
}
