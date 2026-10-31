export class AudioHost {
 constructor(memory,{configuration='Release',onState=()=>{},onError=console.error}={}){
  this.memory=memory;this.configuration=configuration;this.onState=onState;this.onError=onError;this.commands=[];this.sequence=0;this.requested=false;this.ready=false;
  this.gesture=()=>{if(this.requested)this.enable().catch(e=>this.onError(e));};
  window.addEventListener('pointerdown',this.gesture);window.addEventListener('keydown',this.gesture);
 }
 async enable(){
  if(this.starting)return this.starting;if(this.ready){if(this.context.state!=='running')await this.context.resume();return;}
  const AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext;if(!AudioContextClass){this.onState('Звук недоступен в этом браузере');return;}
  this.context=new AudioContextClass({latencyHint:'interactive'});const resumed=this.context.resume();
  this.starting=(async()=>{
   await resumed;await this.context.audioWorklet.addModule(new URL('./audio-sink.mjs',import.meta.url));
   this.sink=new AudioWorkletNode(this.context,'golub-pcm-sink',{numberOfOutputs:1,outputChannelCount:[1]});this.sink.connect(this.context.destination);
   this.worker=new Worker(new URL('./audio-worker.mjs',import.meta.url),{type:'module'});
   await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Audio worker initialization timeout')),30000);
    this.worker.onmessage=({data})=>{if(data.type==='ready'){clearTimeout(timer);resolve();}else if(data.type==='error'){clearTimeout(timer);reject(new Error(data.error));this.onError(new Error(data.error));}else if(data.type==='stats')this.stats=data;};
    this.worker.onerror=e=>{e.preventDefault();clearTimeout(timer);reject(new Error(e.message));this.onError(new Error(e.message));};
    this.worker.postMessage({type:'init',port:this.sink.port,module:new URL(`./${this.configuration}/pcm.wasm`,import.meta.url).href,sampleRate:this.context.sampleRate,audioOrigin:performance.timeOrigin+performance.now()-this.context.currentTime*1000,targetMs:60,lowMs:40},[this.sink.port]);
   });
   this.ready=true;this.onState('Звук включён');for(const command of this.commands)this.send(command);this.commands=[];
  })();return this.starting;
 }
 send(command){this.worker.postMessage(command,[command.bytes]);}
 call(op,subtype,p,n){
  if(op===60){this.requested=true;this.onState('Звук включится после нажатия клавиши или мыши');return 1;}
  if(op===61)return this.ready&&this.context.state==='running'?1:0;
  if(op===62){this.stop();return 1;}
  if(op===63){const bytes=new Uint8Array(this.memory().buffer,p,n).slice().buffer,command={type:'command',op:subtype,bytes,sequence:++this.sequence,acceptedAt:performance.timeOrigin+performance.now()};if(this.ready)this.send(command);else{
    if(subtype===0||subtype===5)this.commands=this.commands.filter(c=>c.op!==subtype);
    this.commands.push(command);
   }return 1;
  }
  throw new Error('Unknown audio operation '+op);
 }
 async visibility(hidden){
  if(!this.ready)return;
  if(hidden){this.worker.postMessage({type:'pause',value:true});await this.context.suspend();}
  else{await this.context.resume();this.worker.postMessage({type:'pause',value:false,audioOrigin:performance.timeOrigin+performance.now()-this.context.currentTime*1000});}
 }
 stop(){if(this.stopped)return;this.stopped=true;this.ready=false;this.requested=false;this.worker?.terminate();this.sink?.disconnect();if(this.context&&this.context.state!=='closed')this.context.close().catch(e=>this.onError(e));this.commands=[];window.removeEventListener('pointerdown',this.gesture);window.removeEventListener('keydown',this.gesture);}
}
