const FORMAT=1,PREFIX='golub-play-v2.';
const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
export class VersionedStore {
 constructor({name='golub-play-v2',version=1,onState=()=>{},notify=true}={}){this.name=name;this.version=version;this.onState=onState;this.cache=new Map();this.results=new Map();this.serial=new Map();this.sequence=0;this.state='new';this.notify=notify;}
 setState(state,error=''){this.state=state;this.error=error;this.onState(state,error);}
 async validate(row){if(!row||row.key==='__catalog')return row;if(row.formatVersion!==FORMAT)throw new Error('Unsupported save format');if(!Number.isSafeInteger(row.revision)||row.revision<1||typeof row.payload!=='string'||await digest(row.payload)!==row.checksum)throw new Error('Save checksum mismatch');if(row.tombstone&&row.payload!=='')throw new Error('Invalid save tombstone');return row;}
 async open(){
  this.setState('opening');
  try{
   this.db=await new Promise((resolve,reject)=>{const req=indexedDB.open(this.name,this.version);req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('entries'))req.result.createObjectStore('entries',{keyPath:'key'});};req.onblocked=()=>this.setState('blocked','Закройте другую вкладку игры, чтобы обновить хранилище.');req.onerror=()=>reject(req.error);req.onsuccess=()=>resolve(req.result);});
   this.db.onversionchange=()=>{this.db.close();this.setState('closed','Хранилище обновилось. Обновите эту вкладку.');};
   const rows=await request(this.db.transaction('entries').objectStore('entries').getAll());for(const row of rows){await this.validate(row);if(row.key!=='__catalog')this.cache.set(row.key,row);}
   if(this.notify){this.channel=new BroadcastChannel(this.name);this.channel.onmessage=e=>{if(typeof e.data?.key==='string')this.refresh(e.data.key).catch(error=>this.setState('failed',error.message));};}
   this.setState('ready');
  }catch(error){this.setState('failed',error.name+': '+error.message);}
  return this;
 }
 key(key){return PREFIX+encodeURIComponent(key);}
 get(key){return this.cache.get(this.key(key));}
 async refresh(key){if(this.state!=='ready')return;const row=await request(this.db.transaction('entries').objectStore('entries').get(key));if(row){await this.validate(row);if(row.revision>=(this.cache.get(key)?.revision||0))this.cache.set(key,row);}return row;}
 begin(key,payload,{expectedRevision,deleted=false}={}){
  if(typeof key!=='string'||!key||typeof payload!=='string')throw new Error('Invalid storage request');
  const id=++this.sequence,full=this.key(key),result={id,state:1,error:'',key:full};this.results.set(id,result);
  const previous=this.serial.get(full)||Promise.resolve();
  const operation=previous.catch(()=>{}).then(async()=>{
   try{
    if(this.state!=='ready')throw new Error(this.error||'Persistent storage is unavailable');
    const bytes=deleted?'':payload,checksum=await digest(bytes);
    const row=await new Promise((resolve,reject)=>{
     const tx=this.db.transaction('entries','readwrite'),store=tx.objectStore('entries');let committed,conflict=false;
     tx.oncomplete=()=>conflict?resolve(null):resolve(committed);tx.onabort=()=>reject(tx.error||new Error('Save transaction aborted'));tx.onerror=()=>{};
     const get=store.get(full);get.onsuccess=()=>{
      const old=get.result,revision=old?.revision||0;
      if(old&&old.formatVersion!==FORMAT){tx.abort();return;}
      if(expectedRevision!==undefined&&revision!==expectedRevision){conflict=true;return;}
      committed={key:full,revision:revision+1,formatVersion:FORMAT,payload:bytes,checksum,tombstone:deleted};store.put(committed);
      const catalog=store.get('__catalog');catalog.onsuccess=()=>store.put({key:'__catalog',revision:(catalog.result?.revision||0)+1});
     };
    });
    if(!row){await this.refresh(full);result.state=3;result.error='Сохранение изменено в другой вкладке. Выберите слот заново.';}
    else{this.cache.set(full,row);result.state=2;result.revision=row.revision;this.channel?.postMessage({key:full,revision:row.revision});}
   }catch(error){result.state=4;result.error=error.name+': '+error.message;}
  }).finally(()=>{if(this.serial.get(full)===operation)this.serial.delete(full);});
  this.serial.set(full,operation);return id;
 }
 async settle(id){const item=this.results.get(id);if(!item)throw new Error('Unknown storage request');await this.serial.get(item.key);return item;}
 status(id){return this.results.get(id)||{state:4,error:'Unknown storage request'};}
 snapshot(key){const row=this.get(key);return {found:!!row&&!row.tombstone,value:row&&!row.tombstone?row.payload:'',revision:row?.revision||0};}
 async importLegacy(storage=localStorage){
  const entries=[];
  for(const key of ['golub.settings.v1','golub.records.v1','golub.tutorialDone','golub.muted']){const value=storage.getItem(key);if(value!==null){if(key.endsWith('.v1'))JSON.parse(value);entries.push([key,value]);}}
  const raw=storage.getItem('golub.saves.v1');if(raw){const slots=JSON.parse(raw);if(!Array.isArray(slots)||slots.length>6)throw new Error('Invalid legacy save slots');for(let i=0;i<slots.length;i++){const slot=slots[i];if(slot&&typeof slot.level==='string'&&Number.isFinite(slot.savedAt))entries.push(['slot/'+i,JSON.stringify(slot)]);}}
  return this.importMissing(entries);
 }
 async importMissing(entries){
  if(this.state!=='ready')throw new Error(this.error||'Storage is unavailable');
  const rows=[];for(const [key,payload]of entries){if(typeof key!=='string'||typeof payload!=='string')throw new Error('Invalid save import');rows.push({key:this.key(key),payload,checksum:await digest(payload),revision:1,formatVersion:FORMAT,tombstone:false});}
  const written=[];await new Promise((resolve,reject)=>{const tx=this.db.transaction('entries','readwrite'),store=tx.objectStore('entries');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);for(const row of rows){const req=store.get(row.key);req.onsuccess=()=>{if(!req.result){store.put(row);written.push(row);}};}const meta=store.get('__catalog');meta.onsuccess=()=>store.put({key:'__catalog',revision:(meta.result?.revision||0)+1,imported:true});});
  for(const row of written){this.cache.set(row.key,row);this.channel?.postMessage({key:row.key,revision:row.revision});}return written.length;
 }
 export(){return JSON.stringify({formatVersion:FORMAT,entries:[...this.cache.values()]},null,2);}
 async importFile(text){const file=JSON.parse(text);if(file.formatVersion!==FORMAT||!Array.isArray(file.entries))throw new Error('Unsupported save export');const entries=[];for(const row of file.entries){if(!row.key.startsWith(PREFIX))throw new Error('Invalid save namespace');await this.validate(row);if(!row.tombstone)entries.push([decodeURIComponent(row.key.slice(PREFIX.length)),row.payload]);}return this.importMissing(entries);}
 close(){this.channel?.close();this.db?.close();this.setState('closed');}
 call(op,a,b,c,p,n,system){
  if(op===70){const bytes=new TextEncoder().encode(JSON.stringify(this.snapshot(system.text(p,n))));system.pending=bytes;return bytes.length;}
  if(op===71||op===75){if(system.pending?.length!==n)throw new Error('Storage response size mismatch');system.bytes(p,n).set(system.pending);system.pending=null;return 1;}
  if(op===72){const packet=JSON.parse(system.text(p,n));return this.begin(packet.key,packet.value,{expectedRevision:packet.revision<0?undefined:packet.revision,deleted:!!packet.deleted});}
  if(op===73)return this.status(a).state;
  if(op===74){system.pending=new TextEncoder().encode(this.status(a).error||'');return system.pending.length;}
  throw new Error('Unknown storage operation '+op);
 }
}
