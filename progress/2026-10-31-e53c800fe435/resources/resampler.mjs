// Непрерывная дробная позиция: граница блоков не сбрасывает фазу resampling.
export class Resampler {
  constructor(sourceRate = 44100, targetRate = 48000) {
    if (!(sourceRate > 0 && targetRate > 0)) throw new Error('invalid rate');
    this.ratio = sourceRate / targetRate; this.position = 0; this.previous = new Float32Array(0);
  }
  process(input) {
    const joined = new Float32Array(this.previous.length + input.length); joined.set(this.previous); joined.set(input, this.previous.length);
    const output = new Float32Array(Math.max(0, Math.ceil((joined.length - 1 - this.position) / this.ratio)));
    let count = 0;
    while (this.position < joined.length - 1) {
      const i = Math.floor(this.position), fraction = this.position - i;
      output[count++] = joined[i] + (joined[i + 1] - joined[i]) * fraction;
      this.position += this.ratio;
    }
    const consumed = Math.floor(this.position);
    this.previous = joined.slice(consumed); this.position -= consumed;
    return count === output.length ? output : output.slice(0, count);
  }
}
