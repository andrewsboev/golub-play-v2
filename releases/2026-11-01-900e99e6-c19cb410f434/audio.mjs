import {SYS} from './bridge-abi.mjs';
import {defaultRelease} from './release-runtime.mjs';
import {withDeadline} from './session.mjs';
export class AudioHost {
 constructor(memory,{configuration='Release',onState=()=>{},onError=console.error,autoGesture=true,timeoutMs=30000,release=defaultRelease}={}){
  this.controller=new AbortController();this.timeoutMs=timeoutMs;this.release=release;
  this.memory=memory;this.configuration=configuration;this.onState=onState;this.onError=onError;this.commands=[];this.sequence=0;this.requested=false;this.ready=false;
  this.gesture=()=>{if(this.requested)return this.enable().catch(e=>{if(e.name!=='AbortError')this.onError(e);});};
  if(autoGesture){window.addEventListener('pointerdown',this.gesture);window.addEventListener('keydown',this.gesture);}
 }
 async enable(){
   if(this.stopped)throw new DOMException('Audio owner was closed','AbortError');
  if(this.ready){if(this.context.state!=='running')await this.context.resume();return;}if(this.starting)return this.starting;
  const AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext;if(!AudioContextClass){this.onState('Звук недоступен в этом браузере');return;}
  this.context ||= new AudioContextClass({latencyHint:'interactive'});const resumed=this.context.resume();
  this.starting=withDeadline(async signal=>{
   await resumed;signal.throwIfAborted();await this.context.audioWorklet.addModule(this.release.url(new URL('./audio-sink.mjs',import.meta.url)));
   signal.throwIfAborted();
   this.sink=new AudioWorkletNode(this.context,'golub-pcm-sink',{numberOfOutputs:1,outputChannelCount:[1]});this.sink.connect(this.context.destination);
   this.worker=new Worker(this.release.url(new URL('./audio-worker.mjs',import.meta.url)),{type:'module'});
   let abort;
   try{await new Promise((resolve,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    this.worker.onmessage=({data})=>{if(data.type==='ready')resolve();else if(data.type==='error'){reject(new Error(data.error));if(this.ready&&!this.stopped)this.onError(new Error(data.error));}else if(data.type==='stats')this.stats=data;};
    this.worker.onerror=e=>{e.preventDefault();reject(new Error(e.message));if(this.ready&&!this.stopped)this.onError(new Error(e.message));};
    const module=new URL(`./${this.configuration}/pcm.wasm`,import.meta.url).href;
    this.worker.postMessage({type:'init',port:this.sink.port,module:this.release.url(module),moduleHash:this.release.hash(module),sampleRate:this.context.sampleRate,audioOrigin:performance.timeOrigin+performance.now()-this.context.currentTime*1000,targetMs:60,lowMs:40},[this.sink.port]);
   });}finally{signal.removeEventListener('abort',abort);}
   signal.throwIfAborted();
   this.ready=true;this.onState('Звук включён');for(const command of this.commands)if(command.op!==1&&command.op!==2||performance.timeOrigin+performance.now()-command.acceptedAt<100)this.send(command);this.commands=[];
  },{signal:this.controller.signal,timeoutMs:this.timeoutMs,label:'Audio initialization'}).catch(error=>{this.stop();throw error;}).finally(()=>this.starting=null);return this.starting;
 }
 send(command){this.worker.postMessage(command,[command.bytes]);}
 call(op,subtype,p,n){
  if(op===SYS.AUDIO_INIT){this.requested=true;this.onState('Звук включится после нажатия клавиши или мыши');return 1;}
  if(op===SYS.AUDIO_READY)return this.ready&&this.context.state==='running'?1:0;
  if(op===SYS.AUDIO_STOP){this.stop();return 1;}
  if(op===SYS.AUDIO_PLAYING){const token=this.stats?.commandSequence>=this.lastMusicSequence?this.stats.musicToken:this.requestedMusic||0;return token>0&&(subtype===0||subtype===token)?1:0;}
  if(op===SYS.AUDIO_COMMAND){const bytes=new Uint8Array(this.memory().buffer,p,n).slice().buffer,command={type:'command',op:subtype,bytes,sequence:++this.sequence,acceptedAt:performance.timeOrigin+performance.now()};if(this.ready)this.send(command);else{
    if(subtype===0||subtype===5)this.commands=this.commands.filter(c=>c.op!==subtype);
    if(subtype===3||subtype===4)this.commands=this.commands.filter(c=>c.op!==3&&c.op!==4);
    if(subtype===1||subtype===2)this.commands=this.commands.filter(c=>c.op!==1&&c.op!==2||command.acceptedAt-c.acceptedAt<100);
    this.commands.push(command);
   }if(subtype===3||subtype===4){this.lastMusicSequence=command.sequence;this.requestedMusic=subtype===3?new Int32Array(new Uint8Array(this.memory().buffer,p,n).slice().buffer,0,1)[0]:0;}return 1;
  }
  throw new Error('Unknown audio operation '+op);
 }
 async visibility(hidden){
  if(!this.ready)return;
  if(hidden){this.worker.postMessage({type:'pause',value:true});await this.context.suspend();}
  else{await this.context.resume();this.worker.postMessage({type:'pause',value:false,audioOrigin:performance.timeOrigin+performance.now()-this.context.currentTime*1000});}
 }
 stop(){if(this.stopped)return;this.stopped=true;this.controller.abort(new DOMException('Audio owner was closed','AbortError'));this.ready=false;this.requested=false;this.worker?.terminate();this.sink?.disconnect();if(this.context&&this.context.state!=='closed')this.context.close().catch(e=>console.warn(e));this.commands=[];window.removeEventListener('pointerdown',this.gesture);window.removeEventListener('keydown',this.gesture);}
}
