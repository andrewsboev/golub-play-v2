const VS=`#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;layout(location=1) in vec4 aColor;
layout(location=2) in vec2 aUV;layout(location=3) in vec2 aUV2;
uniform vec2 targetSize;out vec2 vUV;out vec2 vUV2;out vec4 vColor;
void main(){vec2 p=(aPos.xy+0.5)/targetSize*2.0-1.0;gl_Position=vec4(p.x,-p.y,0,1);vUV=aUV;vUV2=aUV2;vColor=aColor.bgra;}`;
const FS=`#version 300 es
precision highp float;in vec2 vUV;in vec2 vUV2;in vec4 vColor;
uniform sampler2D image;uniform float flipY;out vec4 outColor;
void main(){outColor=texture(image,vec2(vUV.x,mix(vUV.y,1.0-vUV.y,flipY)))*vColor;}`;
export class WebGLHost {
 constructor(canvas,memory,{shaders={},onError=console.error}={}){
  this.canvas=canvas;this.memory=memory;this.shaders=shaders;this.onError=onError;
  const gl=this.gl=canvas.getContext('webgl2',{alpha:false,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
  if(!gl)throw new Error('Этот браузер не смог создать WebGL2.');
  this.resources=new Map();this.nextId=1;this.programs=new Map();this.shaderIds=new Map();this.lost=false;
  this.stats={calls:0,draws:0,vertices:0,uploadBytes:0,vertexBytes:0,textures:0,gpuBytes:0};
  this.limits={maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),textureUnits:gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),fragmentUniforms:gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),vertexUniforms:gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),renderer:gl.getParameter(gl.RENDERER)};
  this.initializeObjects();
 }
 initializeObjects(){
  const gl=this.gl;this.vbo=gl.createBuffer();this.geometryBuffer=gl.createBuffer();
  this.vao=gl.createVertexArray();gl.bindVertexArray(this.vao);gl.bindBuffer(gl.ARRAY_BUFFER,this.vbo);
  for(const [i,n,type,normalized,offset]of [[0,4,gl.FLOAT,false,0],[1,4,gl.UNSIGNED_BYTE,true,16],[2,2,gl.FLOAT,false,20],[3,2,gl.FLOAT,false,28]]){
   gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,n,type,normalized,36,offset);
  }
  this.geomVao=gl.createVertexArray();gl.bindVertexArray(this.geomVao);gl.bindBuffer(gl.ARRAY_BUFFER,this.geometryBuffer);
  for(let i=0;i<3;i++){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,4,gl.FLOAT,false,48,i*16);}
  this.basic=this.link(VS,FS,'base');this.copyBuffer=gl.createBuffer();this.copyVao=gl.createVertexArray();
  gl.bindVertexArray(this.copyVao);gl.bindBuffer(gl.ARRAY_BUFFER,this.copyBuffer);
  for(const [i,n,type,norm,offset]of [[0,4,gl.FLOAT,false,0],[1,4,gl.UNSIGNED_BYTE,true,16],[2,2,gl.FLOAT,false,20],[3,2,gl.FLOAT,false,28]]){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,n,type,norm,36,offset);}
  gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);
 }
 bytes(p,n){const buffer=this.memory().buffer;if(p<0||n<0||p+n>buffer.byteLength)throw new Error('Wasm graphics buffer is out of bounds');return new Uint8Array(buffer,p,n);}
 text(p,n){return new TextDecoder('utf-8',{fatal:true}).decode(this.bytes(p,n));}
 compile(type,source,name){const gl=this.gl,s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){const error=gl.getShaderInfoLog(s);gl.deleteShader(s);throw new Error(`${name}: ${error}\n${source.split('\n').map((l,i)=>`${i+1}: ${l}`).join('\n')}`);}return s;}
 link(vs,fs,name){
  const gl=this.gl,program=gl.createProgram(),v=this.compile(gl.VERTEX_SHADER,vs,name+' vertex'),f=this.compile(gl.FRAGMENT_SHADER,fs,name+' fragment');
  gl.attachShader(program,v);gl.attachShader(program,f);gl.linkProgram(program);gl.deleteShader(v);gl.deleteShader(f);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(name+': '+gl.getProgramInfoLog(program));
  const uniforms=new Map(),count=gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);
  for(let i=0;i<count;i++){const u=gl.getActiveUniform(program,i);uniforms.set(u.name.replace(/\[0\]$/,''),gl.getUniformLocation(program,u.name));}
  return {program,uniforms,name};
 }
 uniform(program,name,method,...args){const loc=program.uniforms.get(name);if(loc!==undefined&&loc!==null)this.gl[method](loc,...args);}
 get(id){const r=this.resources.get(id);if(!r)throw new Error('Deleted or invalid GPU handle '+id);return r;}
 texture(w,h,data=null,target=false){
  const gl=this.gl;if(w<1||h<1||w>this.limits.maxTextureSize||h>this.limits.maxTextureSize)throw new Error(`Unsupported texture size ${w}×${h}`);
  const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texStorage2D(gl.TEXTURE_2D,1,gl.RGBA8,w,h);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
  const r={texture,w,h,target,flipY:false,framebuffer:null,source:data?.slice()||null};
  if(target){r.framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,r.framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw new Error('Incomplete framebuffer');gl.bindFramebuffer(gl.FRAMEBUFFER,this.current?.framebuffer||null);}
  if(data)this.upload(r,data);
  const id=this.nextId++;this.resources.set(id,r);this.stats.textures++;this.stats.gpuBytes+=w*h*4;return id;
 }
 upload(r,bgra){
  const gl=this.gl;if(bgra.byteLength!==r.w*r.h*4)throw new Error('Texture byte length mismatch');
  gl.bindTexture(gl.TEXTURE_2D,r.texture);const rows=Math.max(1,Math.floor(262144/(r.w*4)));
  for(let y=0;y<r.h;y+=rows){const count=Math.min(rows,r.h-y),rgba=new Uint8Array(r.w*count*4),offset=y*r.w*4;
   for(let i=0;i<rgba.length;i+=4){rgba[i]=bgra[offset+i+2];rgba[i+1]=bgra[offset+i+1];rgba[i+2]=bgra[offset+i];rgba[i+3]=bgra[offset+i+3];}
   gl.texSubImage2D(gl.TEXTURE_2D,0,0,y,r.w,count,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
  }
  r.source=bgra.slice();this.stats.uploadBytes+=bgra.byteLength;
 }
 remove(id){const gl=this.gl,r=this.get(id);gl.deleteTexture(r.texture);if(r.framebuffer)gl.deleteFramebuffer(r.framebuffer);this.stats.textures--;this.stats.gpuBytes-=r.w*r.h*4;this.resources.delete(id);}
 target(r){const gl=this.gl;this.current=r;gl.bindFramebuffer(gl.FRAMEBUFFER,r?.framebuffer||null);gl.viewport(0,0,r?.w||this.canvas.width,r?.h||this.canvas.height);}
 scissor(clip){const gl=this.gl,h=this.current?.h||this.canvas.height;
  gl.enable(gl.SCISSOR_TEST);gl.scissor(clip[0],h-clip[3],Math.max(0,clip[2]-clip[0]),Math.max(0,clip[3]-clip[1]));
 }
 blend(mode){const gl=this.gl;gl.enable(gl.BLEND);gl.blendEquation(gl.FUNC_ADD);gl.blendFunc(...[[gl.ONE,gl.ONE_MINUS_SRC_ALPHA],[gl.ONE,gl.ONE],[gl.DST_COLOR,gl.ONE_MINUS_SRC_ALPHA],[gl.ONE,gl.ONE_MINUS_SRC_COLOR]][mode]);}
 use(program,ids,constants=null,vsConstants=null){
  const gl=this.gl;gl.useProgram(program.program);const flip=new Float32Array(4);
  for(let i=0;i<4;i++){const r=ids[i]?this.get(ids[i]):null;gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,r?.texture||null);flip[i]=r?.flipY?1:0;this.uniform(program,'s'+i,'uniform1i',i);}
  this.uniform(program,'targetSize','uniform2f',this.current?.w||this.canvas.width,this.current?.h||this.canvas.height);
  this.uniform(program,'image','uniform1i',0);this.uniform(program,'flipY','uniform1f',flip[0]);this.uniform(program,'flip','uniform4fv',flip);
  if(constants)this.uniform(program,'k','uniform4fv',constants);if(vsConstants)this.uniform(program,'vk','uniform4fv',vsConstants);
 }
 resolveProgram(ps,vs){
  if(!ps&&!vs)return this.basic;const key=ps+':'+vs;if(this.programs.has(key))return this.programs.get(key);
  const p=ps?this.shaderIds.get(ps):null,v=vs?this.shaderIds.get(vs):null;if((ps&&!p)||(vs&&!v))throw new Error('Unknown shader handle');
  const program=this.link(v?.source||VS,p?.source||FS,(v?.name||'base')+'/'+(p?.name||'base'));this.programs.set(key,program);return program;
 }
 copy(texture,rect){
  const gl=this.gl,dest=this.get(texture),source=this.current,h=source?.h||this.canvas.height;
  if(dest===source)throw new Error('Framebuffer feedback loop');
  const x0=Math.max(0,Math.min(rect[0],(source?.w||this.canvas.width)-1)),y0=Math.max(0,Math.min(rect[1],h-1));
  const x1=Math.max(x0+1,Math.min(rect[2],source?.w||this.canvas.width)),y1=Math.max(y0+1,Math.min(rect[3],h));
  gl.disable(gl.SCISSOR_TEST);gl.bindFramebuffer(gl.READ_FRAMEBUFFER,source?.framebuffer||null);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,dest.framebuffer);
  gl.blitFramebuffer(x0,h-y0,x1,h-y1,0,0,dest.w,dest.h,gl.COLOR_BUFFER_BIT,gl.LINEAR);dest.flipY=false;this.target(source);return 1;
 }
 drawCopy(id,rect,program=this.basic,constants){
  const gl=this.gl,r=this.get(id),data=new ArrayBuffer(36*6),f=new Float32Array(data),u=new Uint32Array(data);
  for(const [i,[x,y,s,t]]of [[0,[rect[0],rect[1],0,0]],[1,[rect[2],rect[1],1,0]],[2,[rect[2],rect[3],1,1]],[3,[rect[0],rect[1],0,0]],[4,[rect[2],rect[3],1,1]],[5,[rect[0],rect[3],0,1]]]){
   const off=i*9;f[off]=x-0.5;f[off+1]=y-0.5;f[off+3]=1;u[off+4]=0xffffffff;f[off+5]=s;f[off+6]=t;
  }
  gl.bindVertexArray(this.copyVao);gl.bindBuffer(gl.ARRAY_BUFFER,this.copyBuffer);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STREAM_DRAW);this.use(program,[id,0,0,0],constants);gl.disable(gl.BLEND);gl.drawArrays(gl.TRIANGLES,0,6);
 }
 call(op,a,b,c,d,p,n){
  this.stats.calls++;const gl=this.gl;
  if(op===0)return 1;
  if(op===1){for(const id of [...this.resources.keys()])this.remove(id);for(const pr of this.programs.values())gl.deleteProgram(pr.program);return 1;}
  if(op===2){if(b===0)this.remove(a);else this.shaderIds.delete(a);return 1;}
  if(op===3)return this.texture(a,b,this.bytes(p,n));
  if(op===4){this.upload(this.get(a),this.bytes(p,n));return 1;}
  if(op===5){const name=this.text(p,n),source=this.shaders[name];if(!source)throw new Error('Shader is not supplied: '+name);const id=this.nextId++;this.shaderIds.set(id,{name,source,vertex:!!a});return id;}
  if(op===6)return 1;
  if(op===7){
   if(this.lost)return 0;this.stats.draws=0;this.stats.vertices=0;
   this.gameRect=Array.from(new Float32Array(this.memory().buffer,p,4));this.post=!!a;
   this.target(null);gl.disable(gl.SCISSOR_TEST);gl.clearColor(((b>>>16)&255)/255,((b>>>8)&255)/255,(b&255)/255,1);gl.clear(gl.COLOR_BUFFER_BIT);
   const [x,y,w,h]=this.gameRect;
   if(this.post){if(this.sceneId){const old=this.get(this.sceneId);if(old.w!==Math.round(w)||old.h!==Math.round(h)){this.remove(this.sceneId);this.sceneId=0;}}
    this.sceneId ||=this.texture(Math.max(1,Math.round(w)),Math.max(1,Math.round(h)),null,true);const scene=this.get(this.sceneId);scene.flipY=true;this.target(scene);gl.clear(gl.COLOR_BUFFER_BIT);
   }else this.scissor([x,y,x+w,y+h]);
   return 1;
  }
  if(op===8||op===9){gl.bindBuffer(gl.ARRAY_BUFFER,op===8?this.vbo:this.geometryBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.bytes(p,n),gl.STREAM_DRAW);this.stats.vertexBytes+=n;return 1;}
  if(op===10){
   if(n!==888)throw new Error('Draw command ABI mismatch '+n);this.bytes(p,n);const i=new Int32Array(this.memory().buffer,p,14),k=new Float32Array(this.memory().buffer,p+56,160),vk=new Float32Array(this.memory().buffer,p+696,48);
   const [tex,ps,vs,mode,start,count,hasClip]=i;if(count<0||start<0)throw new Error('Invalid draw range');
   if(hasClip)this.scissor(Array.from(i.subarray(7,11)));else if(this.post)gl.disable(gl.SCISSOR_TEST);else {const [x,y,w,h]=this.gameRect;this.scissor([x,y,x+w,y+h]);}
   this.blend(mode);const program=this.resolveProgram(ps,vs);this.use(program,[tex,...i.subarray(11,14)],k,vk);gl.bindVertexArray(vs?this.geomVao:this.vao);gl.drawArrays(gl.TRIANGLES,start,count);this.stats.draws++;this.stats.vertices+=count;return 1;
  }
  if(op===11){
   if(!this.post)return 1;this.post=false;this.target(null);const [x,y,w,h]=this.gameRect;this.scissor([x,y,x+w,y+h]);
   if(!this.shaders.post)throw new Error('Post shader is not supplied');
   this.postProgram ||=this.link(VS,this.shaders.post,'post');
   const f=new Float32Array(this.memory().buffer,p+4,19),k=new Float32Array(160);
   k.set([1/w,1/h,0,f[15],f[0],f[1],f[16],f[2],f[5],f[6],f[7],f[3],f[9],f[10],f[11],f[4],f[17],f[18],0,0,w/h,1/Math.sqrt((w/h*.5)**2+.25)]);
   this.drawCopy(this.sceneId,[x,y,x+w,y+h],this.postProgram,k);return 1;
  }
  if(op===12)return this.copy(a,Array.from(new Int32Array(this.memory().buffer,p,4)));
  if(op===13){const rgba=new Uint8Array(c*d*4);gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.readPixels(a,this.canvas.height-b-d,c,d,gl.RGBA,gl.UNSIGNED_BYTE,rgba);const out=this.bytes(p,n);for(let y=0;y<d;y++)for(let x=0;x<c;x++){const src=((d-y-1)*c+x)*4,dst=(y*c+x)*4;out[dst]=rgba[src+2];out[dst+1]=rgba[src+1];out[dst+2]=rgba[src];out[dst+3]=255;}return 1;}
  if(op===14)return this.texture(a,b,null,true);
  if(op===15){const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error('WebGL error 0x'+error.toString(16));return 1;}
  if(op===16)return this.limits.maxTextureSize;
  throw new Error('Unknown graphics operation '+op);
 }
}
