// Один запуск владеет ресурсами и отменяет ожидающие продолжения при перезапуске.
export class RuntimeSession {
 constructor(){this.controller=new AbortController();this.disposers=[];}
 get signal(){return this.controller.signal;}
 get closed(){return this.signal.aborted;}
 check(){this.signal.throwIfAborted();}
 guard(callback){return (...args)=>{if(!this.closed)return callback(...args);};}
 own(value,dispose){if(this.closed){dispose(value);return value;}this.disposers.push(()=>dispose(value));return value;}
 async wait(promise){
  this.check();let abort;
  const cancelled=new Promise((_,reject)=>{abort=()=>reject(this.signal.reason);this.signal.addEventListener('abort',abort,{once:true});});
  try{const result=await Promise.race([promise,cancelled]);this.check();return result;}
  finally{this.signal.removeEventListener('abort',abort);}
 }
 close(){
  if(this.closed)return;this.controller.abort(new DOMException('Runtime session closed','AbortError'));
  const failures=[];for(const dispose of this.disposers.splice(0).reverse())try{dispose();}catch(error){failures.push(error);}
  return failures;
 }
}

export async function withDeadline(operation,{signal,timeoutMs=30000,label='Operation'}={}){
 const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 let timer,fail;
 const cancelled=new Promise((_,reject)=>{fail=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',fail,{once:true});if(controller.signal.aborted)fail();});
 timer=setTimeout(()=>controller.abort(new Error(label+' timeout')),timeoutMs);
 try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return operation(controller.signal);}),cancelled]);}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',fail);}
}

export function waitForGraphics(canvas,gl,{signal,timeoutMs=15000}={}){
 if(!gl?.isContextLost())return Promise.resolve();
 return withDeadline(async stopped=>{
  let restored,abort;
  try{await new Promise((resolve,reject)=>{
   restored=()=>{if(!gl.isContextLost())resolve();};abort=()=>reject(stopped.reason);
   canvas.addEventListener('webglcontextrestored',restored);stopped.addEventListener('abort',abort,{once:true});
   restored();
  });}finally{canvas.removeEventListener('webglcontextrestored',restored);stopped.removeEventListener('abort',abort);}
 },{signal,timeoutMs,label:'Graphics restoration'});
}
