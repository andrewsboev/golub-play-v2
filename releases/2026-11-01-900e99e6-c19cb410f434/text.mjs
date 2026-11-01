import {TEXT} from './bridge-abi.mjs';
export class TextHost {
 constructor(memory,{trace=false}={}){this.memory=memory;this.trace=trace;this.rendered=[];this.canvas=document.createElement('canvas');this.context=this.canvas.getContext('2d',{willReadFrequently:true});this.bitmaps=new Map();this.nextId=1;this.families=new Map();}
 text(p,n){return new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(this.memory().buffer,p,n));}
 font(st,scale){const entry=this.families.get(st.font)||st.font,name=typeof entry==='string'?entry:entry.family,css=name==='monospace'?'monospace':JSON.stringify(name),fallback=typeof entry==='object'&&entry.fallback?','+JSON.stringify(entry.fallback):'';return `${st.italic?'italic ':''}${st.weight} ${Math.max(1,Math.round(st.size*scale))}px ${css}${fallback}`;}
 layout(text,st,scale){
  const ctx=this.context;ctx.font=this.font(st,scale);const lines=[],wrap=st.wrapWidth*scale;
  for(const raw of text.replaceAll('\r','').split('\n')){
   if(wrap<=0||ctx.measureText(raw).width<=wrap){lines.push(raw);continue;}
   let line='';for(const word of raw.split(' ')){const candidate=line?line+' '+word:word;if(line&&ctx.measureText(candidate).width>wrap){lines.push(line);line=word;}else line=candidate;}lines.push(line);
  }
  const metrics=ctx.measureText('Mg'),ascent=metrics.fontBoundingBoxAscent??metrics.actualBoundingBoxAscent??st.size*scale*.8,descent=metrics.fontBoundingBoxDescent??metrics.actualBoundingBoxDescent??st.size*scale*.2;
  const widths=lines.map(s=>ctx.measureText(s).width),maxWidth=Math.max(0,...widths),lineHeight=ascent+descent+st.strokeWidth*scale;
  return {lines,widths,maxWidth,ascent,descent,lineHeight,w:maxWidth+(st.strokeWidth+2*st.padX)*scale,h:lines.length*lineHeight+2*st.padY*scale};
 }
 color(packed){return `rgba(${(packed>>>16)&255},${(packed>>>8)&255},${packed&255},${(packed>>>24)/255})`;}
 call(op,p,n,s,ns,scale,out){
  if(op===TEXT.READ){const pixels=this.bitmaps.get(n);if(!pixels||pixels.byteLength!==ns)throw new Error('Invalid text bitmap transfer');new Uint8Array(this.memory().buffer,out,ns).set(pixels);this.bitmaps.delete(n);return 1;}
  const text=this.text(p,n),st=JSON.parse(this.text(s,ns)),layout=this.layout(text,st,scale);
  if(op===TEXT.MEASURE){new Float32Array(this.memory().buffer,out,2).set([layout.w,layout.h]);return 1;}
  if(op!==TEXT.RENDER)throw new Error('Unknown text operation '+op);
  if(this.trace){this.rendered.push({text,style:st,scale,width:layout.w,height:layout.h,lines:layout.lines});if(this.rendered.length>512)this.rendered.shift();}
  this.canvas.width=Math.max(1,Math.ceil(layout.w));this.canvas.height=Math.max(1,Math.ceil(layout.h));const ctx=this.context;ctx.font=this.font(st,scale);ctx.textBaseline='alphabetic';ctx.lineJoin='round';
  if(st.background>>>24){ctx.fillStyle=this.color(st.background);ctx.fillRect(0,0,this.canvas.width,this.canvas.height);}
  for(let i=0;i<layout.lines.length;i++){const x=st.padX*scale+st.strokeWidth*scale/2+(layout.maxWidth-layout.widths[i])*(st.align===1?.5:st.align===2?1:0),y=st.padY*scale+st.strokeWidth*scale/2+layout.ascent+i*layout.lineHeight;
   if(st.stroke>>>24&&st.strokeWidth>0){ctx.lineWidth=st.strokeWidth*scale;ctx.strokeStyle=this.color(st.stroke);ctx.strokeText(layout.lines[i],x,y);}ctx.fillStyle=this.color(st.color);ctx.fillText(layout.lines[i],x,y);
  }
  const rgba=ctx.getImageData(0,0,this.canvas.width,this.canvas.height).data,pixels=new Uint8Array(rgba.length);
  for(let i=0;i<rgba.length;i+=4){const a=rgba[i+3];pixels[i]=Math.round(rgba[i+2]*a/255);pixels[i+1]=Math.round(rgba[i+1]*a/255);pixels[i+2]=Math.round(rgba[i]*a/255);pixels[i+3]=a;}
  const id=this.nextId++;this.bitmaps.set(id,pixels);new Int32Array(this.memory().buffer,out,3).set([this.canvas.width,this.canvas.height,id]);return id;
 }
}
