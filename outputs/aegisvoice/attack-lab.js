import { extractAttackObservation, classifyAttackPath, ATTACK_CLASSES } from './attack-model.mjs';
import { ATTACK_SIMULATIONS, simulateAttackCondition } from './attack-simulations.mjs';

const $=id=>document.getElementById(id);
const labelFor={
  'live-human':'Live human',
  'live-voice-conversion':'Live voice conversion',
  'direct-injection':'Injected pre-generated',
  'speaker-replay':'Replay through speaker'
};
const time=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const clamp=value=>Math.max(0,Math.min(1,Number(value)||0));

function mono(decoded){
  const result=new Float32Array(decoded.length);
  for(let channel=0;channel<decoded.numberOfChannels;channel++){
    const data=decoded.getChannelData(channel);
    for(let i=0;i<data.length;i++)result[i]+=data[i]/decoded.numberOfChannels;
  }
  return result;
}
function sliceWindow(parts,start,length){
  const out=new Float32Array(length);let written=0,offset=0;
  for(const part of parts){
    const end=offset+part.length;
    if(end>start&&offset<start+length){
      const from=Math.max(0,start-offset),to=Math.min(part.length,start+length-offset);
      out.set(part.subarray(from,to),written);written+=to-from;
    }
    offset=end;if(written>=length)break;
  }
  return out;
}
function metric(observation,...names){
  for(const name of names){
    const value=observation?.metrics?.[name]??observation?.profile?.[name]??observation?.temporal?.[name]??observation?.[name];
    if(Number.isFinite(value))return value;
  }
  return null;
}
function format(value,digits=2){return Number.isFinite(value)?value.toFixed(digits):'—';}

const chartToken=(canvas,name,fallback)=>getComputedStyle(canvas).getPropertyValue(name).trim()||fallback;
function lineChart(canvas,values,{color=null,min=-1,max=1}={}){
  const ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle=chartToken(canvas,'--chart-grid','#322c27');ctx.lineWidth=1;
  for(let y=1;y<4;y++){ctx.beginPath();ctx.moveTo(0,h*y/4);ctx.lineTo(w,h*y/4);ctx.stroke();}
  if(values.length<2)return;
  ctx.strokeStyle=color??chartToken(canvas,'--accent','#3b82f6');ctx.lineWidth=2;ctx.beginPath();
  const step=w/(values.length-1);
  values.forEach((value,index)=>{
    const y=h-(clamp((value-min)/(max-min))*h);
    index?ctx.lineTo(index*step,y):ctx.moveTo(0,y);
  });ctx.stroke();
}
function drawWaveform(pcm){
  if(!pcm?.length)return lineChart($('attack-waveform'),[]);
  const points=360,values=[];
  for(let i=0;i<points;i++){
    const from=Math.floor(i*pcm.length/points),to=Math.max(from+1,Math.floor((i+1)*pcm.length/points));
    let peak=0;for(let j=from;j<to;j++)if(Math.abs(pcm[j])>Math.abs(peak))peak=pcm[j];
    values.push(peak);
  }
  lineChart($('attack-waveform'),values);
}
function drawSpectrum(pcm){
  const canvas=$('attack-spectrum'),ctx=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  ctx.clearRect(0,0,w,h);
  if(!pcm?.length)return;
  const size=Math.min(1024,pcm.length),start=pcm.length-size,bins=72,energies=[];
  for(let bin=0;bin<bins;bin++){
    const frequency=(bin+1)*Math.PI/bins;let real=0,imag=0;
    for(let i=0;i<size;i++){const window=.5-.5*Math.cos(2*Math.PI*i/(size-1)),v=pcm[start+i]*window;real+=v*Math.cos(frequency*i);imag-=v*Math.sin(frequency*i);}
    energies.push(20*Math.log10(Math.sqrt(real*real+imag*imag)/size+1e-7));
  }
  const bar=w/bins;energies.forEach((db,i)=>{const height=clamp((db+75)/70)*h;ctx.fillStyle=`hsl(${222-i*.35} 72% ${42+i*.22}%)`;ctx.fillRect(i*bar,h-height,Math.max(1,bar-1),height);});
}
function drawContinuity(observations){
  const values=observations.map(o=>metric(o,'noiseContinuity','noiseFloorRms','noiseFloor','noiseRms','backgroundRms')).filter(Number.isFinite);
  if(values.length<2)return lineChart($('attack-continuity'),[]);
  const lo=Math.min(...values),hi=Math.max(...values);
  lineChart($('attack-continuity'),values,{color:chartToken($('attack-continuity'),'--spec-2','#a78bfa'),min:lo===hi?lo-.01:lo,max:lo===hi?hi+.01:hi});
}

