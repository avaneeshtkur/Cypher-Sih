import {AudioChunker,FixedWindowChunker,encodeWav,rms} from './audio-core.mjs';
import {analyze,fuseAssessment} from './engine.mjs';
import {buildAsrTurns,evidenceUpdate} from './demo-session.mjs';
const $=id=>document.getElementById(id);
const severity=state=>({'No concerning combination':0,'Needs verification':1,'Strongly suspicious':2}[state]||0);
export function initLiveCall(onReason){
 let generation=0,session=null,graph=null,queue=[],busy=false,starting=false,controller=null,stopping=false;
 let detectorQueue=[],detectorBusy=false;
 let capabilities=null;
 const streamingReady=()=>capabilities?.deepfake===true||(
   capabilities?.deepfake===undefined&&capabilities?.asr===true&&capabilities?.asrBackend!=='openai-whisper');
 const intentSupports=language=>(capabilities?.intentLanguages??['en']).includes(language);
 function controls(){const locked=starting||busy||!!session?.active||stopping;
 for(const id of ['live-share','live-mic'])$(id).disabled=locked||!streamingReady();
  $('live-stop').disabled=!session?.active&&!starting;
  $('live-clear').disabled=stopping;
 }
 function status(message){$('live-status').textContent=message;}
 function render(){
 onReason?.(session?.assessment??null,{},session);
 }
 function renderRisk(){
 render();
 }
 function assess(model=null,context={}){if(!session)return;
  const turns=buildAsrTurns(session.entries,120);
  session.model=model;session.assessment=fuseAssessment(analyze(turns),model);
  if(!session.peak||severity(session.assessment.state)>=severity(session.peak.state))session.peak=session.assessment;
  renderRisk();
  onReason?.(session.assessment,{source:`Live · ${session.source}`,model,channel:session.channel,...context},session);
  return turns;
 }
 function gap(chunk,message){if(!session)return;session.gaps++;session.entries.push({start:chunk.start,end:chunk.end,kind:'gap',text:message});session.events.push({at:chunk.end,reason:message,stage:'gap',text:message});render();}
 async function request(command,payload,signal){
  const res=await fetch(`/api/${command}`,{method:'POST',signal,headers:{'Content-Type':command==='intent'?'application/json':'audio/wav'},body:command==='intent'?JSON.stringify(payload):payload});
  const result=await res.json();if(!res.ok)throw new Error(result.error||'Local model failed');return result;
 }
 async function drain(){
  if(busy||!session)return;busy=true;controls();const token=generation;
  try{while(queue.length&&token===generation){
   const chunk=queue.shift();render();controller=new AbortController();const began=performance.now();
   try{
    const asr=await request('transcribe',encodeWav(chunk.pcm,chunk.rate),controller.signal);if(token!==generation)return;
    session.lastInferenceSeconds=(performance.now()-began)/1000;
    if(asr.text?.trim()){
     const entry={start:chunk.start,end:chunk.end,text:asr.text,asr,kind:'speech',transcriptSource:'local-asr'};
      const previousAssessment=session.assessment??null;
     session.entries.push(entry);
     const segment={start:chunk.start,end:chunk.end};
     const turns=assess(null,{transcript:asr.text,segment});
      session.events.push(evidenceUpdate(turns,entry,previousAssessment?.state??null,previousAssessment));render();
     $('pipeline-analysis').textContent='Text rules evaluated';
    if(capabilities?.intent && intentSupports(session.assessment.language.language)){
       try{const model=await request('intent',{turns},controller.signal);if(token!==generation)return;
         const before=session.assessment.state;assess(model,{transcript:asr.text,segment});
         session.events.push({at:chunk.end,state:session.assessment.state,previousState:before,stage:'model',
           reason:`Local classifier score ${model.score.toFixed(3)}. ${model.usable?'Combined with rules; cannot clear an explicit warning.':model.status}`,
           transcriptSource:'local-asr',text:asr.text,assessment:session.assessment});render();
       }catch(e){if(token!==generation)return;session.modelError=e.message;session.events.push({at:chunk.end,state:session.assessment.state,stage:'model-error',reason:`Classifier unavailable: ${e.message}. Rule result retained.`});render();}
     }
    }
    $('live-latency').textContent=`Last speech inference: ${session.lastInferenceSeconds.toFixed(1)} s after a ${Math.round(chunk.end-chunk.start)} s audio segment. English ASR; boundaries may split words.`;
   }catch(e){if(token!==generation)return;gap(chunk,`Speech not analyzed: ${e.message}`);status('A segment could not be transcribed. See the coverage gap below.');}
  }}finally{if(token===generation){busy=false;controller=null;controls();render();if(!session?.active&&!stopping)status('Stopped · captured audio processed. Review transcription and any coverage gaps.');}}
 }
 async function drainDetectors(){
  if(detectorBusy||!session)return;detectorBusy=true;const token=generation;
  try{while(detectorQueue.length&&token===generation){const chunk=detectorQueue.shift();try{const result=await request('diagnostic',encodeWav(chunk.pcm,chunk.rate));if(token!==generation)return;(session.audioEvidence??=[]).push({start:chunk.start,end:chunk.end,result});$('pipeline-analysis').textContent='Pella + AASIST evaluated';render();}catch(error){if(token!==generation)return;(session.audioEvidence??=[]).push({start:chunk.start,end:chunk.end,result:{status:'UNAVAILABLE',error:error.message}});render();}}}
  finally{if(token===generation)detectorBusy=false;}
 }
 function accept(chunk){if(!session)return;
  if(rms(chunk.pcm)<.0001)return;
  if(queue.length>=3){const skipped=queue.shift();gap(skipped,'Processing fell behind; this audio segment was dropped to bound memory and delay.');}
  queue.push(chunk);drain();
 }
 function acceptDetector(chunk){if(!session||rms(chunk.pcm)<.0001)return;if(detectorQueue.length>=2)detectorQueue.shift();detectorQueue.push(chunk);drainDetectors();}
 async function shutdown(discard=false){
  const current=graph;if(!current)return;graph=null;
  if(current.source?.stop){current.source.onended=null;try{current.source.stop();}catch{}}
  current.source?.disconnect();
  if(current.processor){if(!discard)await new Promise(resolve=>{let timer;const finish=()=>{clearTimeout(timer);current.flushDone=null;resolve();};current.flushDone=finish;timer=setTimeout(finish,500);current.processor.port.postMessage('flush');});current.processor.disconnect();current.processor.port.onmessage=null;}
  if(!discard)current.chunker?.flush();current.stream?.getTracks().forEach(track=>track.stop());
  current.gain?.disconnect();if(current.context.state!=='closed')await current.context.close();$('live-level').value=0;
 }
 async function stop(){if(stopping)return;stopping=true;starting=false;if(session)session.active=false;controls();status('Stopping capture; finishing buffered speech…');await shutdown();stopping=false;controls();$('pipeline-input').textContent='Capture stopped';if(!busy)status('Stopped · captured audio processed. Review transcription and any coverage gaps.');}
 async function reset(){generation++;controller?.abort();queue=[];busy=false;starting=false;stopping=true;controls();if(session)session.active=false;await shutdown(true);queue=[];session=null;stopping=false;controls();render();renderRisk();status('Live session cleared. Capture is off.');$('live-latency').textContent='';}
 async function connect(context,source,stream,audible=false){
  const token=generation;
  const chunker=new AudioChunker(context.sampleRate,accept),detectorChunker=new FixedWindowChunker(context.sampleRate,acceptDetector);await context.audioWorklet.addModule('/pcm-worklet.js');
  if(token!==generation||!starting)throw new Error('Capture cancelled.');
  const processor=new AudioWorkletNode(context,'capture-pcm');const gain=context.createGain();gain.gain.value=0;
  const current={context,source,stream,processor,gain,chunker,detectorChunker};graph=current;source.connect(processor);processor.connect(gain);gain.connect(context.destination);
  processor.port.onmessage=e=>{if(e.data.flushed){current.flushDone?.();return;}if(token!==generation||!session||!e.data.pcm)return;
  $('live-level').value=Math.min(1,rms(e.data.pcm)*8);chunker.push(e.data.pcm);if(capabilities?.deepfake)detectorChunker.push(e.data.pcm);
   if(chunker.total+chunker.size>=context.sampleRate*900&&session.active){status('15-minute prototype session limit reached.');stop();}
  };
  if(audible)source.connect(context.destination);
  await context.resume();
 }
 async function start(kind){
  if(!streamingReady()){status(capabilities?.asrBackend==='openai-whisper'?'The configured Whisper medium CPU backend is batch-only. Use a short recorded clip instead of continuous capture.':capabilities?.reasons?.deepfake||capabilities?.reasons?.asr||'Pella/AASIST are unavailable. Live audio capture was not started.');return;}
  if(starting||busy||stopping||session?.active)return;
  generation++;const token=generation;session={source:kind,mode:'live-asr',startedAt:new Date().toISOString(),active:false,entries:[],events:[],audioEvidence:[],gaps:0,peak:null};queue=[];detectorQueue=[];starting=true;render();renderRisk();controls();status('Opening audio source…');
  let stream,context;
  try{
   // Called directly from the user's click: the browser owns source/permission selection.
   if(kind==='Shared call audio'){
    if(!navigator.mediaDevices?.getDisplayMedia)throw new Error('Screen/tab audio capture is unavailable here. Open this URL in Chrome or Edge on Windows.');
    stream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include',selfBrowserSurface:'exclude'});
   }else if(kind==='Microphone / speakerphone')stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false},video:false});
   if(token!==generation||!starting){stream?.getTracks().forEach(t=>t.stop());return;}
   if(stream&&!stream.getAudioTracks().length)throw new Error('No audio track was shared. Select the call tab or an entire screen and enable Share audio. Window sharing may omit audio.');
   context=new AudioContext();graph={context,stream};
   if(stream){
    const source=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));await connect(context,source,stream);
    stream.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(session?.active)stop();},{once:true}));
   }else throw new Error('No microphone or shared audio source was selected.');
   if(token!==generation||!starting){await shutdown();return;}
  session.active=true;starting=false;controls();status(`${kind} · listening. Four-second windows are sent to Pella + AASIST; ASR text is optional. Video is neither processed nor uploaded.`);
  $('pipeline-input').textContent='Capturing audio';$('pipeline-text').textContent=capabilities?.asr?'Optional local ASR':'ASR unavailable';$('pipeline-analysis').textContent='Waiting for waveform';
  }catch(e){stream?.getTracks().forEach(t=>t.stop());if(token===generation){await shutdown();starting=false;session.active=false;status(`${e.name==='NotAllowedError'?'Audio sharing was cancelled or denied.':e.message}`);controls();}}
 }
 $('live-share').onclick=()=>start('Shared call audio');$('live-mic').onclick=()=>start('Microphone / speakerphone');
 $('live-stop').onclick=stop;
 $('live-clear').onclick=reset;
 window.addEventListener('beforeunload',()=>{graph?.stream?.getTracks().forEach(t=>t.stop());controller?.abort();});
 controls();render();renderRisk();
 return {reset,setCapabilities(value){
   capabilities=value;controls();
   $('live-capability').textContent=value?.deepfake
     ?`Live anti-spoof capture is available. Pella + AASIST receive exact four-second waveform windows. ${value.asr?'Optional local ASR is also available.':'ASR is unavailable; acoustic anti-spoof analysis remains active.'}`
     :value?.reasons?.deepfake||'Pella/AASIST unavailable. Live capture is disabled; check local model assets.';
 },snapshot:()=>session?structuredClone({...session,active:!!session.active,scope:'Unattributed captured speech. No automatic speaker separation. Explicit browser source selection required.'}):null};
}
