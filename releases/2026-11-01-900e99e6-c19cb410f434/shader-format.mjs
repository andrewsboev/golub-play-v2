export function validateShaderCatalog(value){
 if(!value||value.schemaVersion!==1||!Array.isArray(value.shaders))throw new Error('Unsupported shader catalog version');
 const ids=new Set();for(const entry of value.shaders){
  if(!entry||typeof entry.id!=='string'||!entry.id||ids.has(entry.id))throw new Error('Missing or duplicate shader ID');ids.add(entry.id);
  if(!['pixel','vertex'].includes(entry.stage)||!['sprite','geometry'].includes(entry.layout))throw new Error(entry.id+': invalid stage/layout');
  if(!(entry.stage==='pixel'?['auto','ps_2_0','ps_2_b','ps_3_0']:['vs_2_0','vs_3_0']).includes(entry.profile))throw new Error(entry.id+': unsupported native shader profile');
  if(typeof entry.hlsl!=='string'||!entry.hlsl||typeof entry.glsl!=='string'||!entry.glsl)throw new Error(entry.id+': missing shader source');
  if(entry.required!==undefined&&typeof entry.required!=='boolean')throw new Error(entry.id+': invalid required flag');
 }
 for(const entry of value.shaders)if(entry.previewPixel){const peer=value.shaders.find(e=>e.id===entry.previewPixel);if(!peer||peer.stage!=='pixel')throw new Error(entry.id+': missing pixel shader pair');}
 return value;
}
