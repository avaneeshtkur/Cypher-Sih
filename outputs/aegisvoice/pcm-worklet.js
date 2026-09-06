class CapturePCM extends AudioWorkletProcessor {
  constructor(){super();this.parts=new Float32Array(2048);this.used=0;
    this.port.onmessage=e=>{if(e.data==='flush'){this.send();this.port.postMessage({flushed:true});}};
  }
  send(){if(this.used){const pcm=this.parts.slice(0,this.used);this.port.postMessage({pcm},[pcm.buffer]);this.used=0;}}
  process(inputs){const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){let sample=0;for(const channel of channels)sample+=channel[i];this.parts[this.used++]=sample/channels.length;if(this.used===this.parts.length)this.send();}
    return true;
  }
}
registerProcessor('capture-pcm',CapturePCM);
