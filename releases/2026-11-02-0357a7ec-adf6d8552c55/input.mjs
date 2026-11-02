export const keyCodes={Backspace:8,Tab:9,Enter:13,NumpadEnter:13,ShiftLeft:16,ShiftRight:16,ControlLeft:17,ControlRight:17,AltLeft:18,AltRight:18,Pause:19,CapsLock:20,Escape:27,Space:32,PageUp:33,PageDown:34,End:35,Home:36,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,PrintScreen:44,Insert:45,Delete:46,MetaLeft:91,MetaRight:92,ContextMenu:93,NumpadMultiply:106,NumpadAdd:107,NumpadSubtract:109,NumpadDecimal:110,NumpadDivide:111,NumLock:144,ScrollLock:145,Semicolon:186,Equal:187,Comma:188,Minus:189,Period:190,Slash:191,Backquote:192,BracketLeft:219,Backslash:220,BracketRight:221,Quote:222};
for(let i=0;i<26;i++)keyCodes['Key'+String.fromCharCode(65+i)]=65+i;
for(let i=0;i<10;i++){keyCodes['Digit'+i]=48+i;keyCodes['Numpad'+i]=96+i;}
for(let i=1;i<=24;i++)keyCodes['F'+i]=111+i;
export class InputHost {
 constructor(canvas,system,{logicalWidth=1920,logicalHeight=1080}={}){
  this.canvas=canvas;this.system=system;this.queue=[];this.held=new Set();this.listeners=[];
  this.logicalWidth=logicalWidth;this.logicalHeight=logicalHeight;
  this.editor=document.createElement('textarea');this.editor.setAttribute('aria-label','Текстовый ввод игры');this.editor.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';canvas.parentElement.append(this.editor);
  const on=(element,event,fn,options)=>{element.addEventListener(event,fn,options);this.listeners.push(()=>element.removeEventListener(event,fn,options));};
  const active=()=>document.activeElement===canvas||document.activeElement===this.editor;
  on(window,'keydown',e=>{if(!active()||e.isComposing)return;const code=keyCodes[e.code];if(code===undefined)return;
   this.held.add(e.code);if(!(e.ctrlKey&&e.code==='KeyV'))this.queue.push({kind:'key',code,down:true,repeat:e.repeat});
   if(['Tab','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Backspace','Delete'].includes(e.code)&&!e.isComposing)e.preventDefault();
  });
  on(window,'keyup',e=>{if(!this.held.has(e.code))return;this.held.delete(e.code);const code=keyCodes[e.code];if(![...this.held].some(k=>keyCodes[k]===code))this.queue.push({kind:'key',code,down:false,repeat:false});});
  on(this.editor,'compositionstart',()=>this.composing=true);
  on(this.editor,'compositionend',e=>{this.composing=false;if(e.data)this.queue.push({kind:'text',text:e.data});this.editor.value='';this.skipCompositionInput=e.data;queueMicrotask(()=>this.skipCompositionInput=null);});
  on(this.editor,'input',e=>{if(this.composing||e.isComposing)return;if(e.data&&e.data!==this.skipCompositionInput)this.queue.push({kind:'text',text:e.data});this.skipCompositionInput=null;this.editor.value='';});
  on(this.editor,'paste',e=>{e.preventDefault();const text=e.clipboardData.getData('text/plain');this.system.clipboard=text;this.queue.push({kind:'text',text});});
  on(this.editor,'copy',e=>e.preventDefault());on(this.editor,'cut',e=>e.preventDefault());
  on(window,'blur',()=>this.blur());
  on(document,'focusin',()=>{if(!active())this.blur();});
  on(canvas,'pointerdown',e=>{if(e.pointerType!=='mouse')return;this.editor.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);this.pointer(e,[1,5,3][e.button]);});
  on(canvas,'pointerup',e=>{if(e.pointerType!=='mouse')return;this.pointer(e,[2,6,4][e.button]);if(!e.buttons&&canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});
  on(canvas,'pointermove',e=>{if(e.pointerType==='mouse')this.pointer(e,0);});
  on(canvas,'lostpointercapture',()=>this.queue.push({kind:'release-pointer'}));
  on(canvas,'wheel',e=>{if(!active())return;e.preventDefault();this.pointer(e,7,-e.deltaY/(e.deltaMode===1?3:e.deltaMode===2?1:100));},{passive:false});
  on(canvas,'contextmenu',e=>e.preventDefault());
 }
 pointer(e,code,wheel=0){if(code===undefined)return;const r=this.canvas.getBoundingClientRect(),w=this.logicalWidth,h=this.logicalHeight,scale=Math.min(r.width/w,r.height/h),x=(e.clientX-r.left-(r.width-w*scale)/2)/scale,y=(e.clientY-r.top-(r.height-h*scale)/2)/scale;this.queue.push({kind:'pointer',code,x,y,wheel});}
 blur(){this.queue.length=0;this.held.clear();this.queue.push({kind:'blur'});this.editor.value='';}
 flush(runtime){
  const queue=this.queue;this.queue=[];
  for(const event of queue){
   if(event.kind==='key')runtime.call('input_key',event.code,event.down?1:0,event.repeat?1:0);
   if(event.kind==='pointer')runtime.call('input_pointer',event.code,event.x,event.y,event.wheel);
   if(event.kind==='blur')runtime.call('input_blur');
   if(event.kind==='release-pointer')runtime.call('input_release_pointer');
   if(event.kind==='text'){const bytes=new TextEncoder().encode(event.text),p=runtime.call('allocate',bytes.length);new Uint8Array(runtime.memory.buffer,p,bytes.length).set(bytes);runtime.call('input_text',p,bytes.length);runtime.call('deallocate',p);}
  }
 }
 destroy(){this.listeners.forEach(f=>f());this.editor.remove();this.held.clear();this.queue=[];}
}
