// Формат игры отделён от общего IndexedDB backend. Значения не интерпретируют игровой мир.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function validateSaveValue(key,payload){
 if(key==='golub.settings.v1'||key==='golub.records.v1'||key.startsWith('slot/')){
  const value=JSON.parse(payload);if(!object(value))throw new Error('Invalid save JSON object');
  const stack=[value];while(stack.length){const item=stack.pop();if(typeof item==='number'&&!Number.isFinite(item))throw new Error('Non-finite save number');if(item&&typeof item==='object')for(const child of Object.values(item))stack.push(child);}
  if(key.startsWith('slot/')){
   if(!/^slot\/[0-5]$/.test(key)||typeof value.level!=='string'||!value.level||!Number.isFinite(value.savedAt)||Number.isNaN(new Date(value.savedAt).valueOf()))throw new Error('Invalid save slot');
   if(value.state!==undefined){if(typeof value.state!=='string')throw new Error('Invalid Pascal state');if(value.state){const state=JSON.parse(value.state);if(!object(state)||![1,2].includes(state.version))throw new Error('Unsupported Pascal state version');if(state.version===2&&(
    state.level!==value.level||typeof state.location!=='string'||!state.location||!object(state.locations)||!object(state.flags)||!Object.hasOwn(state.locations,state.location)||
    Object.values(state.locations).some(room=>!object(room)||room.version!==1||room.level!==state.level)
   ))throw new Error('Invalid location state');}}
  }
 }
}
export async function importLegacy(store,storage=localStorage){
 const entries=[];
 for(const key of ['golub.settings.v1','golub.records.v1','golub.tutorialDone','golub.muted']){const value=storage.getItem(key);if(value!==null){validateSaveValue(key,value);entries.push([key,value]);}}
 const raw=storage.getItem('golub.saves.v1');if(raw){const slots=JSON.parse(raw);if(!Array.isArray(slots)||slots.length>6)throw new Error('Invalid legacy save slots');for(let i=0;i<slots.length;i++){const slot=slots[i];if(slot===null||slot===undefined||object(slot)&&Object.keys(slot).length===0)continue;const payload=JSON.stringify(slot);validateSaveValue('slot/'+i,payload);entries.push(['slot/'+i,payload]);}}
 return store.importMissing(entries);
}
