class PcmSink extends AudioWorkletProcessor {
  constructor() {
    super(); this.blocks = []; this.offset = 0; this.queued = 0; this.started = false; this.played = 0;
    this.underrunFrames = 0; this.overflowFrames = 0; this.markers = []; this.ticks = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'pcm') {
        const samples = new Float32Array(data.samples);
        if (this.queued + samples.length > Math.ceil(sampleRate * 0.1)) { this.overflowFrames += samples.length; return; }
        this.blocks.push(samples); this.queued += samples.length;
        for (const marker of data.markers || []) this.markers.push({ ...marker, at: this.played + this.queued - samples.length + marker.offset });
      } else if (data.type === 'start') this.started = true;
      else if (data.type === 'stop') this.started = false;
    };
  }
  process(inputs, outputs) {
    const output = outputs[0][0]; output.fill(0);
    if (this.started) for (let i = 0; i < output.length; i++) {
      if (this.queued) {
        output[i] = this.blocks[0][this.offset++]; this.queued--; this.played++;
        if (this.offset === this.blocks[0].length) { this.blocks.shift(); this.offset = 0; }
      } else this.underrunFrames++;
      while (this.markers.length && this.markers[0].at <= this.played) {
        const marker = this.markers.shift();
        this.port.postMessage({ type: 'played', sequence: marker.sequence, acceptedAt: marker.acceptedAt,
          audioTime: currentTime + i / sampleRate, playedSample: this.played });
      }
    }
    if (++this.ticks % 2 === 0) this.port.postMessage({ type: 'feedback', queued: this.queued, played: this.played,
      audioTime: currentTime, underrunFrames: this.underrunFrames, overflowFrames: this.overflowFrames, started: this.started });
    return true;
  }
}
registerProcessor('golub-pcm-sink', PcmSink);
