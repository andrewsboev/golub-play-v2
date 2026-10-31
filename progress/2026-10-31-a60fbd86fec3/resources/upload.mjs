export async function uploadPixels(gl, result, { sliceBytes = 256 * 1024 } = {}) {
  if (Math.max(result.width, result.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('texture exceeds MAX_TEXTURE_SIZE');
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const allocationStart = performance.now(); gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, result.width, result.height);
  const allocationMs = performance.now() - allocationStart;
  if (gl.getError() !== gl.NO_ERROR) { gl.deleteTexture(texture); throw new Error('WebGL texture allocation failed'); }
  const rowBytes = result.width * 4, rowsPerSlice = Math.max(1, Math.floor(sliceBytes / rowBytes));
  const portions = [];
  try {
    for (let row = 0; row < result.height; row += rowsPerSlice) {
      const count = Math.min(rowsPerSlice, result.height - row);
      const start = performance.now();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, result.width, count, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(result.pixels, row * rowBytes, count * rowBytes));
      portions.push(performance.now() - start);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL upload failed');
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    const framebuffer = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('upload verification framebuffer incomplete');
    const pixel = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(framebuffer);
    const first = new Uint8Array(result.pixels, 0, 4);
    if (!pixel.every((value, i) => value === first[i])) throw new Error('GPU pixel/channel mismatch');
    return { texture, allocationMs, portions, gpuBytes: result.width * result.height * 4, readback: Array.from(pixel), rowsPerSlice };
  } catch (error) { gl.deleteTexture(texture); throw error; }
}
export function drawTexture(gl, texture) {
  function shader(type, source) {
    const shader = gl.createShader(type); gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  }
  const vertex = shader(gl.VERTEX_SHADER, '#version 300 es\nout vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=vec2(p.x,1.-p.y);gl_Position=vec4(p*2.-1.,0.,1.);}');
  const fragment = shader(gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;in vec2 uv;uniform sampler2D image;out vec4 color;void main(){color=texture(image,uv);}');
  const program = gl.createProgram(); gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.viewport(0, 0, gl.canvas.width, gl.canvas.height); gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment);
}
