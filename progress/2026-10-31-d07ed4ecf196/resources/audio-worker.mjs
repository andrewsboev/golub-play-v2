import { createProducer } from './audio-producer.mjs';
let producer;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      producer = await createProducer({ ...data, emit: value => self.postMessage(value) });
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'effect') producer.effect(data.sequence, data.acceptedAt);
    else if (data.type === 'stop') producer.stop();
    else if (data.type === 'report') producer.report();
  } catch (error) { self.postMessage({ type: 'error', error: error.message }); }
};
