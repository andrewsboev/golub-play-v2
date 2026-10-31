import { createRuntime } from './wasm-runtime.mjs';
import { Resampler } from './resampler.mjs';
export async function createProducer({ port, module, sampleRate, audioOrigin, emit = () => {} }) {
  const response = await fetch(module);
  if (!response.ok) throw new Error(`PCM HTTP ${response.status}`);
  const runtime = await createRuntime(await response.arrayBuffer(), { log() {} }); runtime.initialize(); runtime.call('reset', 0);
  const resampler = new Resampler(44100, sampleRate);
  let produced = 0, played = 0, started = false, stopped = false, pumping = false, lastReport = 0;
  let feedback = { queued: 0, underrunFrames: 0, overflowFrames: 0 };
  const markers = [], latencies = [], production = [], queueDepth = [];
  const target = Math.ceil(sampleRate * 0.04), hardMax = Math.ceil(sampleRate * 0.1);
  const absoluteNow = () => performance.timeOrigin + performance.now();
  function pump() {
    if (stopped || pumping) return;
    pumping = true;
    try {
      let iterations = 0;
      while (produced - played < target && iterations++ < 8) {
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
    emit({ type: 'stats', sampleRate, sourceRate: 44100, heap: runtime.memory.buffer.byteLength,
      produced, played, queueDepth: [...queueDepth], underrunFrames: feedback.underrunFrames, overflowFrames: feedback.overflowFrames,
      latencies: [...latencies], production: [...production], started });
  }
  port.onmessage = ({ data }) => {
    if (data.type === 'feedback') {
      played = data.played; feedback = data;
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
    effect(sequence, acceptedAt = absoluteNow()) { runtime.call('effect'); markers.push({ sequence, acceptedAt }); pump(); },
    report,
    stop() { stopped = true; clearInterval(timer); port.postMessage({ type: 'stop' }); report(); port.close(); },
  };
}
