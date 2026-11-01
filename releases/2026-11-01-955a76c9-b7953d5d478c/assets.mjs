import {SYS,DECODE,ABI_DECODE_BYTES} from './bridge-abi.mjs';
import {DecoderClient} from './decoder-client.mjs';
import {normalizePath} from './system.mjs';
import {defaultRelease} from './release-runtime.mjs';
import {validateCatalog,ResourceFormatError} from './catalog-format.mjs';
export class AssetHost {
 constructor(system,graphics,{configuration='Release',onProgress=()=>{},fontFaces=[],defaultGroup='title',alwaysGroups=['ui'],onPrepare=()=>{},release=defaultRelease}={}){this.controller=new AbortController();this.system=system;this.graphics=graphics;this.configuration=configuration;this.onProgress=onProgress;this.fontFaces=fontFaces;this.defaultGroup=defaultGroup;this.alwaysGroups=alwaysGroups;this.onPrepare=onPrepare;this.release=release;this.schedulers=new Map();this.sequence=0;this.fonts=[];this.metrics={decode:[],uploadMs:[],uploadBatchMs:[],allocationMs:[],counts:{},maxima:{},decoderHeapHighWater:0,resultBufferHighWater:0};}
 sample(kind,value){const m=this.metrics,index=m.counts[kind]||0;m[kind][index%4096]=value;m.counts[kind]=index+1;m.maxima[kind]=Math.max(m.maxima[kind]||0,value);}
 wanted(path,groups){return groups.split('|').some(group=>this.wantedSingle(path,group));}
 wantedSingle(path,group){
  const groups=this.system.catalog.get(normalizePath(path))?.groups||[];
  return this.alwaysGroups.some(key=>groups.includes(key))||groups.includes(group);
 }
 async initializeCatalog(url){
  const catalog=JSON.parse(new TextDecoder().decode(await this.release.fetch(url,{signal:this.controller.signal})));
  validateCatalog(catalog,url);
  if(this.closed)return;this.levels=catalog.levels||{};this.groups=catalog.groups||{};
  const seen=new Set();for(const entry of catalog.files){const path=normalizePath(entry.path);if(seen.has(path.toLowerCase()))throw new Error('Duplicate catalog path '+path);seen.add(path.toLowerCase());this.system.catalog.set(path,{...entry,path,state:1,bytes:null,url:this.release.url(new URL(entry.url,url).href)});}
  const initial=[...this.system.catalog.values()].filter(e=>!e.path.endsWith('.webp')&&(e.groups.includes('boot')||e.groups.includes('ui')));
  let index=0,done=0;
  await Promise.all(Array.from({length:Math.min(8,initial.length)},async()=>{while(index<initial.length&&!this.closed){const e=initial[index++];await this.load(e);if(!this.closed)this.onProgress({completed:++done,total:initial.length,phase:'data'});}}));
  if(this.closed)return;
  for(const face of this.fontFaces){const e=this.system.read(face.file);if(!e)throw new ResourceFormatError('reference',face.file,'fonts','font absent from catalog');const bytes=await this.load(e);const font=new FontFace(face.family,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),{weight:String(face.weight||'400'),style:face.style||'normal'});await font.load();if(this.closed)return;document.fonts.add(font);this.fonts.push(font);}
  await document.fonts.ready;
 }
 prepare(group){
  const keys=group.split('|').filter(Boolean),neededPaths=new Set();
  for(const key of keys){if(!Object.hasOwn(this.groups,key))throw new Error('Missing resource group: '+key);for(const path of this.groups[key])neededPaths.add(path);}
  this.onPrepare(keys,this);
  const needed=[...neededPaths].map(path=>this.system.read(path)).filter(e=>!e.path.endsWith('.webp'));

  let ready=true;for(const e of needed){if(e.state===4)throw new Error(e.error);if(e.state!==3){ready=false;this.load(e).catch(()=>{});}}
  return ready;
 }
 async load(entry){
  if(entry.state===3)return entry.bytes;if(entry.promise)return entry.promise;
  entry.state=2;entry.promise=(async()=>{try{const r=await fetch(entry.url,{signal:this.controller.signal});if(!r.ok)throw new Error(`${entry.path}: HTTP ${r.status}`);const data=await r.arrayBuffer(),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==entry.sha256)throw new Error('Resource hash mismatch: '+entry.path);entry.bytes=new Uint8Array(data);entry.state=3;return entry.bytes;}catch(e){const error=e instanceof ResourceFormatError?e:new ResourceFormatError('read',entry.path,'$',e.message);entry.state=4;entry.error=error.message;throw error;}})();return entry.promise;
 }
 prefetch(scheduler){
  if(scheduler.fetching||scheduler.closed||this.closed||this.graphics.lost)return;
  scheduler.fetching=Promise.all(Array.from({length:8},async()=>{
   while(!scheduler.closed&&!this.closed&&!this.graphics.lost){
    const job=scheduler.jobs.find((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group)&&this.system.read(job.path)?.state===1);
    if(!job)return;
    // Only compressed bytes are fetched ahead. Decode/upload still have one result in flight.
    // A failed request is reported by the normal decoder queue when its job is consumed.
    await this.load(this.system.read(job.path)).catch(()=>{});
   }
  })).finally(()=>scheduler.fetching=null);
 }
 progress(scheduler){
  const wanted=scheduler.jobs.map((job,i)=>this.wanted(job.path,scheduler.group)?i:-1).filter(i=>i>=0),done=wanted.filter(i=>scheduler.completed.has(i)).length;
  this.onProgress({completed:done,total:wanted.length,phase:'images'});
 }
 discardUploads(scheduler){
  for(const id of new Set([scheduler.uploadingId,scheduler.pending?.texture]))if(id&&this.graphics.resources.has(id))this.graphics.remove(id);
  scheduler.uploadingId=0;scheduler.pending=null;
 }
 async run(scheduler){
  if(scheduler.busy||scheduler.closed||scheduler.pending||this.graphics.lost)return;
  this.prefetch(scheduler);
  if(!scheduler.jobs.some((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group))){scheduler.client?.close();scheduler.client=null;return;}
  scheduler.busy=true;const generation=scheduler.generation||0;let stage='decode',path=scheduler.jobs.find((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group))?.path||'decoder';
  try{
   if(!scheduler.client){scheduler.client=new DecoderClient(this.configuration,{release:this.release});await scheduler.client.initialize();}
   if(this.graphics.lost||generation!==(scheduler.generation||0))return;
   while(!scheduler.closed){
    const index=scheduler.jobs.findIndex((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group));if(index<0||scheduler.pending)break;
    const job=scheduler.jobs[index];path=job.path;stage='read';const entry=this.system.read(job.path);if(!entry)throw new Error('Image absent from catalog: '+job.path);
    this.progress(scheduler);
    const metadata=job.metadata?this.system.read(job.metadata):null;
    if(job.metadata&&!metadata)throw new ResourceFormatError('read',job.metadata,'$','atlas metadata absent from catalog');
    if(metadata)await this.load(metadata);
    const bytes=await this.load(entry);
    if(scheduler.closed||this.graphics.lost||generation!==(scheduler.generation||0))return;
    stage='decode';const result=await scheduler.client.decode({...entry,flags:job.flags,metadata:metadata?.bytes,metadataPath:metadata?.path},bytes.slice().buffer);
    if(scheduler.closed||this.graphics.lost||generation!==(scheduler.generation||0))break;
    this.metrics.decoderHeapHighWater=Math.max(this.metrics.decoderHeapHighWater,result.heap);this.metrics.resultBufferHighWater=Math.max(this.metrics.resultBufferHighWater,result.pixels.byteLength+result.mask.byteLength+result.small.byteLength+result.thumb.byteLength);
    this.metrics.decode.push({path:entry.path,width:result.width,height:result.height,compressedBytes:entry.bytes.length,heap:result.heap,...result.timings});if(this.metrics.decode.length>128)this.metrics.decode.shift();
    stage='device';const allocatedAt=performance.now(),id=this.graphics.texture(result.width,result.height,null,false),texture=this.graphics.get(id);this.sample('allocationMs',performance.now()-allocatedAt);texture.assetPath=entry.path;scheduler.uploadingId=id;
    const rgba=new Uint8Array(result.pixels),gl=this.graphics.gl,rows=Math.max(1,Math.floor(262144/(result.width*4)));
    let batchAt=performance.now();for(let y=0;y<result.height;y+=rows){if(scheduler.closed||this.graphics.lost||generation!==(scheduler.generation||0)){if(this.graphics.resources.has(id))this.graphics.remove(id);scheduler.uploadingId=0;return;}gl.bindTexture(gl.TEXTURE_2D,texture.texture);const count=Math.min(rows,result.height-y),uploadAt=performance.now();gl.texSubImage2D(gl.TEXTURE_2D,0,0,y,result.width,count,gl.RGBA,gl.UNSIGNED_BYTE,rgba.subarray(y*result.width*4,(y+count)*result.width*4));this.sample('uploadMs',performance.now()-uploadAt);if(y%(rows*8)===0){this.sample('uploadBatchMs',performance.now()-batchAt);await new Promise(r=>setTimeout(r,0));batchAt=performance.now();}}
    this.sample('uploadBatchMs',performance.now()-batchAt);
    this.graphics.stats.uploadBytes+=rgba.byteLength;
    scheduler.uploadingId=0;scheduler.pending={index,w:result.width,h:result.height,texture:id,mask:new Uint8Array(result.mask),small:new Uint8Array(result.small),thumb:new Uint8Array(result.thumb),error:new Uint8Array(0)};break;
   }
  }catch(error){if(scheduler.uploadingId&&this.graphics.resources.has(scheduler.uploadingId))this.graphics.remove(scheduler.uploadingId);scheduler.uploadingId=0;if(!scheduler.closed&&!this.graphics.lost&&generation===(scheduler.generation||0)){const index=scheduler.jobs.findIndex((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group)),diagnostic=error.diagnostic||{category:stage,path,field:'$',message:error.message};scheduler.pending={index,w:0,h:0,texture:0,mask:new Uint8Array(),small:new Uint8Array(),thumb:new Uint8Array(),error:new TextEncoder().encode(JSON.stringify(diagnostic))};}}
  finally{scheduler.busy=false;if(scheduler.closed)scheduler.client?.close();else if(!scheduler.pending&&!this.graphics.lost)queueMicrotask(()=>this.run(scheduler));}
 }
 contextLost(){
  for(const s of this.schedulers.values()){s.generation=(s.generation||0)+1;s.client?.close();s.client=null;this.discardUploads(s);}
 }
 async restoreTexture(id,path){
  const entry=this.system.read(path);if(!entry)throw new Error('Restore resource missing: '+path);
  if(this.closed)throw new Error('Asset owner was closed');
  if(!this.restoreClient){this.restoreClient=new DecoderClient(this.configuration,{release:this.release});await this.restoreClient.initialize();}
  const bytes=await this.load(entry),result=await this.restoreClient.decode({...entry,flags:0},bytes.slice().buffer);if(this.closed)throw new Error('Asset owner was closed');const texture=this.graphics.get(id),gl=this.graphics.gl,pixels=new Uint8Array(result.pixels),rows=Math.max(1,Math.floor(262144/(result.width*4)));
  for(let y=0;y<result.height;y+=rows){gl.bindTexture(gl.TEXTURE_2D,texture.texture);const count=Math.min(rows,result.height-y);gl.texSubImage2D(gl.TEXTURE_2D,0,0,y,result.width,count,gl.RGBA,gl.UNSIGNED_BYTE,pixels.subarray(y*result.width*4,(y+count)*result.width*4));if(y%(rows*8)===0)await new Promise(r=>setTimeout(r,0));}
 }
 finishRestore(){this.restoreClient?.close();this.restoreClient=null;}
 close(){this.closed=true;this.controller.abort();for(const s of this.schedulers.values()){s.closed=true;s.client?.close();this.discardUploads(s);}this.schedulers.clear();this.finishRestore();for(const font of this.fonts)document.fonts.delete(font);this.fonts=[];}
 call(op,a,b,c,p,n){
  if(op===SYS.DECODE_CREATE){const id=++this.sequence,jobs=JSON.parse(this.system.text(p,n));this.schedulers.set(id,{jobs,group:this.defaultGroup,completed:new Set(),busy:false,closed:false,pending:null});this.run(this.schedulers.get(id));return id;}
  const s=this.schedulers.get(a);if(!s)throw new Error('Unknown decode scheduler');
  if(op===SYS.DECODE_POLL){
   if(n!==ABI_DECODE_BYTES)throw new Error('Decode packet ABI mismatch');this.system.bytes(p,n);
   if(!s.pending){this.run(s);return 0;}
   const e=s.pending,packet=new Int32Array(this.system.memory().buffer,p,ABI_DECODE_BYTES/4);
   const values={index:e.index,width:e.w,height:e.h,maskBytes:e.mask.length,smallBytes:e.small.length,thumbBytes:e.thumb.length,texture:e.texture,errorBytes:e.error.length};
   for(const [name,index] of Object.entries(DECODE))packet[index]=values[name];return 1;
  }
  if(op===SYS.DECODE_READ){const bytes=[s.pending.mask,s.pending.small,s.pending.thumb,s.pending.error][b];if(bytes.length!==n)throw new Error('Decode transfer size mismatch');this.system.bytes(p,n).set(bytes);return 1;}
  if(op===SYS.DECODE_ACK){s.completed.add(s.pending.index);s.pending=null;this.run(s);return 1;}
  if(op===SYS.DECODE_SELECT){const group=this.system.text(p,n);if(group!==s.group){s.group=group;s.generation=(s.generation||0)+1;s.client?.close();s.client=null;
    if(s.pending&&!this.wanted(s.jobs[s.pending.index].path,group)){if(s.pending.texture)this.graphics.remove(s.pending.texture);s.pending=null;}
    for(const index of s.completed)if(!this.wanted(s.jobs[index].path,group))s.completed.delete(index);
   }this.run(s);return 1;}
  if(op===SYS.DECODE_WANTED)return this.wanted(s.jobs[b].path,s.group)?1:0;
  if(op===SYS.DECODE_CLOSE){s.closed=true;s.client?.close();this.discardUploads(s);this.schedulers.delete(a);return 1;}
  throw new Error('Unknown asset operation '+op);
 }
}
