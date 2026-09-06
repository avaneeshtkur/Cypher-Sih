// PCM boundaries are based on received samples, not wall-clock timer jitter.
export class AudioChunker {
  constructor(rate, emit) { this.rate=rate; this.emit=emit; this.parts=[]; this.size=0; this.silence=0; this.total=0; }
  push(samples) {
    if(!samples.length)return;
    let energy=0;for(const v of samples)energy+=v*v;
    this.silence=Math.sqrt(energy/samples.length)<.008?this.silence+samples.length:0;
    this.parts.push(samples);this.size+=samples.length;
    if(this.size>=this.rate*8||(this.size>=this.rate*3&&this.silence>=this.rate*.5))this.flush();
  }
  flush(){
    if(!this.size)return;
    const pcm=new Float32Array(this.size);let at=0;for(const part of this.parts){pcm.set(part,at);at+=part.length;}
    const start=this.total/this.rate;this.total+=this.size;
    this.parts=[];this.size=0;this.silence=0;
    this.emit({pcm,start,end:this.total/this.rate,rate:this.rate});
  }
}
export function encodeWav(pcm, rate) {
  const bytes=new ArrayBuffer(44+pcm.length*2), view=new DataView(bytes);
  const str=(at,s)=>{for(let i=0;i<s.length;i++)view.setUint8(at+i,s.charCodeAt(i));};
  str(0,'RIFF');view.setUint32(4,36+pcm.length*2,true);str(8,'WAVE');str(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  str(36,'data');view.setUint32(40,pcm.length*2,true);
  for(let i=0;i<pcm.length;i++){const v=Math.max(-1,Math.min(1,pcm[i]));view.setInt16(44+i*2,v<0?v*32768:v*32767,true);}
  return bytes;
}
export function rms(pcm){let energy=0;for(const sample of pcm)energy+=sample*sample;return pcm.length?Math.sqrt(energy/pcm.length):0;}
