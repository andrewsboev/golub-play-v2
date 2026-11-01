import {SYS,ABI_VERSION,ABI_SIGNATURE} from './bridge-abi.mjs';
export const normalizePath=path=>{const parts=[];for(const part of path.replaceAll('\\','/').split('/')){if(!part||part==='.')continue;if(part==='..'){if(!parts.length)throw new Error('Logical path escapes resource root');parts.pop();}else parts.push(part);}return '/'+parts.join('/');};
export class SystemHost {
 constructor(canvas,memory,{onError=console.error,dataRoot='/v2-data',fileNamespace='golub-play-v2:file:'}={}){
  this.dataRoot=normalizePath(dataRoot);if(this.dataRoot==='/'||typeof fileNamespace!=='string'||!fileNamespace||/[\u0000-\u001f]/.test(fileNamespace))throw new Error('Invalid virtual file namespace');
  this.fileNamespace=fileNamespace;this.canvas=canvas;this.memory=memory;this.onError=onError;this.catalog=new Map();this.directories=new Set([this.dataRoot]);this.pending=null;this.clipboard='';this.logs=[];
 }
 bytes(p,n){const b=this.memory().buffer;if(p<0||n<0||p+n>b.byteLength)throw new Error('System buffer is out of bounds');return new Uint8Array(b,p,n);}
 text(p,n){return new TextDecoder('utf-8',{fatal:true}).decode(this.bytes(p,n));}
 add(path,bytes){path=normalizePath(path);this.catalog.set(path,{bytes:bytes?new Uint8Array(bytes):null,state:bytes?3:1});}
 read(path){return this.catalog.get(normalizePath(path));}
 call(op,a,b,c,p,n){
  if(op===SYS.ABI_HANDSHAKE){if(a!==ABI_VERSION||b!==ABI_SIGNATURE)throw new Error('Incompatible Pascal/JavaScript bridge ABI');return 1;}
  if(op===SYS.CANVAS_WIDTH)return this.canvas.width;if(op===SYS.CANVAS_HEIGHT)return this.canvas.height;
  if(op===SYS.FULLSCREEN)return document.fullscreenElement?.contains(this.canvas)?1:0;
  if(op===SYS.TITLE){document.title=this.text(p,n);return 1;}
  if(op===SYS.CURSOR){this.canvas.style.cursor=a===0&&this.customCursor?this.customCursor:['default','pointer','move','ew-resize','ns-resize','text','crosshair'][a]||'default';return 1;}
  if(op===SYS.SET_FULLSCREEN){if(!a&&!document.fullscreenElement)return 1;const promise=a?this.canvas.parentElement.requestFullscreen?.():document.exitFullscreen?.();promise?.catch(e=>console.warn(e.message));return 1;}
  if(op===SYS.FIT_WINDOW)return 1;
  if(op===SYS.CUSTOM_CURSOR){if(!n){this.customCursor=null;this.canvas.style.cursor='default';return 1;}const src=this.bytes(p,n),surface=document.createElement('canvas');surface.width=a;surface.height=b;const context=surface.getContext('2d'),rgba=context.createImageData(a,b);for(let i=0;i<n;i+=4){rgba.data[i]=src[i+2];rgba.data[i+1]=src[i+1];rgba.data[i+2]=src[i];rgba.data[i+3]=src[i+3];}context.putImageData(rgba,0,0);this.customCursor=`url(${surface.toDataURL()}) ${c&65535} ${c>>>16}, default`;this.canvas.style.cursor=this.customCursor;return 1;}
  if(op===SYS.LOG){const text=this.text(p,n);this.logs.push(text);if(this.logs.length>100)this.logs.shift();console.log(text);return 1;}
  if(op===SYS.ERROR){this.onError(new Error(this.text(p,n)));return 1;}
  if(op===SYS.FILE_EXISTS)return this.catalog.has(normalizePath(this.text(p,n)))?1:0;
  if(op===SYS.FILE_SIZE){const e=this.read(this.text(p,n));this.pending=e?.bytes;if(!e)return -1;if(e.state===4)return -3;if(e.state!==3)return -2;return e.bytes.byteLength;}
  if(op===SYS.FILE_READ||op===SYS.LIST_READ||op===SYS.CLIPBOARD_READ||op===SYS.DATE_READ||op===SYS.USER_DATA_READ){if(!this.pending||this.pending.length!==n)throw new Error('Data changed between query and read');this.bytes(p,n).set(this.pending);this.pending=null;return 1;}
  if(op===SYS.USER_DATA_SIZE){this.pending=new TextEncoder().encode(this.dataRoot);return this.pending.length;}
  if(op===SYS.FILE_STATE)return this.read(this.text(p,n))?.state??0;
  if(op===SYS.DIRECTORY_EXISTS){const path=normalizePath(this.text(p,n))+'/';return [...this.catalog.keys()].some(k=>k.startsWith(path))||this.directories.has(path.slice(0,-1))?1:0;}
  if(op===SYS.LIST_FILES){const [dir,mask]=this.text(p,n).split('\n'),prefix=normalizePath(dir)+'/',pattern=new RegExp('^'+mask.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*')+'$');
   this.pending=new TextEncoder().encode(JSON.stringify([...this.catalog.keys()].filter(k=>k.startsWith(prefix)).map(k=>k.slice(prefix.length)).filter(k=>!k.includes('/')&&pattern.test(k)&&(prefix!=='/scripts/'||!this.scriptScope||this.scriptScope.has(k.slice(0,-7))))));return this.pending.length;
  }
  if(op===SYS.FILE_WRITE){const packet=this.bytes(p,n);if(n<4)throw new Error('Invalid file write packet');const length=new DataView(packet.buffer,packet.byteOffset,4).getUint32(0,true);if(length>n-4)throw new Error('Invalid file write path length');const path=normalizePath(new TextDecoder('utf-8',{fatal:true}).decode(packet.subarray(4,4+length)));if(!path.startsWith(this.dataRoot+'/'))throw new Error('Cannot write bundled resources');const data=packet.slice(4+length);localStorage.setItem(this.fileNamespace+path,JSON.stringify([...data]));this.add(path,data);return 1;}
  if(op===SYS.MAKE_DIRECTORY){this.directories.add(normalizePath(this.text(p,n)));return 1;}
  if(op===SYS.CPU_COUNT)return navigator.hardwareConcurrency||1;
  if(op===SYS.LANGUAGE)return navigator.language.startsWith('ru')?0x419:0x409;
  if(op===SYS.CLIPBOARD_SIZE){this.pending=new TextEncoder().encode(this.clipboard);return this.pending.length;}
  if(op===SYS.CLIPBOARD_WRITE){this.clipboard=this.text(p,n);navigator.clipboard?.writeText(this.clipboard).catch(e=>console.warn(e.message));return 1;}
  if(op===SYS.DATE_FORMAT){if(n!==8)throw new Error('Date ABI mismatch');const ms=new DataView(this.bytes(p,n).buffer,p,n).getFloat64(0,true);this.dateFormatter ||=new Intl.DateTimeFormat('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});const parts=Object.fromEntries(this.dateFormatter.formatToParts(new Date(ms)).map(part=>[part.type,part.value]));this.pending=new TextEncoder().encode(`${parts.day}.${parts.month}.${parts.year} ${parts.hour}:${parts.minute}`);return this.pending.length;}
  throw new Error('Unknown system operation '+op);
 }
 restoreLocalFiles(){try{for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(key.startsWith(this.fileNamespace+this.dataRoot+'/')){try{const data=JSON.parse(localStorage.getItem(key));if(!Array.isArray(data)||data.some(v=>!Number.isInteger(v)||v<0||v>255))throw new Error('Invalid virtual file bytes');this.add(key.slice(this.fileNamespace.length),new Uint8Array(data));}catch(e){console.warn('Virtual file: '+e.message);}}}}catch(error){console.warn('Virtual files unavailable: '+error.message);}}
}
