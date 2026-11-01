export class ResourceFormatError extends Error {
 constructor(category,path,field,message){super(`${category}: ${path} ${field}: ${message}`);this.name='ResourceFormatError';this.diagnostic={category,path,field,message};}
}
export function validateCatalog(value,path='catalog.json'){
 const fail=(field,message,category='schema')=>{throw new ResourceFormatError(category,path,field,message);};
 const object=(v,field)=>{if(!v||typeof v!=='object'||Array.isArray(v))fail(field,'expected object');};
 const list=(v,field)=>{if(!Array.isArray(v))fail(field,'expected array');};
 const text=(v,field)=>{if(typeof v!=='string'||!v.length)fail(field,'expected nonempty string');};
 const virtual=(v,field)=>{text(v,field);if(!v.startsWith('/')||/[\\\u0000-\u001f]/.test(v)||v.split('/').slice(1).some(s=>!s||s==='.'||s==='..'))fail(field,'invalid canonical virtual path');};
 object(value,'$');if(value.schemaVersion!==2)fail('$.schemaVersion','unsupported resource catalog version','version');
 list(value.files,'$.files');object(value.groups,'$.groups');if(value.levels!==undefined)object(value.levels,'$.levels');
 const files=new Map(),folded=new Set(),urls=new Map();
 for(const [i,entry] of value.files.entries()){
  const field=`$.files[${i}]`;object(entry,field);virtual(entry.path,field+'.path');
  const fold=entry.path.toLowerCase();if(folded.has(fold))fail(field+'.path','duplicate path');folded.add(fold);files.set(entry.path,entry);
  text(entry.url,field+'.url');let uri;
  try{uri=decodeURIComponent(entry.url);}catch{fail(field+'.url','invalid URL encoding');}
  if(/[\\\u0000-\u001f?#]/.test(uri)||uri.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(uri)||uri.split('/').includes('..'))fail(field+'.url','expected a resource URL within the package');
  if(typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256))fail(field+'.sha256','expected SHA-256');
  if(!Number.isSafeInteger(entry.bytes)||entry.bytes<0)fail(field+'.bytes','invalid byte length');
  if(urls.has(entry.url)&&urls.get(entry.url)!==entry.sha256)fail(field+'.url','URL has conflicting hashes');urls.set(entry.url,entry.sha256);
  if(entry.width!==undefined||entry.height!==undefined){
   if(!Number.isSafeInteger(entry.width)||entry.width<=0||!Number.isSafeInteger(entry.height)||entry.height<=0)fail(field+'.size','invalid image dimensions');
  }
  list(entry.groups,field+'.groups');const seen=new Set();
  for(const group of entry.groups){text(group,field+'.groups');if(seen.has(group))fail(field+'.groups','duplicate group');seen.add(group);}
 }
 for(const [group,members]of Object.entries(value.groups)){
  text(group,'$.groups');list(members,'$.groups.'+group);const seen=new Set();
  for(const member of members){virtual(member,'$.groups.'+group);if(seen.has(member))fail('$.groups.'+group,'duplicate member');seen.add(member);
   const file=files.get(member);if(!file)fail('$.groups.'+group,'missing resource '+member,'reference');
   if(!file.groups.includes(group))fail('$.groups.'+group,'resource membership is not reciprocal','reference');
  }
 }
 for(const entry of files.values())for(const group of entry.groups){
  if(!Object.hasOwn(value.groups,group)||!value.groups[group].includes(entry.path))fail('$.files.groups','missing group membership '+group,'reference');
 }
 return value;
}
