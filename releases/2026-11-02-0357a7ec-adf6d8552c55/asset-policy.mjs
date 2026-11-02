export function golubAssetPolicy(system){return (keys,host)=>{
 const level=keys.find(key=>key.startsWith('level:'));
 if(level&&host.levels[level.slice(6)])system.scriptScope=new Set(host.levels[level.slice(6)].scripts);
};}
