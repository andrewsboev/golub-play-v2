export const normalizePath=path=>{const parts=[];for(const part of path.replaceAll('\\','/').split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw new Error('Logical path escapes resource root');parts.pop();}else parts.push(part);}return '/'+parts.join('/');};
export class SystemHost {
 constructor(canvas,memory,{onError=console.error}={}){this.canvas=canvas;this.memory=memory;this.onError=onError;this.catalog=new Map();this.directories=new Set(['/v2-data']);this.pending=null;this.clipboard='';this.logs=[];}
 bytes(p,n){const b=this.memory().buffer;if(p<0||n<0||p+n>b.byteLength)throw new Error('System buffer is out of bounds');return new Uint8Array(b,p,n);}
 text(p,n){return new TextDecoder('utf-8',{fatal:true}).decode(this.bytes(p,n));}
 add(path,bytes){path=normalizePath(path);this.catalog.set(path,{bytes:bytes?new Uint8Array(bytes):null,state:bytes?3:1});}
 read(path){return this.catalog.get(normalizePath(path));}
 call(op,a,b,c,p,n){
  if(op===0)return this.canvas.width;if(op===1)return this.canvas.height;
  if(op===2)return document.fullscreenElement?.contains(this.canvas)?1:0;
  if(op===3){document.title=this.text(p,n);return 1;}
  if(op===4){this.canvas.style.cursor=['default','pointer','move','ew-resize','ns-resize','text','crosshair'][a]||'default';return 1;}
  if(op===5){if(!a&&!document.fullscreenElement)return 1;const promise=a?this.canvas.parentElement.requestFullscreen?.():document.exitFullscreen?.();promise?.catch(e=>console.warn(e.message));return 1;}
  if(op===6)return 1;
  if(op===7){if(!n){this.canvas.style.cursor='default';return 1;}const src=this.bytes(p,n),surface=document.createElement('canvas');surface.width=a;surface.height=b;const context=surface.getContext('2d'),rgba=context.createImageData(a,b);for(let i=0;i<n;i+=4){rgba.data[i]=src[i+2];rgba.data[i+1]=src[i+1];rgba.data[i+2]=src[i];rgba.data[i+3]=src[i+3];}context.putImageData(rgba,0,0);this.canvas.style.cursor=`url(${surface.toDataURL()}) ${c&65535} ${c>>>16}, default`;return 1;}
  if(op===10){const text=this.text(p,n);this.logs.push(text);if(this.logs.length>100)this.logs.shift();console.log(text);return 1;}
  if(op===11){this.onError(new Error(this.text(p,n)));return 1;}
  if(op===20)return this.catalog.has(normalizePath(this.text(p,n)))?1:0;
  if(op===21){const e=this.read(this.text(p,n));this.pending=e?.bytes;if(!e)return -1;if(e.state===4)return -3;if(e.state!==3)return -2;return e.bytes.byteLength;}
  if(op===22||op===27||op===35||op===38){if(!this.pending||this.pending.length!==n)throw new Error('Data changed between query and read');this.bytes(p,n).set(this.pending);this.pending=null;return 1;}
  if(op===24)return this.read(this.text(p,n))?.state??0;
  if(op===25){const path=normalizePath(this.text(p,n))+'/';return [...this.catalog.keys()].some(k=>k.startsWith(path))||this.directories.has(path.slice(0,-1))?1:0;}
  if(op===26){const [dir,mask]=this.text(p,n).split('\n'),prefix=normalizePath(dir)+'/',pattern=new RegExp('^'+mask.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$');
   this.pending=new TextEncoder().encode(JSON.stringify([...this.catalog.keys()].filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length)).filter(k=>!k.includes('/')&&pattern.test(k))));return this.pending.length;
  }
  if(op===30){const packet=this.bytes(p,n),length=new DataView(packet.buffer,packet.byteOffset,4).getUint32(0,true),path=normalizePath(new TextDecoder().decode(packet.subarray(4,4+length)));if(!path.startsWith('/v2-data/'))throw new Error('Cannot write bundled resources');const data=packet.slice(4+length);localStorage.setItem('golub-play-v2:file:'+path,JSON.stringify([...data]));this.add(path,data);return 1;}
  if(op===31){this.directories.add(normalizePath(this.text(p,n)));return 1;}
  if(op===32)return navigator.hardwareConcurrency||1;
  if(op===33)return navigator.language.startsWith('ru')?0x419:0x409;
  if(op===34){this.pending=new TextEncoder().encode(this.clipboard);return this.pending.length;}
  if(op===36){this.clipboard=this.text(p,n);navigator.clipboard?.writeText(this.clipboard).catch(e=>console.warn(e.message));return 1;}
  if(op===37){if(n!==8)throw new Error('Date ABI mismatch');const ms=new DataView(this.bytes(p,n).buffer,p,n).getFloat64(0,true);this.dateFormatter ||=new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});const parts=Object.fromEntries(this.dateFormatter.formatToParts(new Date(ms)).map(part=>[part.type,part.value]));this.pending=new TextEncoder().encode(`${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`);return this.pending.length;}
  throw new Error('Unknown system operation '+op);
 }
 restoreLocalFiles(){try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key.startsWith('golub-play-v2:file:/v2-data/')){try{this.add(key.slice('golub-play-v2:file:'.length),new Uint8Array(JSON.parse(localStorage.getItem(key))));}catch(e){console.warn('Virtual file: '+e.message);}}}}catch(error){console.warn('Virtual files unavailable: '+error.message);}}
}
