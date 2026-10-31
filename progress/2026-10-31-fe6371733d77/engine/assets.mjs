import {DecoderClient} from './decoder-client.mjs';
import {normalizePath} from './system.mjs';
import {releaseHash,fetchVerified} from './release-runtime.mjs';
export class AssetHost {
 constructor(system,graphics,{configuration='Release',onProgress=()=>{}}={}){this.system=system;this.graphics=graphics;this.configuration=configuration;this.onProgress=onProgress;this.schedulers=new Map();this.sequence=0;this.fonts=[];this.metrics={decode:[],uploadMs:[],uploadBatchMs:[],allocationMs:[],counts:{},maxima:{},decoderHeapHighWater:0,resultBufferHighWater:0};}
 sample(kind,value){const m=this.metrics,index=m.counts[kind]||0;m[kind][index%4096]=value;m.counts[kind]=index+1;m.maxima[kind]=Math.max(m.maxima[kind]||0,value);}
 wanted(path,groups){return groups.split('|').some(group=>this.wantedSingle(path,group));}
 wantedSingle(path,group){
  const file=normalizePath(path).slice('/assets/'.length);
  if(file==='atlases/ui.webp'||file==='ui/cursor.webp')return true;
  if(group==='title')return file.startsWith('levels/')||/^bg\/illus_/.test(file);
  if(group==='dive')return /^(atlases\/(l2_|water_|pigeon)|bg\/dive_)/.test(file);
  if(group==='film')return /^(atlases\/(film_|wedding|pigeon|people)|bg\/)/.test(file);
  if(group==='ground')return !/^(atlases\/(l2_|water_|film_|wedding)|bg\/dive_)/.test(file);
  return false;
 }
 async initializeCatalog(url){
  const catalog=JSON.parse(new TextDecoder().decode(await fetchVerified(url,releaseHash(url))));
  const seen=new Set();for(const entry of catalog.files){const path=normalizePath(entry.path);if(seen.has(path.toLowerCase()))throw new Error('Duplicate catalog path '+path);seen.add(path.toLowerCase());this.system.catalog.set(path,{...entry,path,state:1,bytes:null,url:new URL(entry.url,url).href});}
  const initial=[...this.system.catalog.values()].filter(e=>!e.path.endsWith('.webp'));
  let index=0,done=0;
  await Promise.all(Array.from({length:Math.min(8,initial.length)},async()=>{while(index<initial.length){const e=initial[index++];await this.load(e);this.onProgress(`Подготовка данных: ${++done}/${initial.length}`);}}));
  for(const e of initial.filter(e=>/\.ttf$/.test(e.path))){const name=/rubik/i.test(e.path)?'Rubik':/golubserif/i.test(e.path)?'Golub Serif':/pt[_-]?serif/i.test(e.path)?'PT Serif':e.path.split('/').at(-1).replace(/\.ttf$/i,'');const font=new FontFace(name,e.bytes.buffer.slice(e.bytes.byteOffset,e.bytes.byteOffset+e.bytes.byteLength),{weight:/bold/i.test(e.path)?'700':/rubik/i.test(e.path)?'300 900':'400',style:/italic/i.test(e.path)?'italic':'normal'});await font.load();if(this.closed)return;document.fonts.add(font);this.fonts.push(font);}
  await document.fonts.ready;
 }
 async load(entry){
  if(entry.state===3)return entry.bytes;if(entry.promise)return entry.promise;
  entry.state=2;entry.promise=(async()=>{try{const r=await fetch(entry.url);if(!r.ok)throw new Error(`${entry.path}: HTTP ${r.status}`);const data=await r.arrayBuffer(),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');if(digest!==entry.sha256)throw new Error('Resource hash mismatch: '+entry.path);entry.bytes=new Uint8Array(data);entry.state=3;return entry.bytes;}catch(e){entry.state=4;entry.error=e.message;throw e;}})();return entry.promise;
 }
 async run(scheduler){
  if(scheduler.busy||scheduler.closed||scheduler.pending||this.graphics.lost)return;
  if(!scheduler.jobs.some((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group))){scheduler.client?.close();scheduler.client=null;return;}
  scheduler.busy=true;const generation=scheduler.generation||0;
  try{
   if(!scheduler.client){scheduler.client=new DecoderClient(this.configuration);await scheduler.client.initialize();}
   if(this.graphics.lost||generation!==(scheduler.generation||0))return;
   while(!scheduler.closed){
    const index=scheduler.jobs.findIndex((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group));if(index<0||scheduler.pending)break;
    const job=scheduler.jobs[index],entry=this.system.read(job.path);if(!entry)throw new Error('Image absent from catalog: '+job.path);
    this.onProgress('Загрузка: '+job.path.split('/').at(-1));const bytes=await this.load(entry),result=await scheduler.client.decode({...entry,flags:job.flags},bytes.slice().buffer);
    if(scheduler.closed||this.graphics.lost||generation!==(scheduler.generation||0))break;
    this.metrics.decoderHeapHighWater=Math.max(this.metrics.decoderHeapHighWater,result.heap);this.metrics.resultBufferHighWater=Math.max(this.metrics.resultBufferHighWater,result.pixels.byteLength+result.mask.byteLength+result.small.byteLength+result.thumb.byteLength);
    this.metrics.decode.push({path:entry.path,width:result.width,height:result.height,compressedBytes:entry.bytes.length,heap:result.heap,...result.timings});if(this.metrics.decode.length>128)this.metrics.decode.shift();
    const allocatedAt=performance.now(),id=this.graphics.texture(result.width,result.height,null,false),texture=this.graphics.get(id);this.sample('allocationMs',performance.now()-allocatedAt);texture.assetPath=entry.path;scheduler.uploadingId=id;
    const rgba=new Uint8Array(result.pixels),gl=this.graphics.gl,rows=Math.max(1,Math.floor(262144/(result.width*4)));
    let batchAt=performance.now();for(let y=0;y<result.height;y+=rows){if(scheduler.closed||this.graphics.lost||generation!==(scheduler.generation||0)){if(this.graphics.resources.has(id))this.graphics.remove(id);scheduler.uploadingId=0;return;}gl.bindTexture(gl.TEXTURE_2D,texture.texture);const count=Math.min(rows,result.height-y),uploadAt=performance.now();gl.texSubImage2D(gl.TEXTURE_2D,0,0,y,result.width,count,gl.RGBA,gl.UNSIGNED_BYTE,rgba.subarray(y*result.width*4,(y+count)*result.width*4));this.sample('uploadMs',performance.now()-uploadAt);if(y%(rows*8)===0){this.sample('uploadBatchMs',performance.now()-batchAt);await new Promise(r=>setTimeout(r,0));batchAt=performance.now();}}
    this.sample('uploadBatchMs',performance.now()-batchAt);
    this.graphics.stats.uploadBytes+=rgba.byteLength;
    scheduler.uploadingId=0;scheduler.pending={index,w:result.width,h:result.height,texture:id,mask:new Uint8Array(result.mask),small:new Uint8Array(result.small),thumb:new Uint8Array(result.thumb),error:new Uint8Array(0)};break;
   }
  }catch(error){if(!scheduler.closed&&!this.graphics.lost&&generation===(scheduler.generation||0)){const index=scheduler.jobs.findIndex((job,i)=>!scheduler.completed.has(i)&&this.wanted(job.path,scheduler.group));scheduler.pending={index,w:0,h:0,texture:0,mask:new Uint8Array(),small:new Uint8Array(),thumb:new Uint8Array(),error:new TextEncoder().encode(error.message)};}}
  finally{scheduler.busy=false;if(scheduler.closed)scheduler.client?.close();else if(!scheduler.pending&&!this.graphics.lost)queueMicrotask(()=>this.run(scheduler));}
 }
 contextLost(){
  for(const s of this.schedulers.values()){s.generation=(s.generation||0)+1;s.client?.close();s.client=null;if(s.uploadingId&&this.graphics.resources.has(s.uploadingId))this.graphics.remove(s.uploadingId);s.uploadingId=0;}
 }
 async restoreTexture(id,path){
  const entry=this.system.read(path);if(!entry)throw new Error('Restore resource missing: '+path);
  if(!this.restoreClient)this.restoreClient=await new DecoderClient(this.configuration).initialize();
  const bytes=await this.load(entry),result=await this.restoreClient.decode({...entry,flags:0},bytes.slice().buffer);if(this.closed)throw new Error('Asset owner was closed');const texture=this.graphics.get(id),gl=this.graphics.gl,pixels=new Uint8Array(result.pixels),rows=Math.max(1,Math.floor(262144/(result.width*4)));
  for(let y=0;y<result.height;y+=rows){gl.bindTexture(gl.TEXTURE_2D,texture.texture);const count=Math.min(rows,result.height-y);gl.texSubImage2D(gl.TEXTURE_2D,0,0,y,result.width,count,gl.RGBA,gl.UNSIGNED_BYTE,pixels.subarray(y*result.width*4,(y+count)*result.width*4));if(y%(rows*8)===0)await new Promise(r=>setTimeout(r,0));}
 }
 finishRestore(){this.restoreClient?.close();this.restoreClient=null;}
 close(){this.closed=true;for(const s of this.schedulers.values()){s.closed=true;s.client?.close();}this.schedulers.clear();this.finishRestore();for(const font of this.fonts)document.fonts.delete(font);this.fonts=[];}
 call(op,a,b,c,p,n){
  if(op===50){const id=++this.sequence,jobs=JSON.parse(this.system.text(p,n));this.schedulers.set(id,{jobs,group:'title',completed:new Set(),busy:false,closed:false,pending:null});this.run(this.schedulers.get(id));return id;}
  const s=this.schedulers.get(a);if(!s)throw new Error('Unknown decode scheduler');
  if(op===51){if(!s.pending){this.run(s);return 0;}const e=s.pending;new Int32Array(this.system.memory().buffer,p,8).set([e.index,e.w,e.h,e.mask.length,e.small.length,e.thumb.length,e.texture,e.error.length]);return 1;}
  if(op===52){const bytes=[s.pending.mask,s.pending.small,s.pending.thumb,s.pending.error][b];if(bytes.length!==n)throw new Error('Decode transfer size mismatch');this.system.bytes(p,n).set(bytes);return 1;}
  if(op===53){s.completed.add(s.pending.index);s.pending=null;this.run(s);return 1;}
  if(op===54){const group=this.system.text(p,n);if(group!==s.group){s.group=group;s.generation=(s.generation||0)+1;s.client?.close();s.client=null;
    if(s.pending&&!this.wanted(s.jobs[s.pending.index].path,group)){if(s.pending.texture)this.graphics.remove(s.pending.texture);s.pending=null;}
    for(const index of s.completed)if(!this.wanted(s.jobs[index].path,group))s.completed.delete(index);
   }this.run(s);return 1;}
  if(op===55)return this.wanted(s.jobs[b].path,s.group)?1:0;
  if(op===56){s.closed=true;s.client?.close();if(s.pending?.texture)this.graphics.remove(s.pending.texture);this.schedulers.delete(a);return 1;}
  throw new Error('Unknown asset operation '+op);
 }
}
