import {SYS} from './bridge-abi.mjs';
const FORMAT=1;
const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
export class VersionedStore {
 constructor({name='golub-play-v2',appId=name,keyPrefix=appId+'.',version=1,onState=()=>{},notify=true,validatePayload=()=>{}}={}){
  for(const value of [name,appId,keyPrefix])if(typeof value!=='string'||!value||/[\u0000-\u001f]/.test(value))throw new Error('Invalid storage identity');
  this.name=name;this.appId=appId;this.prefix=keyPrefix;this.catalogKey=keyPrefix+'#catalog';this.version=version;this.onState=onState;this.cache=new Map();this.results=new Map();this.serial=new Map();this.sequence=0;this.state='new';this.notify=notify;this.validatePayload=validatePayload;
 }
 setState(state,error=''){this.state=state;this.error=error;this.onState(state,error);}
 async validate(row){if(!row||typeof row.key!=='string'||!row.key.startsWith(this.prefix)||row.key===this.catalogKey)throw new Error('Invalid save namespace');if(row.formatVersion!==FORMAT)throw new Error('Unsupported save format');if(!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.payload!=='string'||typeof row.tombstone!=='boolean'||await digest(row.payload)!==row.checksum)throw new Error('Save checksum mismatch');if(row.tombstone&&row.payload!=='')throw new Error('Invalid save tombstone');if(!row.tombstone)this.validatePayload(decodeURIComponent(row.key.slice(this.prefix.length)),row.payload);return row;}
 async open(){
  if(this.state!=='new')throw new Error('Storage open is single-use');
  this.setState('opening');
  try{
   this.db=await new Promise((resolve,reject)=>{const req=indexedDB.open(this.name,this.version);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('entries'))req.result.createObjectStore('entries',{keyPath:'key'});};req.onblocked=()=>!this.closed&&this.setState('blocked','Закройте другую вкладку игры, чтобы обновить хранилище.');req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});
   if(this.closed){this.db.close();return this;}
   this.db.onversionchange=()=>this.close('Хранилище обновилось. Обновите эту вкладку.');
   const cache=new Map(),rows=await request(this.db.transaction('entries').objectStore('entries').getAll());for(const row of rows){if(row.key===this.catalogKey||!row.key.startsWith(this.prefix))continue;await this.validate(row);if(this.closed)return this;cache.set(row.key,row);}
   if(this.closed)return this;this.cache=cache;
   if(this.notify){this.channel=new BroadcastChannel(this.name);this.channel.onmessage=e=>{if(typeof e.data?.key==='string'&&e.data.key.startsWith(this.prefix))this.refresh(e.data.key).catch(error=>{if(!this.closed)this.setState('failed',error.message);});};}
   this.setState('ready');
  }catch(error){if(!this.closed)this.setState('failed',error.name+': '+error.message);}
  return this;
 }
 key(key){return this.prefix+encodeURIComponent(key);}
 get(key){return this.cache.get(this.key(key));}
 async refresh(key){if(this.state!=='ready'||!key.startsWith(this.prefix))return;const row=await request(this.db.transaction('entries').objectStore('entries').get(key));if(row){await this.validate(row);if(!this.closed&&row.revision>=(this.cache.get(key)?.revision||0))this.cache.set(key,row);}return row;}
 begin(key,payload,{expectedRevision,deleted=false}={}){
  if(typeof key!=='string'||!key||typeof payload!=='string')throw new Error('Invalid storage request');
  if(this.closed)throw new Error('Storage is closed');if(this.sequence>=2147483647)throw new Error('Storage request IDs exhausted');
  const id=++this.sequence,full=this.key(key),result={id,state:1,error:'',key:full};this.results.set(id,result);
  const previous=this.serial.get(full)||Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
   try{
    if(this.state!=='ready')throw new Error(this.error||'Persistent storage is unavailable');
    if(!deleted)this.validatePayload(key,payload);
    const bytes=deleted?'':payload,checksum=await digest(bytes);
    if(this.closed)throw new Error('Storage is closed');
    const row=await new Promise((resolve,reject)=>{
     const tx=this.db.transaction('entries','readwrite'),store=tx.objectStore('entries');let committed,conflict=false;
     tx.oncomplete=()=>conflict?resolve(null):resolve(committed);tx.onabort=()=>reject(tx.error||new Error('Save transaction aborted'));tx.onerror=()=>{};
     const get=store.get(full);get.onsuccess=()=>{
      const old=get.result,revision=old?.revision||0;
      if(old&&old.formatVersion!==FORMAT){tx.abort();return;}
      if(expectedRevision!==undefined&&revision!==expectedRevision){conflict=true;return;}
      committed={key:full,revision:revision+1,formatVersion:FORMAT,payload:bytes,checksum,tombstone:deleted};store.put(committed);
      const catalog=store.get(this.catalogKey);catalog.onsuccess=()=>store.put({key:this.catalogKey,revision:(catalog.result?.revision||0)+1});
     };
    });
    if(!row){await this.refresh(full);result.state=3;result.error='Сохранение изменено в другой вкладке. Выберите слот заново.';}
    else{if(!this.closed)this.cache.set(full,row);result.state=2;result.revision=row.revision;this.lastWriteError='';this.channel?.postMessage({key:full,revision:row.revision});}
    if(result.state===3)this.lastWriteError=result.error;
   }catch(error){result.state=4;result.error=error.name+': '+error.message;this.lastWriteError=result.error;if(!this.closed)this.onState(this.state,result.error);}
  }).finally(()=>{if(this.serial.get(full)===operation)this.serial.delete(full);if(result.abandoned)this.results.delete(id);});
  this.serial.set(full,operation);return id;
 }
 async settle(id){const item=this.results.get(id);if(!item)throw new Error('Unknown storage request');await this.serial.get(item.key);return item;}
 status(id){return this.results.get(id)||{state:0,error:'Unknown storage request'};}
 release(id){const item=this.results.get(id);return !!item&&item.state!==1&&this.results.delete(id);}
 abandon(id){const item=this.results.get(id);if(!item)return;if(item.state===1)item.abandoned=true;else this.results.delete(id);}
 snapshot(key){const row=this.get(key);return {found:!!row&&!row.tombstone,value:row&&!row.tombstone?row.payload:'',revision:row?.revision||0};}
 async importMissing(entries){
  if(this.state!=='ready')throw new Error(this.error||'Storage is unavailable');
  const rows=[];for(const [key,payload,deleted=false]of entries){if(typeof key!=='string'||typeof payload!=='string')throw new Error('Invalid save import');if(!deleted)this.validatePayload(key,payload);rows.push({key:this.key(key),payload:deleted?'':payload,checksum:await digest(deleted?'':payload),revision:1,formatVersion:FORMAT,tombstone:!!deleted});}
  const written=[];await new Promise((resolve,reject)=>{const tx=this.db.transaction('entries','readwrite'),store=tx.objectStore('entries');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);for(const row of rows){const req=store.get(row.key);req.onsuccess=()=>{if(!req.result){store.put(row);written.push(row);}};}const meta=store.get(this.catalogKey);meta.onsuccess=()=>store.put({key:this.catalogKey,revision:(meta.result?.revision||0)+1,imported:true});});
  for(const row of written){if(!this.closed)this.cache.set(row.key,row);this.channel?.postMessage({key:row.key,revision:row.revision});}return written.length;
 }
 export(){if(this.state!=='ready'&&!this.cache.size)throw new Error('Save data cannot be exported by this version. Refresh the application.');return JSON.stringify({formatVersion:FORMAT,appId:this.appId,keyPrefix:this.prefix,entries:[...this.cache.values()]},null,2);}
 async importFile(text){const file=JSON.parse(text);if(file.formatVersion!==FORMAT||!Array.isArray(file.entries))throw new Error('Unsupported save export');const legacy=file.appId===undefined&&file.keyPrefix===undefined&&this.appId==='golub-play-v2'&&this.prefix==='golub-play-v2.';if(!legacy&&(file.appId!==this.appId||file.keyPrefix!==this.prefix))throw new Error('Invalid save identity');const entries=[];for(const row of file.entries){await this.validate(row);entries.push([decodeURIComponent(row.key.slice(this.prefix.length)),row.payload,row.tombstone]);}return this.importMissing(entries);}
 close(message=''){this.closed=true;this.channel?.close();this.db?.close();this.results.clear();this.serial.clear();this.cache.clear();this.setState('closed',message);}
 call(op,a,b,c,p,n,system){
  if(op===SYS.STORE_SNAPSHOT){const bytes=new TextEncoder().encode(JSON.stringify(this.snapshot(system.text(p,n))));system.pending=bytes;return bytes.length;}
  if(op===SYS.STORE_READ||op===SYS.STORE_ERROR_READ||op===SYS.STORE_LAST_ERROR_READ){if(system.pending?.length!==n)throw new Error('Storage response size mismatch');system.bytes(p,n).set(system.pending);system.pending=null;return 1;}
  if(op===SYS.STORE_BEGIN){const packet=JSON.parse(system.text(p,n));return this.begin(packet.key,packet.value,{expectedRevision:packet.revision<0?undefined:packet.revision,deleted:!!packet.deleted});}
  if(op===SYS.STORE_STATUS)return this.status(a).state;
  if(op===SYS.STORE_RELEASE)return this.release(a)?1:0;
  if(op===SYS.STORE_ABANDON){this.abandon(a);return 1;}
  if(op===SYS.STORE_CAPABILITIES)return 1|4|(this.state==='ready'?2:0);
  if(op===SYS.STORE_RESULTS)return this.results.size;
  if(op===SYS.STORE_LAST_ERROR_SIZE){system.pending=new TextEncoder().encode(this.lastWriteError||this.error||'');return system.pending.length;}
  if(op===SYS.STORE_ERROR_SIZE){system.pending=new TextEncoder().encode(this.status(a).error||'');return system.pending.length;}
  throw new Error('Unknown storage operation '+op);
 }
}
