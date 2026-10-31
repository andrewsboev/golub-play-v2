import { createProducer } from './audio-producer.mjs';
export const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] : null;
export async function startAudio({ candidate = 'worker', requestedRate = 48000, configuration = 'Release', onStats = () => {} } = {}) {
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error('AudioContext недоступен в этом браузере');
  const context = new AudioContextClass({ sampleRate: requestedRate, latencyHint: 'interactive' });
  await context.resume(); await context.audioWorklet.addModule(new URL('./audio-sink.mjs', import.meta.url));
  const sink = new AudioWorkletNode(context, 'golub-pcm-sink', { numberOfOutputs: 1, outputChannelCount: [1] });
  const volume = context.createGain(); volume.gain.value = 0.08; sink.connect(volume).connect(context.destination);
  const audioOrigin = performance.timeOrigin + performance.now() - context.currentTime * 1000;
  const options = { port: sink.port, module: new URL(`./${configuration}/pcm.wasm`, import.meta.url).href,
    sampleRate: context.sampleRate, audioOrigin };
  let worker, producer, latest, sequence = 0, failure, latestAt = performance.now();
  const receive = data => { if (data.type === 'stats') { latest = data; latestAt=performance.now(); onStats(data); } };
  try {
    if (candidate === 'main') producer = await createProducer({ ...options, emit: receive });
    else {
      worker = new Worker(new URL('./audio-worker.mjs', import.meta.url), { type: 'module' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('audio worker initialization timeout')), 30000);
        worker.onmessage = ({ data }) => {
          if (data.type === 'ready') { clearTimeout(timer); resolve(); }
          else if (data.type === 'error') { clearTimeout(timer); failure=new Error(data.error); reject(failure); }
          else receive(data);
        };
        worker.onerror = error => { error.preventDefault(); clearTimeout(timer); failure=new Error(error.message); reject(failure); };
        worker.postMessage({ type: 'init', ...options }, [sink.port]);
      });
    }
  } catch (error) { worker?.terminate(); sink.disconnect(); await context.close(); throw error; }
  return {
    context,
    assertHealthy() { if(failure)throw failure;if(performance.now()-latestAt>2500)throw new Error('Audio feedback stopped'); },
    effect() {
      const acceptedAt = performance.timeOrigin + performance.now();
      if (worker) worker.postMessage({ type: 'effect', sequence: ++sequence, acceptedAt });
      else producer.effect(++sequence, acceptedAt);
    },
    get stats() { return latest; },
    async stop() {
      if (worker) worker.postMessage({ type: 'report' }); else producer.report();
      await new Promise(resolve => setTimeout(resolve, 80));
      if (worker) { worker.postMessage({ type: 'stop' }); worker.terminate(); } else producer.stop();
      sink.disconnect(); await context.close();
      return { ...latest, candidate, requestedRate, actualRate: context.sampleRate,
        baseLatency: context.baseLatency ?? null, outputLatency: context.outputLatency ?? null,
        latencyDefinition: 'accepted main-thread event to tagged sample in worklet output clock; hardware outputLatency reported separately; marker uncertainty <=2 source samples',
        p95LatencyMs: percentile(latest?.latencies?.map(e => e.milliseconds) || [], 0.95) };
    },
  };
}
