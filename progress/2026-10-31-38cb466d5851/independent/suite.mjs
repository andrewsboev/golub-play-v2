// Допуск задан до сравнения: накопление Single/различия x87 и Wasm, не визуальный допуск.
export function compare(actual, expected, path = '') {
  if (typeof expected === 'number' && /^(wave|fluid)/.test(path)) {
    const absolute = path === 'waveVolume' ? 0.05 : path.startsWith('wave') ? 0.0005 : 0.0002;
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > absolute + 0.00002 * Math.abs(expected))
      throw new Error(`${path}: ${actual} != ${expected}`);
  } else if (expected && typeof expected === 'object') {
    if (!actual || JSON.stringify(Object.keys(actual)) !== JSON.stringify(Object.keys(expected))) throw new Error(`${path}: keys differ`);
    for (const key of Object.keys(expected)) compare(actual[key], expected[key], path ? `${path}.${key}` : key);
  } else if (actual !== expected) throw new Error(`${path}: ${actual} != ${expected}`);
}
export async function runSuite(configuration = 'Release') {
  const { createRuntime } = await import('./wasm-runtime.mjs');
  if (!['Debug', 'Release'].includes(configuration)) throw new Error('Invalid configuration');
  const response = await fetch(new URL(`./${configuration}/independent.wasm`, import.meta.url));
  if (!response.ok) throw new Error(`Wasm HTTP ${response.status}`);
  const referenceResponse = await fetch(new URL('./native-reference.json', import.meta.url));
  if (!referenceResponse.ok) throw new Error(`Reference HTTP ${referenceResponse.status}`);
  const expected = await referenceResponse.json();
  const bytes = await response.arrayBuffer();
  const logs = [];
  const runtime = await createRuntime(bytes, { log: message => { logs.push(message); console.info(message); } });
  runtime.initialize();
  const initialMemory = runtime.memory.buffer.byteLength;
  const started = performance.now();
  let actual;
  for (let i = 0; i < 3; i++) {
    const ok = runtime.call('run');
    const output = runtime.text(runtime.call('text_ptr'), runtime.call('text_len'));
    if (ok !== 1) throw new Error(output);
    actual = JSON.parse(output);
    compare(actual, expected);
  }
  console.info(actual.vmLog, actual.vmError);
  return [{ name: 'independent', configuration, status: 'passed', bytes: bytes.byteLength, initialMemory,
    finalMemory: runtime.memory.buffer.byteLength, loadAndTestMs: performance.now() - started,
    modules: ['json', 'webp', 'physics', 'wavefield', 'fluidgrid', 'pigeonscript'],
    fixture: actual, repeats: 3, logs, text: 'Голубь 🕊 · Windows и Wasm: результаты совпали в заданных допусках.' }];
}
