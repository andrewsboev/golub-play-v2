// Stage 1 host: only the WASI services needed by the FPC RTL, with no filesystem.
// Every memory view is acquired on demand: Pascal allocations can grow memory.
export async function createRuntime(bytes, { host = {}, log = console.log } = {}) {
  let instance, state = 'new';
  const view = () => new DataView(instance.exports.memory.buffer);
  const bytesAt = (ptr, length) => new Uint8Array(instance.exports.memory.buffer, ptr, length);
  const write32 = (ptr, value) => view().setUint32(ptr, value, true);
  const BADF = 8, NOSYS = 52;
  const emptyList = (count, size) => { write32(count, 0); write32(size, 0); return 0; };
  const wasi = {
    args_get: () => 0,
    args_sizes_get: emptyList,
    environ_get: () => 0,
    environ_sizes_get: emptyList,
    random_get(ptr, length) {
      // Web Crypto limits each request to 65536 bytes.
      for (let offset = 0; offset < length; offset += 65536)
        crypto.getRandomValues(bytesAt(ptr + offset, Math.min(65536, length - offset)));
      return 0;
    },
    clock_time_get(clock, _precision, result) {
      if (clock !== 0 && clock !== 1) return 28; // EINVAL
      const nanos = clock === 0 ? BigInt(Date.now()) * 1000000n
        : BigInt(Math.floor(performance.now() * 1000000));
      view().setBigUint64(result, nanos, true);
      return 0;
    },
    fd_write(fd, vectors, count, result) {
      if (fd !== 1 && fd !== 2) return BADF;
      let length = 0;
      const decoder = new TextDecoder();
      let message = '';
      for (let i = 0; i < count; i++) {
        const ptr = view().getUint32(vectors + 8 * i, true);
        const size = view().getUint32(vectors + 8 * i + 4, true);
        message += decoder.decode(bytesAt(ptr, size), { stream: true });
        length += size;
      }
      message += decoder.decode();
      write32(result, length);
      log(message, fd);
      return 0;
    },
    fd_read(fd, _vectors, _count, result) {
      if (fd !== 0) return BADF;
      write32(result, 0); return 0; // stdin EOF
    },
    fd_fdstat_get(fd, result) {
      if (fd < 0 || fd > 2) return BADF;
      bytesAt(result, 24).fill(0);
      view().setUint8(result, 2); // character device
      view().setBigUint64(result + 8, fd === 0 ? 2n : 64n, true);
      return 0;
    },
    fd_close: () => BADF,
    fd_prestat_get: () => BADF,
    fd_prestat_dir_name: () => BADF,
    fd_seek: () => 70, // ESPIPE
    fd_tell: () => 70,
    proc_exit(code) { throw new Error(`FPC proc_exit(${code})`); },
  };
  for (const name of ['fd_filestat_get', 'fd_filestat_set_size', 'fd_filestat_set_times',
    'fd_readdir', 'path_create_directory', 'path_filestat_get', 'path_filestat_set_times',
    'path_open', 'path_readlink', 'path_remove_directory', 'path_rename', 'path_unlink_file',
    'poll_oneoff']) wasi[name] = () => NOSYS;
  const module = await WebAssembly.compile(bytes);
  // Do not silently manufacture imports for an incompatible compiler/RTL.
  const imports = { wasi_snapshot_preview1: wasi, host };
  for (const item of WebAssembly.Module.imports(module)) {
    if (item.kind !== 'function' || typeof imports[item.module]?.[item.name] !== 'function')
      throw new Error(`Unsupported Wasm import: ${item.module}.${item.name} (${item.kind})`);
  }
  instance = await WebAssembly.instantiate(module, imports);
  function initialize() {
    if (state === 'ready') return;
    if (state !== 'new') throw new Error(`Cannot initialize FPC in state ${state}`);
    state = 'initializing';
    try { instance.exports._initialize(); state = 'ready'; }
    catch (error) { state = 'failed'; throw new Error(`FPC initialization: ${error.message}`, { cause: error }); }
  }
  function call(name, ...args) {
    if (state !== 'ready') throw new Error('Initialize FPC before calling exports');
    if (typeof instance.exports[name] !== 'function' || name.startsWith('_'))
      throw new Error(`Invalid FPC export: ${name}`);
    try { return instance.exports[name](...args); }
    catch (error) { state = 'failed'; throw new Error(`FPC export ${name}: ${error.message}`, { cause: error }); }
  }
  return {
    initialize, call, memory: instance.exports.memory,
    text(ptr, length) { return new TextDecoder('utf-8', { fatal: true }).decode(bytesAt(ptr, length)); },
    exportNames: WebAssembly.Module.exports(module).map(({ name }) => name),
  };
}
