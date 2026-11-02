import { createRuntime } from './wasm-runtime.mjs';
import {fetchVerified} from './release-runtime.mjs';
let runtime, active = false;
self.onmessage = async ({ data }) => {
  if (data.type === 'crash-test') { setTimeout(() => { throw new Error('intentional decoder worker crash'); }, 0); return; }
  const { requestId, generation } = data;
  try {
    if (data.type === 'init') {
      runtime = await createRuntime(await fetchVerified(data.module,data.moduleHash), { log() {} }); runtime.initialize();
      self.postMessage({ type: 'ready', heap: runtime.memory.buffer.byteLength }); return;
    }
    if (data.type !== 'decode' || !runtime || active) throw new Error('worker protocol violation');
    active = true;
    if (!(data.compressed instanceof ArrayBuffer)) throw new Error('expected transferred compressed buffer');
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data.compressed))].map(n => n.toString(16).padStart(2, '0')).join('');
    if (digest !== data.expectedHash) throw new Error('compressed hash mismatch');
    const started = performance.now();
    const ptr = runtime.call('allocate', data.compressed.byteLength);
    if (!ptr) throw new Error('compressed input exceeds allocation limit');
    new Uint8Array(runtime.memory.buffer, ptr, data.compressed.byteLength).set(new Uint8Array(data.compressed));
    const inputCopyMs = performance.now() - started;
    const decodeStart = performance.now();
    const ok = runtime.call('decode', data.flags || 0);
    if (ok !== 1) throw new Error(runtime.text(runtime.call('error_ptr'), runtime.call('error_length')));
    const decodeMs = performance.now() - decodeStart;
    const width = runtime.call('width'), height = runtime.call('height');
    if (width !== data.width || height !== data.height) throw new Error('decoded dimensions mismatch');
    if(data.metadata!==undefined){
      const bytes=data.metadata;
      if(!(bytes instanceof Uint8Array))throw new Error('expected metadata bytes');
      const metadata=runtime.call('allocate',bytes.length);if(!metadata)throw new Error('metadata allocation failed');
      new Uint8Array(runtime.memory.buffer,metadata,bytes.length).set(bytes);
      if(runtime.call('validate_atlas')!==1){
        const diagnostic=JSON.parse(runtime.text(runtime.call('error_ptr'),runtime.call('error_length')));
        diagnostic.path=data.metadataPath||diagnostic.path;
        const error=new Error(`${diagnostic.category}: ${diagnostic.path} ${diagnostic.field}: ${diagnostic.message}`);error.diagnostic=diagnostic;throw error;
      }
    }
    const copyStart = performance.now();
    // Только отдельный буфер transferable, никогда Wasm Memory.buffer.
    const pixels = new Uint8Array(runtime.memory.buffer, runtime.call('pixels'), runtime.call('pixel_length')).slice();
    const mask = new Uint8Array(runtime.memory.buffer, runtime.call('mask_ptr'), runtime.call('mask_length')).slice().buffer;
    const thumb = new Uint8Array(runtime.memory.buffer, runtime.call('thumb_ptr'), runtime.call('thumb_length')).slice().buffer;
    const small = new Uint8Array(runtime.memory.buffer, runtime.call('small_ptr'), runtime.call('small_length')).slice().buffer;
    const resultCopyMs = performance.now() - copyStart;
    const heap = runtime.memory.buffer.byteLength;
    runtime.call('release');
    const heapAfterFree = runtime.memory.buffer.byteLength;
    active = false;
    const sentAt = performance.timeOrigin + performance.now();
    self.postMessage({ type: 'result', requestId, generation, width, height, pixels: pixels.buffer, mask, thumb, small, heap, heapAfterFree,
      timings: { inputCopyMs, decodeMs, resultCopyMs, sentAt } }, [pixels.buffer, mask, thumb, small]);
  } catch (error) {
    active = false;
    if (runtime?.state !== 'failed') { try { runtime?.call('release'); } catch {} }
    self.postMessage({ type: 'error', requestId, generation, error: error.message,diagnostic:error.diagnostic });
  }
};
