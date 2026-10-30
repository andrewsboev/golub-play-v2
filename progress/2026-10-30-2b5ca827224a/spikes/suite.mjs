import { createRuntime } from './wasm-runtime.mjs';

const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const expectedText = 'Голубь 🕊 — café | caught: Голубь';

export async function runSuite(configuration = 'Release') {
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Invalid configuration');
  const results = [];
  for (const name of ['compute', 'runtime', 'callbacks']) {
    const response = await fetch(new URL(`./${configuration}/${name}.wasm`, import.meta.url));
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const started = performance.now();
    let finishCallback;
    const callback = new Promise((resolve) => {
      finishCallback = resolve;
    });
    let runtime;
    runtime = await createRuntime(bytes, {
      host: {
        schedule(token) {
          setTimeout(() => {
            try {
              runtime.call('complete', token);
              finishCallback({});
            } catch (error) {
              finishCallback({ error });
            }
          }, 0);
        },
      },
      log(message) {
        console.info(`[${name}/RTL] ${message}`);
      },
    });
    let rejected = false;
    try {
      runtime.call('init_count');
    } catch {
      rejected = true;
    }
    check(rejected, 'uninitialized call was accepted');
    runtime.initialize();
    runtime.initialize();
    check(runtime.call('init_count') === 1, 'RTL initialized more than once');
    const initialMemory = runtime.memory.buffer.byteLength;
    let text = '';
    if (name === 'compute') {
      check(runtime.call('add_i32', -17, 59) === 42, 'i32 ABI');
      check(runtime.call('scale_f32', 1.5, 2.5) === Math.fround(3.75), 'f32 ABI');
      check(runtime.call('scale_f32', 1 / 3, 1) === Math.fround(1 / 3), 'f32 rounding');
      const failing = await createRuntime(bytes, { log() {} });
      failing.initialize();
      let message = '';
      try {
        failing.call('exit_with_error');
      } catch (error) {
        message = error.message;
      }
      check(message.includes('FPC export exit_with_error: FPC proc_exit(7)'), 'fatal error was not reported');
      message = '';
      try {
        failing.initialize();
      } catch (error) {
        message = error.message;
      }
      check(message.includes('state failed'), 'failed runtime was reinitialized');
    } else if (name === 'runtime') {
      const readText = () => runtime.text(runtime.call('text_ptr'), runtime.call('text_len'));
      check(runtime.call('run') === 1, readText());
      text = readText();
      check(text === expectedText, `UTF-8 mismatch: ${text}`);
      check(runtime.call('fail') === -1, 'expected error did not return failure');
      check(readText() === 'expected failure: Голубь', 'exception message was lost');
      const oldBuffer = runtime.memory.buffer;
      check(runtime.call('grow_heap') === 42, 'GetMem/FreeMem after grow');
      check(oldBuffer !== runtime.memory.buffer, 'memory.grow was not exercised');
      check(readText() === 'expected failure: Голубь', 'stale host memory view');
      for (let i = 0; i < 20; i++) check(runtime.call('run') === 1, readText());
      check(readText() === expectedText, 'runtime failed after repeated exceptions');
    } else {
      check(runtime.call('call_count') === 0, 'unexpected callback');
      runtime.call('start', 314159);
      check(runtime.call('call_count') === 0, 'callback ran synchronously');
      let timer;
      const completed = await Promise.race([
        callback,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('callback timeout')), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (completed.error) throw completed.error;
      check(runtime.call('value') === 314159 && runtime.call('call_count') === 1, 'callback ABI');
    }
    check(runtime.call('init_count') === 1, 'callback/error reinitialized RTL');
    results.push({
      name,
      configuration,
      status: 'passed',
      bytes: bytes.byteLength,
      initialMemory,
      finalMemory: runtime.memory.buffer.byteLength,
      loadAndTestMs: Math.round((performance.now() - started) * 100) / 100,
      exports: runtime.exportNames,
      text,
    });
  }
  return results;
}
