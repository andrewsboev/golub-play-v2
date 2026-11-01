function entryFor(url){const release=globalThis.golubRelease;if(!release)return null;const base=new URL('./',document.baseURI),absolute=new URL(url,base).href,entry=release.files.find(e=>new URL(e.file,base).href===absolute||e.url&&new URL(e.url,base).href===absolute);if(!entry)throw new Error('File is absent from the pinned release: '+absolute);return {entry,base};}
export function releaseHash(url){return entryFor(url)?.entry.sha256;}
export function releaseURL(url){const match=entryFor(url);return match?new URL(match.entry.url||match.entry.file,match.base).href:url;}
async function fetchBytes(url,hash,options){const response=await fetch(url,options);if(!response.ok)throw new Error(`HTTP ${response.status}: ${url}`);const bytes=await response.arrayBuffer();if(hash){const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');if(actual!==hash)throw new Error('Release file hash mismatch: '+url);}return bytes;}
export function fetchVerified(url,hash,options){return fetchBytes(releaseURL(url),hash,options);}
export const defaultRelease=Object.freeze({url:releaseURL,hash:releaseHash,fetch(url,options){return fetchVerified(url,releaseHash(url),options);}});
export function createReleaseResolver(manifest,baseURI){
 if(!manifest||!Array.isArray(manifest.files))throw new Error('Invalid release manifest');
 const base=new URL('./',baseURI),entries=new Map();
 for(const row of manifest.files){
  if(typeof row.file!=='string'||!row.file||row.file.startsWith('/')||/[\\:?#\x00-\x1f]/.test(row.file)||row.file.split('/').some(s=>!s||s==='.'||s==='..')||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('Invalid release entry');
  const file=new URL(row.file,base).href,url=new URL(row.url||row.file,base).href,entry=Object.freeze({url,sha256:row.sha256});
  for(const key of new Set([file,url])){const prior=entries.get(key);if(prior&&(prior.sha256!==entry.sha256||prior.url!==entry.url))throw new Error('Release URL collision');entries.set(key,entry);}
 }
 const find=url=>{const entry=entries.get(new URL(url,base).href);if(!entry)throw new Error('File is absent from the pinned release: '+url);return entry;};
 return Object.freeze({url:url=>find(url).url,hash:url=>find(url).sha256,fetch(url,options){const entry=find(url);return fetchBytes(entry.url,entry.sha256,options);}});
}