export function initAttackLab(){
  let source='direct',observations=[],result=null,latestPcm=null;
  window.addEventListener('themechange',()=>render());
  let context=null,processor=null,stream=null,parts=[],samples=0,nextWindow=0,captureStart=0,captureRate=0,timer=null;
  let directWindows=[],operation=0,directController=null,busy=false;
  const windowSeconds=4,stepSeconds=1,maxCaptureSeconds=12;
  const contextFor=()=>({captureKind:source==='direct'?'digital-file':source,knownSource:source==='direct',referenceLabel:$('attack-reference-label').value||null});
  const operationActive=token=>token===operation;
  function setBusy(value){
    busy=value;
    for(const id of ['attack-direct','attack-mic','attack-share','attack-demo-select','attack-replay-select','attack-analyze-file','attack-start-capture'])$(id).disabled=value;
    $('attack-stop-capture').disabled=!value||!stream;
  }
  function supportEntry(key){
    const value=result?.classes?.[key]??result?.support?.[key]??0;
    return typeof value==='number'?{support:value,explanation:''}:value||{support:0,explanation:''};
  }
  function render(){
    const top=result?.topClass??result?.classification??null,sufficient=result?.sufficientEvidence===true;
    const hasLeadingClass=sufficient&&top&&top!=='uncertain'&&labelFor[top];
    $('attack-state').textContent=hasLeadingClass?labelFor[top].toUpperCase():'UNCERTAIN';
    $('attack-input-label').textContent=source==='direct'?'Known digital file':source==='microphone'?'Microphone capture':'Shared/tab audio';
    $('attack-action').textContent=!hasLeadingClass?'Collect more or better evidence':top==='live-voice-conversion'?'Treat as an adaptive attacker; verify out of band':top==='direct-injection'?'Block scripted/injected media and challenge dynamically':top==='speaker-replay'?'Assume leaked recording; rotate voice-dependent procedures':'Continue ordinary verification; identity is not established';
    $('attack-windows').textContent=`${observations.length} window${observations.length===1?'':'s'}`;
    const verdict=$('attack-verdict');verdict.className=`attack-verdict ${!hasLeadingClass?'uncertain':top==='live-human'?'supported':top==='direct-injection'||top==='speaker-replay'?'danger':'warning'}`;
    verdict.replaceChildren();
    const eyebrow=document.createElement('span');eyebrow.textContent=hasLeadingClass?'LEADING HYPOTHESIS':'UNCERTAIN';
    const title=document.createElement('b');title.textContent=hasLeadingClass?labelFor[top]:'Evidence does not separate the paths';
    const note=document.createElement('p');note.textContent=result
      ?result.sufficientEvidence
        ?result.topClass==='uncertain'
          ?'Several paths remain plausible. Collect a better source or more varied speech.'
          :'The leading path cleared this experimental model’s evidence and margin gates.'
        :'Minimum rolling evidence is not met.'
      :'At least four seconds and multiple windows are required.';
    verdict.append(eyebrow,title,note);
    for(const key of ATTACK_CLASSES??Object.keys(labelFor)){
      const entry=supportEntry(key),host=document.querySelector(`[data-class="${key}"]`),score=clamp(entry.support);
      host.querySelector('b').textContent=result?`${(score*100).toFixed(1)} / 100 support`:'—';
      host.querySelector('i').style.width=`${score*100}%`;
      host.querySelector('p').textContent=entry.explanation??entry.reason??'No evidence yet.';
    }
    const uncertainty=clamp(result?.uncertainty??1);
    $('attack-uncertainty').value=uncertainty;
    $('attack-uncertainty-label').textContent=uncertainty>.66?'High':uncertainty>.33?'Medium':'Low';
    const observation=observations.at(-1),profile=observation?.profile??observation,featureValues=[
      [profile?.reverbProxySeconds==null?'—':`${format(profile.reverbProxySeconds,3)} s`,'Reverberation proxy'],
      [source==='direct'?'Known digital':source==='microphone'?'Physical microphone':'Shared digital path','Capture provenance'],
      [metric(observation,'compressionProxy','codecProxy')==null?`high band ${format(profile?.highBandRatio,3)}`:format(metric(observation,'compressionProxy','codecProxy'),2),'Spectral / clipping proxy'],
      [metric(observation,'noiseContinuity','continuity')==null?'—':format(metric(observation,'noiseContinuity','continuity'),2),'Window-to-window stability'],
      [metric(observation,'harmonicity','periodicity')==null?'—':format(metric(observation,'harmonicity','periodicity'),2),'Signal periodicity proxy'],
      [`${Math.min(observations.length,12)} windows`,'Rolling windows used (maximum 12)']
    ];
    [...$('attack-features').children].forEach((box,index)=>{box.querySelector('b').textContent=featureValues[index][0];box.querySelector('small').textContent=featureValues[index][1];});
    const evidence=result?.evidence??[],$e=$('attack-evidence-list');$e.replaceChildren(...(evidence.length?evidence:['No decisive evidence yet.']).map(text=>{const li=document.createElement('li');li.textContent=typeof text==='string'?text:text.detail??text.reason??JSON.stringify(text);return li;}));
    const contradictions=result?.contradictions??[],$c=$('attack-contradictions');$c.replaceChildren(...(contradictions.length?contradictions:['No contradiction reported yet; absence is not validation.']).map(text=>{const li=document.createElement('li');li.textContent=typeof text==='string'?text:text.detail??text.reason??JSON.stringify(text);return li;}));
    $('attack-timeline').replaceChildren(...observations.map((observation,index)=>{
      const partial=classifyAttackPath(observations.slice(0,index+1),contextFor()),card=document.createElement('article');card.className='attack-window';
      const start=Number.isFinite(observation.start)?observation.start:index*stepSeconds,end=Number.isFinite(observation.end)?observation.end:start+windowSeconds;
      const t=document.createElement('time');t.textContent=`${time(start)}–${time(end)}`;
      const b=document.createElement('b');b.textContent=partial.sufficientEvidence&&partial.topClass!=='uncertain'&&labelFor[partial.topClass]?labelFor[partial.topClass]:'Uncertain';
      const span=document.createElement('span');span.textContent=`uncertainty ${Math.round(clamp(partial.uncertainty)*100)}%`;
      card.append(t,b,span);return card;
    }));
    if(!observations.length){const p=document.createElement('p');p.className='empty-state';p.textContent='Each completed analysis window will appear here.';$('attack-timeline').append(p);}
    drawWaveform(latestPcm);drawSpectrum(latestPcm);drawContinuity(observations);
  }
  function addWindow(pcm,rate,startSeconds){
    latestPcm=pcm;
    const previous=observations.at(-1)??null,observation=extractAttackObservation(pcm,rate,previous);
    observation.start=startSeconds;observation.end=startSeconds+windowSeconds;observations.push(observation);
    result=classifyAttackPath(observations,contextFor());render();
  }
  async function runSimulation(id){
    await reset(false);
    const token=operation;
    const simulation=simulateAttackCondition(id),condition=simulation.condition;
    if(!operationActive(token))return;
    source=condition.context.captureKind==='digital-file'?'direct':condition.context.captureKind;
    selectSource(source);$('attack-reference-label').value='';
    let previous=null;
    observations=simulation.windows.map((pcm,index)=>{
      latestPcm=pcm;const observation=extractAttackObservation(pcm,simulation.rate,previous);observation.start=index*1.1;observation.end=(index+1)*1.1;previous=observation;return observation;
    });
    result=classifyAttackPath(observations,{...condition.context,labCondition:{id:condition.id,label:condition.label,expectedClass:condition.expectedClass,simulated:true}});
    render();
    $('attack-status').textContent=`Controlled simulation: ${condition.description} The expected label was retained only for comparison and not fed into support scores.`;
  }
  async function analyzeFile(){
    await reset(false);source='direct';selectSource('direct');
    const token=operation,controller=new AbortController();directController=controller;setBusy(true);
    $('attack-status').textContent='Decoding the real WAV bytes in the browser...';
    try{
      const name=$('attack-demo-select').value,response=await fetch(`/demo-audio/${name}.wav`,{signal:controller.signal});
      if(!operationActive(token))return;
      if(!response.ok)throw new Error(`Audio request failed (HTTP ${response.status}).`);
      const bytes=await response.arrayBuffer();if(!operationActive(token))return;
      const decoder=new OfflineAudioContext(1,1,16000),decoded=await decoder.decodeAudioData(bytes);if(!operationActive(token))return;
      const pcm=mono(decoded),size=Math.floor(decoded.sampleRate*windowSeconds),step=Math.floor(decoded.sampleRate*stepSeconds);
      $('attack-player').src=`/demo-audio/${name}.wav`;
      let previous=null;directWindows=[];
      for(let start=0;start+size<=pcm.length;start+=step){
        const windowPcm=pcm.slice(start,start+size),observation=extractAttackObservation(windowPcm,decoded.sampleRate,previous);
        observation.start=start/decoded.sampleRate;observation.end=observation.start+windowSeconds;previous=observation;
        directWindows.push({observation,pcm:windowPcm});
      }
      $('attack-player').currentTime=0;syncDirectPlayback();
      await $('attack-player').play();if(!operationActive(token))return;
      $('attack-status').textContent=`Playing ${decoded.duration.toFixed(1)} seconds through rolling direct-file analysis. Pause or seek to inspect earlier evidence.`;
    }catch(error){if(operationActive(token)&&error.name!=='AbortError')$('attack-status').textContent=`Analysis failed: ${error.message}`;}
    finally{if(operationActive(token)){directController=null;setBusy(false);}}
  }
  function syncDirectPlayback(){
    if(source!=='direct'||!directWindows.length)return;
    const position=$('attack-player').currentTime;
    const available=directWindows.filter(item=>item.observation.end<=position+.04);
    observations=available.map(item=>item.observation);
    latestPcm=available.at(-1)?.pcm??null;
    result=observations.length?classifyAttackPath(observations,contextFor()):null;
    render();
    $('attack-status').textContent=`${time(position)} / ${time($('attack-player').duration||0)} · ${observations.length} rolling windows available. Support scores are not probabilities.`;
    $('attack-analyze-file').textContent=$('attack-player').paused?'Play + analyze waveform':'Pause analysis';
  }
  function selectSource(value){
    source=value;
    for(const [id,v] of [['attack-direct','direct'],['attack-mic','microphone'],['attack-share','shared-audio']]){
      const button=$(id);button.classList.toggle('selected',v===value);button.setAttribute('aria-pressed',String(v===value));
    }
    $('attack-direct-controls').hidden=value!=='direct';$('attack-capture-controls').hidden=value==='direct';
    $('attack-speaker-helper').hidden=value!=='microphone';
    $('attack-capture-help').textContent=value==='microphone'
      ?'Speak naturally for a live-human test, or play a clip through another physical speaker for a replay test. The optional label is not fed to classification.'
      :'Share a tab or screen with audio. This can carry direct injected media or an external live voice converter; the current heuristic may remain uncertain between them.';
    render();
  }
  async function startCapture(){
    await reset(false);selectSource(source);parts=[];samples=0;nextWindow=0;observations=[];result=null;
    const token=operation,selectedSource=source;setBusy(true);
    try{
      const candidate=selectedSource==='microphone'
        ?await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false},video:false})
        :await navigator.mediaDevices.getDisplayMedia({video:true,audio:true,systemAudio:'include'});
      if(!operationActive(token)){candidate.getTracks().forEach(track=>track.stop());return;}
      stream=candidate;
      if(!stream.getAudioTracks().length)throw new Error('The selected source contains no audio track.');
      context=new AudioContext();captureRate=context.sampleRate;await context.audioWorklet.addModule('/pcm-worklet.js');
      if(!operationActive(token)){stream.getTracks().forEach(track=>track.stop());await context.close();stream=null;context=null;return;}
      const input=context.createMediaStreamSource(new MediaStream(stream.getAudioTracks())),worklet=new AudioWorkletNode(context,'capture-pcm'),silent=context.createGain();silent.gain.value=0;
      input.connect(worklet);worklet.connect(silent);silent.connect(context.destination);processor={input,worklet,silent};
      for(const track of stream.getTracks())track.addEventListener('ended',()=>{if(operationActive(token))stopCapture();},{once:true});
      captureStart=performance.now();$('attack-stop-capture').disabled=false;
      $('attack-status').textContent='Capturing actual audio. Rolling analysis starts after four seconds.';
      worklet.port.onmessage=event=>{
        if(!operationActive(token)||!event.data.pcm)return;
        const block=event.data.pcm;parts.push(block);samples+=block.length;
        let energy=0;for(const value of block)energy+=value*value;$('attack-level').value=Math.min(1,Math.sqrt(energy/block.length)*8);
        const windowSize=Math.floor(context.sampleRate*windowSeconds),stepSize=Math.floor(context.sampleRate*stepSeconds);
        while(samples-nextWindow>=windowSize){addWindow(sliceWindow(parts,nextWindow,windowSize),context.sampleRate,nextWindow/context.sampleRate);nextWindow+=stepSize;}
        if(samples/context.sampleRate>=maxCaptureSeconds)stopCapture();
      };
      timer=setInterval(()=>{$('attack-status').textContent=`Capturing ${(Math.min(maxCaptureSeconds,(performance.now()-captureStart)/1000)).toFixed(1)} / ${maxCaptureSeconds} seconds...`;},250);
      await context.resume();
    }catch(error){
      if(!operationActive(token))return;
      await stopCapture(true);
      $('attack-status').textContent=`Capture failed: ${error.message}`;
    }
  }
  async function stopCapture(silent=false){
    clearInterval(timer);timer=null;
    if(processor?.worklet?.port)processor.worklet.port.onmessage=null;
    processor?.worklet?.disconnect();processor?.input?.disconnect();processor?.silent?.disconnect();processor=null;
    stream?.getTracks().forEach(track=>track.stop());stream=null;
    if(context&&context.state!=='closed')await context.close();context=null;
    $('attack-level').value=0;setBusy(false);
    if(!silent)$('attack-status').textContent=observations.length?`Capture stopped after ${format(samples/(captureRate||16000),1)} seconds. Compare the support and contradictions.`:'Capture stopped before a complete four-second window.';
  }
  async function reset(update=true){
    operation++;directController?.abort();directController=null;
    await stopCapture(true);observations=[];result=null;latestPcm=null;parts=[];samples=0;nextWindow=0;captureRate=0;
    $('attack-player').pause();$('attack-player').currentTime=0;$('attack-replay-player').pause();$('attack-replay-player').currentTime=0;directWindows=[];
    if(update)render();$('attack-status').textContent='Choose a path and start analysis.';
  }
  $('attack-direct').onclick=async()=>{await reset();selectSource('direct');};
  $('attack-mic').onclick=async()=>{await reset();selectSource('microphone');};
  $('attack-share').onclick=async()=>{await reset();selectSource('shared-audio');};
  $('attack-demo-select').onchange=async()=>{$('attack-player').src=`/demo-audio/${$('attack-demo-select').value}.wav`;await reset();};
  $('attack-replay-select').onchange=()=>{$('attack-replay-player').src=`/demo-audio/${$('attack-replay-select').value}.wav`;};
  $('attack-analyze-file').onclick=()=>directWindows.length?($('attack-player').paused?$('attack-player').play():$('attack-player').pause()):analyzeFile();$('attack-start-capture').onclick=()=>{if(!busy)startCapture();};$('attack-stop-capture').onclick=stopCapture;$('attack-reset').onclick=reset;
  $('attack-reference-label').onchange=()=>{if(observations.length){result=classifyAttackPath(observations,contextFor());render();}};
  for(const button of document.querySelectorAll('[data-attack-simulation]'))button.onclick=()=>runSimulation(button.dataset.attackSimulation);
  $('attack-export').onclick=()=>{
    const report={application:'AegisVoice attack lab',exportedAt:new Date().toISOString(),source,referenceLabel:$('attack-reference-label').value||null,referenceLabelUsedForClassification:false,windowSeconds,stepSeconds,observations,result,limitations:['Support values are normalized hypothesis weights, not probabilities.','Calibration uses controlled simulations, not independent real attacks.','No speaker identity or voice-clone authenticity is established.']};
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`aegisvoice-attack-lab-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  for(const event of ['timeupdate','seeked','play','pause','ended'])$('attack-player').addEventListener(event,syncDirectPlayback);
  $('attack-player').src='/demo-audio/payment-pressure.wav';$('attack-replay-player').src='/demo-audio/payment-pressure.wav';render();
  async function stopAll(){ $('attack-player').pause();$('attack-replay-player').pause();await stopCapture(true); }
  return {reset,stop:stopAll,snapshot:()=>structuredClone({source,observations,result})};
}
