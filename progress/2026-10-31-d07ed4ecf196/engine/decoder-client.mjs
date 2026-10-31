export class DecoderClient {
  constructor(configuration = 'Release') {
    if (!['Debug', 'Release'].includes(configuration)) throw new Error('invalid configuration');
    this.configuration = configuration; this.generation = 0; this.sequence = 0; this.active = null; this.queue = [];
    this.discarded = 0; this.queueLimit = 1; this.closed = false;
  }
  async initialize() {
    if (this.worker) throw new Error('worker already initialized');
    this.worker = new Worker(new URL('./decoder-worker.mjs', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.initializationTimer=setTimeout(()=>this.fail(new Error('Decoder initialization timeout')),30000);
    this.worker.onmessage = ({ data }) => this.message(data);
    this.worker.onerror = error => { error.preventDefault(); this.fail(new Error(error.message || 'decoder worker crashed')); };
    this.worker.postMessage({ type: 'init', module: new URL(`./${this.configuration}/decoder.wasm`, import.meta.url).href });
    await this.ready; return this;
  }
  message(data) {
    if (data.type === 'ready') { clearTimeout(this.initializationTimer);this.initialized=true;this.initialHeap = data.heap; this.readyResolve(); return; }
    if(data.type==='error'&&!this.initialized){this.fail(new Error(data.error));return;}
    if (!this.active || data.requestId !== this.active.requestId) return;
    const job = this.active; this.active = null;
    if (data.generation !== this.generation) { this.discarded++; job.reject(new DOMException('Stale generation', 'AbortError')); }
    else if (data.type === 'error') job.reject(new Error(data.error));
    else { data.timings.transferMs = performance.timeOrigin + performance.now() - data.timings.sentAt; job.resolve(data); }
    this.pump();
  }
  decode(entry, compressed) {
    if (this.closed) return Promise.reject(new Error('decoder closed'));
    if (this.queue.length >= this.queueLimit) return Promise.reject(new Error('decoder queue is full'));
    return new Promise((resolve, reject) => {
      this.queue.push({ requestId: ++this.sequence, generation: this.generation, entry, compressed, resolve, reject }); this.pump();
    });
  }
  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    const job = this.queue.shift(); this.active = job;
    this.worker.postMessage({ type: 'decode', requestId: job.requestId, generation: job.generation, expectedHash: job.entry.sha256,
      width: job.entry.width, height: job.entry.height, flags: job.entry.flags || 0, compressed: job.compressed }, [job.compressed]);
  }
  cancelGeneration() {
    this.generation++;
    for (const job of this.queue) job.reject(new DOMException('Cancelled', 'AbortError'));
    this.queue = [];
    // Монолитный decode продолжает работать в worker; результат будет отброшен без доступа к game heap.
  }
  fail(error) {
    clearTimeout(this.initializationTimer);
    this.closed = true; this.readyReject?.(error); this.active?.reject(error); this.active = null;
    for (const job of this.queue) job.reject(error); this.queue = []; this.worker?.terminate();
  }
  close() { this.fail(new Error('decoder terminated')); }
}
