import { analyze, fuseAssessment, categories, createChallenge, checkPhrase, assessLiveness, channelProfile } from './engine.mjs';
import { buildTrace, traceSummary } from './reasoning.mjs';
import { apiModel, renderLearned, renderReplay, initDatasetLab } from './dataset-lab.js';
import { initLiveCall } from './live-call.js';
import { initWorkspace, openView } from './workspace.js';
import { initDemos, renderCall } from './demos.js';
import { buildAsrTurns, evidenceUpdate } from './demo-session.mjs';
import { directDecision, decisionTone, displayRuleState } from './decision.mjs';
import { initAttackLab } from './attack-lab.js';
import { CALL_CASES, CASE_GROUPS, casesFor, caseById } from './case-library.mjs';
import { MAX_MEDIA_MEGABYTES, assertMediaInput, configureMediaInput } from './media-input.mjs';
import { buildEvidenceReport, hasSyntheticVoiceEvidence, referenceEvidence } from './evidence-boundary.mjs';
const $ = id => document.getElementById(id);
let turns = [], assessment = analyze([]), challenge = null, challengeResult = null;
let recorder = null, mediaStream = null, recordingUrl = null, recordingBlob = null, recordingChunks = [], promptEnd = null, replyStart = null, intervalMs = null;
let asrAvailable=false, transcribing=false, responseSource='manual', responseASR=null, sessionRevision=0;
let learned=null, modelRequest=0, modelQueue=Promise.resolve(), replayAvailable=false, replyReplay=null, callerReplay=null, selectedDataset=null, selectedCase=null;
let callerProfile=null, replyProfile=null, profileRevision=0;
let deepfakeAvailable=false, speakerAvailable=false, callerDeepfake=null, replyDeepfake=null, speakerComparison=null;
let capabilities=null, liveCall=null, demoPlayback=null, datasetLab=null, sourceMode='demo', readiness;
let attackLab=null;
let databaseCatalogue=null,databaseBusy=false;
let recordedSession=null, recordedController=null, recordedRevision=0;
let labAudioBlob=null,labAudioUrl=null,labRecorder=null,labStream=null,labChunks=[];
let lastExplanation=[];
const intentSupports=language=>(capabilities?.intentLanguages??['en']).includes(language);
function renderReasoning(assessment,context={}){
  const trace=buildTrace(assessment,context),summary=traceSummary(trace);
  lastExplanation=trace;
  const stream=$('reasoning-stream');stream.replaceChildren();
  setText('reasoning-count',`${summary.steps} explanation entries`);
  for(const s of trace){
    const li=node('li',undefined,`reasoning-step tone-${s.tone}`);
    li.append(node('div',s.label,'stage-badge'));
    const body=node('div');
    const head=node('h4');head.append(document.createTextNode(s.title));
    if(s.weight)head.append(node('span',s.weight,`weight-pill weight-${s.weight}`));
    if(s.turn)head.append(node('span',`turn ${s.turn}`,'turn-chip'));
    if(s.language)head.append(node('span',s.language,'turn-chip'));
    body.append(head,node('p',s.detail));
    if(s.caveat)body.append(node('p',s.caveat,'caveat'));
    li.append(body);stream.append(li);
  }
}
function renderModelEvidence(id,result,error){
  const host=$(id);host.hidden=false;host.replaceChildren();
  if(error){host.append(node('b','Model unavailable'),node('p',error));return;}
  host.append(node('b',result.status||result.model||'Model evidence'));
  if(result.detectors)for(const [name,value] of Object.entries(result.detectors))host.append(node('p',value.available?`${name}: ${value.label} · score ${value.score.toFixed(3)} (${value.scope})`:`${name}: unavailable · ${value.error}`));
  if(Number.isFinite(result.cosineSimilarity))host.append(node('p',`ECAPA cosine similarity ${result.cosineSimilarity.toFixed(3)} · ${result.decision}`));
  host.append(node('small',result.warning||'Supplementary evidence only; identity is not established.'));
}
async function compareSpeaker(reference,comparison){
  assertMediaInput(reference,'Reference media');assertMediaInput(comparison,'Comparison media');
  const ref=await reference.arrayBuffer(),header=new ArrayBuffer(4);new DataView(header).setUint32(0,ref.byteLength);
  const body=new Blob([header,ref,await comparison.arrayBuffer()]);
  const response=await fetch('/api/speaker',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Speaker comparison failed.');return data;
}
async function profileAudio(source){
  assertMediaInput(source,'Audio-bearing media');
  const bytes=await source.arrayBuffer();
  const context=new OfflineAudioContext(1,1,16000);
  const decoded=await context.decodeAudioData(bytes);
  if(decoded.duration>120)throw new Error('Use an audio clip under two minutes.');
  const channels=decoded.numberOfChannels,length=Math.min(decoded.length,8*16000),mono=new Float32Array(length);
  for(let c=0;c<channels;c++){const data=decoded.getChannelData(c);for(let i=0;i<length;i++)mono[i]+=data[i]/channels;}
  return {...channelProfile(mono,16000),scope:'First eight seconds maximum; resampled to 16 kHz.'};
}
const demos = {
  suspicious: [
    {role:'caller', text:"This is the CFO. I need you to transfer 20 lakh within the next twenty minutes."},
    {role:'employee', text:'Should I confirm the beneficiary with our finance team?'},
    {role:'caller', text:"Use the new account details. Skip the usual approval. Don't call me back. Keep this between us."}
  ],
  legitimate: [
    {role:'caller',text:'This payment is urgent. Please complete the usual approval.'},
    {role:'employee',text:'I will check the beneficiary before processing it.'},
    {role:'caller',text:'Yes, call the vendor on our saved number. Follow the normal procedure.'}
  ],
  negation: [
    {role:'caller',text:'Do not transfer the money. Never skip the usual approval.'},
    {role:'employee',text:'The earlier message said, "Send money immediately and keep this between us."'},
    {role:'caller',text:'For training, the example says "skip approval". Do not share your OTP.'}
  ],
  arrest: [
    {role:'caller',text:'This is the police officer handling your case. A case has been registered against your account and an arrest warrant is ready.'},
    {role:'employee',text:'Can I call the station back on the published number?'},
    {role:'caller',text:'Your account will be blocked today. Transfer the money to the verification account now. Do not tell anyone. Skip the usual approval.'}
  ],
  lure: [
    {role:'caller',text:'Congratulations, you have won our lucky draw prize money and a refund is pending on your account.'},
    {role:'employee',text:'How is the amount released?'},
    {role:'caller',text:'Complete your KYC verification immediately and read out the OTP you just received so I can confirm your identity.'}
  ]
};

function renderCasePreview(){
  const item=caseById($('case-select').value);if(!item)return;
  const result=analyze(item.turns);
  $('case-reference').className=`case-reference ${item.reference}`;
  setText('case-reference',`${item.reference} · authored reference`);
  setText('case-title',item.title);setText('case-summary',item.summary);setText('case-why',item.why);
  setText('case-result',`${result.state}${result.actionNames.length?` · ${result.actionNames.join(' / ')}`:''}`);
  setText('case-reason',`${result.reason} ${result.detected.length?`Matched: ${result.detected.map(key=>categories[key].name).join(', ')}.`:'No active category match.'}`);
  setText('case-transcript',item.turns.map(turn=>`${turn.role==='caller'?'Caller':'Employee'}: ${turn.text}`).join('\n\n'));
  $('case-audio').hidden=!item.audio;
}
function refreshCaseLibrary(){
  const cases=casesFor($('case-filter').value),current=$('case-select').value;
  $('case-select').replaceChildren(...cases.map(item=>{const option=node('option',`${item.title} · ${item.reference}`);option.value=item.id;return option;}));
  if(cases.some(item=>item.id===current))$('case-select').value=current;
  setText('case-count',`${cases.length} CASE${cases.length===1?'':'S'}`);renderCasePreview();
}
function initCaseLibrary(){
  $('case-filter').replaceChildren(...CASE_GROUPS.map(group=>{const option=node('option',group.label);option.value=group.id;return option;}));
  $('case-filter').onchange=refreshCaseLibrary;$('case-select').onchange=renderCasePreview;
  $('case-load').onclick=()=>{
    const item=caseById($('case-select').value);if(!item)return;
    sessionRevision++;profileRevision++;selectedDataset=null;selectedCase={id:item.id,title:item.title,reference:item.reference,why:item.why,labelUsedForInference:false};
    callerReplay=null;callerProfile=null;$('call-audio').value='';$('call-replay').hidden=true;resetChallenge();
    turns=item.turns.map(turn=>({...turn}));$('utterance').value='';
    setText('input-status',`${item.title} loaded. The authored ${item.reference} reference is not an inference input.`);
    renderTurns();renderAnalysis();$('assessment').scrollIntoView({behavior:'smooth',block:'center'});
  };
  $('case-audio').onclick=async()=>{
    const item=caseById($('case-select').value);if(!item?.audio)return;
    openView('desk');await chooseSource('demo');$('demo-select').value=item.audio;$('demo-select').dispatchEvent(new Event('change'));
  };
  refreshCaseLibrary();
}

function node(tag, text, cls) { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; }
function setText(id, text) { $(id).textContent=text; }
function renderTurns() {
  $('turns').replaceChildren();
  if (!turns.length) {const e=node('div',undefined,'empty');e.append(node('b','A conversation starts here'),node('p','Add a turn below or load a scenario to inspect the evidence.'));$('turns').append(e);}
  turns.forEach((turn,i)=>{const el=node('article',undefined,`turn ${turn.role}`);el.id=`turn-${i+1}`;const meta=node('div',undefined,'turn-meta');meta.append(node('span',turn.role),node('span',`Turn ${i+1}`));el.append(meta,node('p',turn.text));$('turns').append(el);});
  setText('turn-count',`${turns.length} turn${turns.length===1?'':'s'}`);$('turns').scrollTop=$('turns').scrollHeight;
}
function evidenceItem(item, label, safe=false) {
  const el=node('div',undefined,`evidence-item${safe?' safeguard':''}`), top=node('div');
  const link=node('a',`Turn ${item.turn} ↗`);link.href=`#turn-${item.turn}`;
  top.append(node('strong',label),link);
  const p=node('p'); const at=item.text.toLowerCase().indexOf(item.phrase.toLowerCase());
  if(at>=0)p.append(document.createTextNode(item.text.slice(0,at)),node('mark',item.text.slice(at,at+item.phrase.length)),document.createTextNode(item.text.slice(at+item.phrase.length)));else p.textContent=item.text;
  el.append(top,p);return el;
}
function renderAnalysis() {
  assessment=analyze(turns);
  learned=null;const request=++modelRequest;renderLearned(null);
  const empty=!turns.some(t=>t.role==='caller');
  const cls=decisionTone(null,assessment);
  $('assessment').className=`assessment ${cls}`;
  $('assessment').replaceChildren(node('div',empty?'WAITING FOR CALLER EVIDENCE':'REQUEST RISK · RULE BASELINE','eyebrow'),node('h3',empty?'Ready to inspect':displayRuleState(assessment.state)),node('p',empty?'Add caller speech to see the assessment.':assessment.reason));
  setText('actions',assessment.actionNames.join(' · ')|| (empty?'Not assessed':'No action matched'));
  $('count').replaceChildren(document.createTextNode(empty?'— ':`${assessment.detected.length} `),node('small',`/ ${Object.keys(categories).length}`));
  $('category-list').replaceChildren(...Object.entries(categories).map(([key,c])=>node('span',c.name,`category${assessment.detected.includes(key)?' detected':''}`)));
  $('evidence').replaceChildren(...assessment.evidence.map(e=>evidenceItem(e,e.name)),...assessment.safeguards.map(e=>evidenceItem(e,'Supports normal verification',true)));
  if(!assessment.evidence.length&&!assessment.safeguards.length)$('evidence').append(node('p',empty?'Each finding will link back to a caller turn.':'No supported category matches. Unrecognized wording can be missed by this baseline.','helper'));
  setText('evidence-count',assessment.evidence.length?`${assessment.evidence.length} matches`:'');
  $('excluded-wrap').hidden=!assessment.excludedEvidence.length;
  $('excluded').replaceChildren(...assessment.excludedEvidence.map(e=>node('p',`Turn ${e.turn}: “${e.phrase}” — ${e.reason}`)));
  if(!empty){
    renderReasoning(assessment,{source:'Transcript analysed',channel:callerProfile});
    renderLearned(null,'Checking whether the local classifier can run...');
    const callerInput=turns.map(t=>({role:t.role,text:t.text}));
    modelQueue=modelQueue.then(async()=>{
      await readiness;
      if(request!==modelRequest)return null;
      if(!capabilities?.intent||!intentSupports(assessment.language?.language)){
        const status=!intentSupports(assessment.language?.language)?`Classifier withheld for ${assessment.language?.language||'unknown'}; trained languages: ${(capabilities?.intentLanguages??['en']).join(', ')}.`:capabilities?.reasons?.intent||'Local classifier unavailable. Explicit rules only.';
        renderLearned(null,status);
        renderReasoning(assessment,{source:'Transcript analysed',model:{usable:false,status}});
        return null;
      }
      return apiModel('intent',{turns:callerInput});
    }).then(result=>{
      if(!result||request!==modelRequest)return;learned=result;renderLearned(result);assessment=fuseAssessment(assessment,result);
      renderReasoning(assessment,{source:'Transcript analysed',model:result,channel:callerProfile});
      const decision=directDecision(assessment,result),cls=decisionTone(decision,assessment);
      $('assessment').className=`assessment ${cls}`;
      $('assessment').replaceChildren(node('div',`CALL-CONTENT RISK · LEVEL ${decision.rank}/4 · ${decision.levelName}`,'eyebrow'),node('h3',decision.label),node('p',decision.reason));
    }).catch(e=>{if(request===modelRequest)renderLearned(null,`Model unavailable: ${e.message.replace(/\.$/,'')}. Explicit rule evidence is still shown.`);});
  }else{
    lastExplanation=[];$('reasoning-stream').replaceChildren();setText('reasoning-count','No analysis yet');
  }
}
function parseTranscript(text, fallback) {
  const result=[]; let current=null;
  for(const line of text.split(/\r?\n/)) {
    const m=line.match(/^\s*(caller|employee)\s*:\s*(.*)$/i);
    if(m){if(current?.text.trim())result.push(current);current={role:m[1].toLowerCase(),text:m[2]};}
    else if(line.trim()){if(!current)current={role:fallback,text:line};else current.text+='\n'+line;}
  }
  if(current?.text.trim())result.push(current);return result;
}
$('turn-form').addEventListener('submit',event=>{
  event.preventDefault();const text=$('utterance').value.trim();if(!text){setText('input-status','Enter a conversation turn first.');$('utterance').focus();return;}
  if(turns.reduce((sum,t)=>sum+t.text.length,0)+text.length>100000){setText('input-status','Session text limit reached. Export and reset to continue.');return;}
  selectedCase=null;turns.push(...parseTranscript(text,$('role').value));$('utterance').value='';setText('input-status','Updated using all caller turns.');renderTurns();renderAnalysis();
});
document.querySelectorAll('[data-demo]').forEach(b=>b.addEventListener('click',()=>{sessionRevision++;selectedDataset=null;selectedCase=null;callerReplay=null;callerProfile=null;profileRevision++;$('call-audio').value='';$('call-replay').hidden=true;resetChallenge();turns=demos[b.dataset.demo].map(t=>({...t}));setText('input-status','Authored text example loaded, not recognized speech.');renderTurns();renderAnalysis();}));

function releaseMedia() { if(mediaStream){mediaStream.getTracks().forEach(t=>t.stop());mediaStream=null;}if(labStream){labStream.getTracks().forEach(t=>t.stop());labStream=null;} }
function clearAudio() {if(recordingUrl)URL.revokeObjectURL(recordingUrl);recordingUrl=null;recordingBlob=null;replyProfile=null;replyReplay=null;responseASR=null;responseSource='manual';$('response').value='';$('reply-replay').hidden=true;$('inspect-reply').disabled=true;$('transcribe-reply').disabled=true;$('playback').removeAttribute('src');$('playback').hidden=true;$('download-audio').hidden=true;}
function resetChallenge() {
  if(recorder&&recorder.state!=='inactive'){recorder.onstop=null;recorder.stop();}recorder=null;releaseMedia();clearAudio();
  challenge=null;challengeResult=null;promptEnd=null;replyStart=null;intervalMs=null;responseSource='manual';responseASR=null;replyProfile=null;
  setText('phrase','Three tokens. One fresh response.');setText('challenge-status','NO ACTIVE CHALLENGE');setText('expiry','Challenges expire after two minutes and are single-use.');
  $('response').value='';for(const id of ['record','stop','prompt-end','reply-start','response','check'])$(id).disabled=true;
  setText('record-status','Microphone idle');setText('timing-status','Operator-marked interval; not automatic speech-onset detection.');setText('challenge-result','No response checked yet.');$('challenge-result').className='challenge-result';$('liveness').hidden=true;
}
function isActive() { return challenge && !challengeResult && Date.now()<challenge.expiresAt; }
$('generate').addEventListener('click',()=>{
  resetChallenge();challenge=createChallenge();setText('phrase',challenge.phrase);setText('challenge-status','CHALLENGE ISSUED');
  for(const id of ['record','prompt-end','response','check'])$(id).disabled=false;updateExpiry();
});
function updateExpiry() {
  if(!challenge||challengeResult)return;
  const sec=Math.max(0,Math.ceil((challenge.expiresAt-Date.now())/1000));setText('expiry',`Single-use challenge · expires in ${sec}s`);
  if(!sec){setText('challenge-status','CHALLENGE EXPIRED');for(const id of ['record','prompt-end','reply-start','response','check','transcribe-reply'])$(id).disabled=true;if(recorder?.state==='recording')recorder.stop();setText('challenge-result','Inconclusive — challenge expired. Issue a fresh phrase to retry.');}
}
setInterval(updateExpiry,500);
$('record').addEventListener('click',async()=>{
  if(!isActive())return;
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setText('record-status','Recording is unavailable in this browser. Phrase checks still work.');return;}
  const session=challenge.id;$('record').disabled=true;setText('record-status','Requesting microphone…');
  try {
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    if(!isActive()||challenge.id!==session){stream.getTracks().forEach(t=>t.stop());return;}
    mediaStream=stream;clearAudio();const capturedChunks=[];
    const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(t=>MediaRecorder.isTypeSupported(t));
    recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);
    const currentRecorder=recorder;
    recorder.ondataavailable=e=>{if(e.data.size)capturedChunks.push(e.data);};
    recorder.onerror=()=>{releaseMedia();setText('record-status','Recording failed. Retry or use transcript entry.');$('stop').disabled=true;$('record').disabled=!isActive();};
    recorder.onstop=()=>{
      const blob=new Blob(capturedChunks,{type:currentRecorder.mimeType});stream.getTracks().forEach(t=>t.stop());if(mediaStream===stream)mediaStream=null;
      if(challenge?.id!==session)return;
      recordingBlob=blob;recordingUrl=URL.createObjectURL(blob);$('playback').src=recordingUrl;$('playback').hidden=false;$('transcribe-reply').disabled=!asrAvailable||!isActive();$('inspect-reply').disabled=!replayAvailable;
      $('deepfake-reply').disabled=!deepfakeAvailable;$('compare-speaker').disabled=!speakerAvailable||!$('call-audio').files[0];
      replyProfile=null;profileAudio(blob).then(p=>{if(recordingBlob===blob){replyProfile=p;refreshLiveness();}}).catch(error=>{if(recordingBlob===blob)setText('record-status',`Audio profile unavailable: ${error.message}`);});
      $('download-audio').href=recordingUrl;$('download-audio').download=`challenge-${session}.${blob.type.includes('mp4')?'m4a':'webm'}`;$('download-audio').hidden=false;
      setText('record-status','Recording ready for playback');$('stop').disabled=true;$('record').disabled=!isActive();
    };
    recorder.start();setText('record-status','Recording microphone');$('stop').disabled=false;
  }catch(error){releaseMedia();setText('record-status',error.name==='NotAllowedError'?'Microphone permission denied. Transcript entry still works.':'Microphone unavailable. Transcript entry still works.');$('record').disabled=!isActive();}
});
$('stop').addEventListener('click',()=>{if(recorder?.state==='recording')recorder.stop();});
$('prompt-end').addEventListener('click',()=>{if(!isActive())return;promptEnd=performance.now();$('prompt-end').disabled=true;$('reply-start').disabled=false;setText('timing-status','Prompt end marked. Mark reply start when you hear the caller begin.');});
$('reply-start').addEventListener('click',()=>{if(!isActive()||promptEnd===null)return;replyStart=performance.now();intervalMs=replyStart-promptEnd;$('reply-start').disabled=true;setText('timing-status',`${(intervalMs/1000).toFixed(2)} s · operator-marked interval, includes reaction and call delay. Not used to pass or fail.`);});
$('check').addEventListener('click',()=>{
  if(!isActive()){updateExpiry();return;}
  if(recorder?.state==='recording'){setText('challenge-result','Stop recording and review the reply before checking.');return;}
  const text=$('response').value.trim();if(!text){setText('challenge-result','Inconclusive — enter the caller’s response transcript before checking.');$('response').focus();return;}
  const outcome=checkPhrase(challenge.phrase,text);const liveness=assessLiveness({outcome,replay:replyReplay,intervalMs,replyProfile,callProfile:callerProfile});
  challengeResult={outcome,response:text,transcriptSource:responseSource,asrEvidence:responseASR,replayEvidence:replyReplay,intervalMs,timingSource:intervalMs===null?'not measured':'operator markers',checkedAt:Date.now(),identity:'Not established',liveness};
  if(recorder?.state==='recording')recorder.stop();
  for(const id of ['record','prompt-end','reply-start','response','check','transcribe-reply'])$(id).disabled=true;
  setText('challenge-status','CHALLENGE CONSUMED');setText('expiry','This phrase cannot be checked again. Issue a new challenge to retry.');
  $('challenge-result').className=`challenge-result${outcome==='Incorrect'?' bad':''}`;
  setText('challenge-result',outcome==='Completed'?'Completed — the entered transcript matches. Identity is not established; the request assessment remains unchanged.':'Incorrect — the entered transcript does not match. This may reflect a misheard phrase or transcription error. It is not proof of a deepfake.');
  renderLiveness(liveness);
});
function renderLiveness(result){
  const host=$('liveness');host.hidden=false;
  host.className=`liveness-result ${result.state==='Replay-suspected'?'bad':result.state==='Live-consistent'?'good':''}`;
  host.replaceChildren(node('b',`Voice liveness · ${result.state}`),node('p',result.reason));
  host.append(node('small',`Evidence: ${result.support} · replay evidence: ${result.replayStatus||'not run'} · identity: ${result.identity}.`));
  host.append(node('small',`Channel statistics: ${result.channel.state}${result.channel.distance===null?'':` · heuristic distance ${result.channel.distance.toFixed(2)}`}. Not a probability of liveness.`));
  if(result.channel.state==='not compared')host.append(node('small','Comparable reference and recorded-reply profiles are both required for a channel comparison.'));
  host.append(node('small',`Not validated for: ${result.doesNotCover}`));
  if(result.intervalMs!==null&&result.intervalMs!==undefined)host.append(node('small',`Operator-marked interval ${(result.intervalMs/1000).toFixed(2)} s · recorded only, not used to decide this outcome.`));
}
function refreshLiveness(){
  if(!challengeResult)return;
  challengeResult.replayEvidence=replyReplay;
  challengeResult.liveness=assessLiveness({outcome:challengeResult.outcome,replay:replyReplay,intervalMs,replyProfile,callProfile:callerProfile});
  renderLiveness(challengeResult.liveness);
}
$('reset').addEventListener('click',async()=>{cancelRecorded();demoPlayback.reset();await attackLab.reset();await liveCall.reset();if(labRecorder?.state==='recording')labRecorder.stop();setLabAudio(null,'');$('lab-audio').value='';sessionRevision++;profileRevision++;turns=[];selectedDataset=null;selectedCase=null;callerReplay=null;callerProfile=null;replyProfile=null;$('call-replay').hidden=true;resetChallenge();$('utterance').value='';$('call-audio').value='';setText('input-status','Session cleared.');renderTurns();renderAnalysis();renderCall(null);});
$('export').addEventListener('click',()=>{
  const currentDecision=turns.some(turn=>turn.role==='caller')?directDecision(assessment,learned):null;
  const report=buildEvidenceReport({version:'0.3.0',turns,assessment,learnedModel:learned,decision:currentDecision,transcriptSource:recordedSession?.transcriptSource??(selectedDataset?'dataset-transcript':'manual-or-authored'),callerReplay,replyReplay,callerProfile,replyProfile,callerDeepfake,replyDeepfake,speakerComparison,datasetRecord:selectedDataset,authoredCase:selectedCase,challenge:challenge?{...challenge,result:challengeResult,replayEvidence:replyReplay}:null,challengeResult,liveSession:liveCall.snapshot(),guidedDemo:demoPlayback.snapshot(),recordedSession,attackLab:attackLab.snapshot(),explanation:lastExplanation,capabilities,limitations:['No independently labelled corpus of interactive human scam calls; deployment validation is missing','Robocalls are mostly automated/prerecorded and do not validate interactive human vishing','Scam model uses mixed synthetic, publisher-labelled, and weak-labelled text evidence','Hindi, Hinglish and Marathi coverage is explicit rules only, with no measured accuracy','Replay, synthetic-voice, and call-content results are separate evidence dimensions','No identity verification']});
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=node('a');a.href=url;a.download=`aegisvoice-evidence-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function transcribe(blob,signal) {
  assertMediaInput(blob,'Audio-bearing media');
  if(transcribing)throw new Error('A transcription is already running.');
  transcribing=true;
  try {const res=await fetch('/api/transcribe',{method:'POST',headers:{'Content-Type':'application/octet-stream'},signal,body:blob});const data=await res.json();if(!res.ok)throw new Error(data.error||'Transcription failed.');return data;}
  finally{transcribing=false;}
}
async function assessRecognizedEntries(entries,events){
  const turns=buildAsrTurns(entries),rules=events.at(-1)?.assessment??analyze(turns);
  if(!capabilities?.intent||!intentSupports(rules.language?.language))return {assessment:rules,model:null};
  try{
    const model=await apiModel('intent',{turns}),assessment=fuseAssessment(rules,model),entry=entries.at(-1);
    events.push({at:entry?.end??0,state:assessment.state,previousState:rules.state,stage:'model',riskBand:model.risk_band,modelDecision:model.usable?model.decision:'AUDIO / TRANSCRIPT NOT ANALYSABLE',
      reason:`Local classifier score ${model.score.toFixed(3)}. ${model.usable?'Combined with explicit rules; it cannot clear an explicit warning.':model.status}`,
      transcriptSource:'local-asr',text:entry?.text??'',assessment});
    return {assessment,model};
  }catch(error){
    const entry=entries.at(-1);events.push({at:entry?.end??0,state:rules.state,stage:'model-error',reason:`Classifier unavailable: ${error.message}. Rule result retained.`,transcriptSource:'local-asr',text:entry?.text??'',assessment:rules});
    return {assessment:rules,model:null,modelError:error.message};
  }
}
function recognizedEntries(result){
  return (result?.segments??[]).filter(segment=>typeof segment?.text==='string'&&segment.text.trim()).map(segment=>({...segment,text:segment.text.trim(),role:'caller',kind:'speech',transcriptSource:'local-asr'}));
}
async function buildRecordedAnalysis(result,details={}){
  const entries=recognizedEntries(result);
  if(!entries.length)throw new Error('No usable speech was recognized in this recording. Try a clearer clip with audible speech.');
  const prefix=[],events=[];let previousAssessment=null;
  for(const entry of entries){
    prefix.push(entry);
    const event=evidenceUpdate(buildAsrTurns(prefix),entry,previousAssessment?.state??null,previousAssessment);
    events.push(event);previousAssessment=event.assessment;
  }
  const intent=await assessRecognizedEntries(entries,events);
  return {...details,transcriptSource:'local-asr',model:result.model,backend:result.backend,inference_ms:result.inference_ms,duration:result.duration,text:result.text,entries,events,assessment:intent.assessment,intentModel:intent.model,decision:directDecision(intent.assessment,intent.model),modelError:intent.modelError??null,gaps:0};
}
function detectionSummary(session){
  const decision=session.decision??directDecision(session.assessment,session.intentModel);
  return decision.rank?`LEVEL ${decision.rank}/4 ${decision.levelName} · ${decision.label}`:decision.label;
}
function renderRecordedMonitor(session,input,mode){
  recordedSession=session;renderCall(session);setText('session-mode',mode);
  setText('pipeline-input',input);setText('pipeline-text',`${session.entries.length} recognized segment${session.entries.length===1?'':'s'}`);
  setText('pipeline-analysis',detectionSummary(session));
}
function loadRecordedTranscript(session,dataset){
  sessionRevision++;selectedDataset=dataset;selectedCase=null;turns=buildAsrTurns(session.entries);$('utterance').value='';
  renderTurns();renderAnalysis();setText('lab-transcript-preview',session.text);
}
function updateLabAudioControls(){
  const ready=Boolean(labAudioBlob);
  $('lab-transcribe').disabled=!ready||!asrAvailable;
  $('lab-replay').disabled=!ready||!replayAvailable;
  $('lab-deepfake').disabled=!ready||!deepfakeAvailable;
  $('lab-transcribe').title=!ready?'Select a media file first.':!asrAvailable?capabilities?.reasons?.asr||'Local speech recognition is unavailable.':'Transcribe the selected audio locally';
  $('lab-replay').title=!ready?'Select a media file first.':!replayAvailable?capabilities?.reasons?.replay||'Replay analysis is unavailable.':'Run fresh replay analysis';
  $('lab-deepfake').title=!ready?'Select a media file first.':!deepfakeAvailable?capabilities?.reasons?.deepfake||'Pella and AASIST are unavailable.':'Run fresh synthetic-voice analysis';
}
function setLabAudio(blob,label){
  if(labAudioUrl)URL.revokeObjectURL(labAudioUrl);
  labAudioBlob=blob;labAudioUrl=blob?URL.createObjectURL(blob):null;
  if(blob){$('lab-playback').src=labAudioUrl;$('lab-playback').hidden=false;setText('lab-audio-status',`${label} · ${(blob.size/1048576).toFixed(2)} MB. Selected but not analyzed yet — press Transcribe & analyze audio.`);setText('lab-transcript-preview','This newly selected recording has not been analyzed yet.');}
  else{$('lab-playback').pause();$('lab-playback').removeAttribute('src');$('lab-playback').hidden=true;setText('lab-audio-status',`Select audio or an audio-bearing MP4/M4A. Maximum ${MAX_MEDIA_MEGABYTES} MB / 2 minutes.`);}
  $('lab-model-result').hidden=true;updateLabAudioControls();
}
$('lab-audio').addEventListener('change',()=>{const input=$('lab-audio'),file=input.files[0];try{if(file)assertMediaInput(file,'Selected media');setLabAudio(file||null,file?file.name:'');}catch(error){input.value='';setLabAudio(null,'');setText('lab-audio-status',error.message);}});
$('lab-record').addEventListener('click',async()=>{
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){setText('lab-audio-status','Microphone recording is unavailable in this browser. Upload audio instead.');return;}
  try{
    labStream=await navigator.mediaDevices.getUserMedia({audio:true});labChunks=[];
    const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
    labRecorder=new MediaRecorder(labStream,mime?{mimeType:mime}:undefined);
    labRecorder.ondataavailable=event=>{if(event.data.size)labChunks.push(event.data);};
    labRecorder.onstop=()=>{const blob=new Blob(labChunks,{type:labRecorder.mimeType||'audio/webm'});labStream?.getTracks().forEach(track=>track.stop());labStream=null;labRecorder=null;$('lab-record').disabled=false;$('lab-stop').disabled=true;setLabAudio(blob,'Microphone recording');};
    labRecorder.start();$('lab-record').disabled=true;$('lab-stop').disabled=false;setText('lab-audio-status','Recording microphone… speak the call audio, then press Stop recording.');
  }catch(error){labStream?.getTracks().forEach(track=>track.stop());labStream=null;setText('lab-audio-status',`Microphone unavailable: ${error.message}`);}
});
$('lab-stop').addEventListener('click',()=>{if(labRecorder?.state==='recording')labRecorder.stop();});
$('lab-transcribe').addEventListener('click',async()=>{
  if(!labAudioBlob)return;const blob=labAudioBlob;$('lab-transcribe').disabled=true;
  setText('lab-audio-status','Running local speech recognition on the actual audio bytes…');
  try{
    const result=await transcribe(blob);if(blob!==labAudioBlob)return;
    const session=await buildRecordedAnalysis(result,{source:'user-audio',sourceTitle:'Uploaded call audio',mode:'uploaded-waveform-asr'});if(blob!==labAudioBlob)return;
    loadRecordedTranscript(session,{source:'user_audio',label:null,evaluation_split:'live session',transcriptSource:'local-asr',model:result.model});
    renderRecordedMonitor(session,'Uploaded call audio','UPLOADED AUDIO + LOCAL ASR');
    setText('lab-audio-status',`${detectionSummary(session)}. ${result.backend} recognized ${session.entries.length} segment${session.entries.length===1?'':'s'} from ${result.duration.toFixed(1)} seconds of audio in ${(result.inference_ms/1000).toFixed(1)} seconds. Results are visible here and in Call desk.`);
    $('assessment').scrollIntoView({behavior:'smooth',block:'center'});
  }catch(error){if(blob===labAudioBlob)setText('lab-audio-status',`Audio analysis failed: ${error.message}`);}finally{updateLabAudioControls();}
});
$('lab-replay').addEventListener('click',async()=>{if(!labAudioBlob)return;const blob=labAudioBlob;$('lab-replay').disabled=true;renderReplay('lab-model-result',{status:'Analyzing human/replay evidence…',score:null,reason:'Running the local replay classifier on the selected waveform.'});try{renderReplay('lab-model-result',await apiModel('replay',blob));}catch(error){renderReplay('lab-model-result',null,error.message);}finally{updateLabAudioControls();}});
$('lab-deepfake').addEventListener('click',async()=>{if(!labAudioBlob)return;const blob=labAudioBlob;$('lab-deepfake').disabled=true;renderModelEvidence('lab-model-result',{status:'Running Pella and AASIST…',warning:'Supplementary anti-spoof evidence.'});try{renderModelEvidence('lab-model-result',await apiModel('deepfake',blob));}catch(error){renderModelEvidence('lab-model-result',null,error.message);}finally{updateLabAudioControls();}});
// The caller clip is the reference acoustic path for challenge-reply continuity.
$('call-audio').addEventListener('change',()=>{
  const input=$('call-audio');let file=input.files[0],selectionError='';const token=++profileRevision;callerProfile=null;callerReplay=null;$('call-replay').hidden=true;refreshLiveness();
  try{if(file)assertMediaInput(file,'Selected media');}catch(error){selectionError=error.message;input.value='';file=null;}
  $('deepfake-call').disabled=!deepfakeAvailable||!file;$('compare-speaker').disabled=!speakerAvailable||!file||!recordingBlob;
  setText('asr-status',selectionError||(file?`${file.name} selected but not analyzed yet — press Transcribe & analyze.`:'Select audio or an audio-bearing MP4/M4A to analyze.'));
  if(file)profileAudio(file).then(p=>{if(token===profileRevision){callerProfile=p;refreshLiveness();}}).catch(error=>{if(token===profileRevision)setText('asr-status',`Optional channel profile unavailable: ${error.message} Transcription can still run.`);});
});
$('transcribe-call').addEventListener('click',async()=>{
  const file=$('call-audio').files[0];if(!file){setText('asr-status','Select an audio file first.');return;}
  const revision=sessionRevision;$('transcribe-call').disabled=true;setText('asr-status','Transcribing on this computer…');
  try{const data=await transcribe(file);if(revision!==sessionRevision)return;
    const session=await buildRecordedAnalysis(data,{source:'user-audio',sourceTitle:file.name,mode:'uploaded-waveform-asr'});if(revision!==sessionRevision)return;
    loadRecordedTranscript(session,{source:'user_audio',label:null,evaluation_split:'live session',transcriptSource:'local-asr',model:data.model});
    renderRecordedMonitor(session,file.name,'UPLOADED AUDIO + LOCAL ASR');
    setText('input-status',`${detectionSummary(session)}. Analysis ran automatically from the machine transcript; review ASR errors below.`);
    setText('asr-status',`${data.backend} analyzed ${data.duration.toFixed(1)} seconds of audio. Transcript and fraud assessment are ready.`);openView('review');
  }catch(e){setText('asr-status',e.message);}finally{$('transcribe-call').disabled=!asrAvailable;}
});
$('transcribe-reply').addEventListener('click',async()=>{
  if(!recordingBlob||!isActive())return;const id=challenge.id;const blob=recordingBlob;$('transcribe-reply').disabled=true;setText('record-status','Transcribing reply locally…');
  try{const data=await transcribe(blob);if(challenge?.id!==id||recordingBlob!==blob||!isActive())return;
    $('response').value=data.text;responseSource=`local ${data.backend||'ASR'} / ${data.model}`;responseASR=data;
    setText('record-status',data.text?'Transcript ready — review before checking.':'No usable speech found. Try again.');
  }catch(e){if(challenge?.id===id&&recordingBlob===blob)setText('record-status',e.message);}finally{$('transcribe-reply').disabled=!recordingBlob||!isActive()||!asrAvailable;}
});
$('response').addEventListener('input',()=>{responseSource=responseASR?'manually edited ASR transcript':'manual';});
async function refreshStatus(){
  $('refresh-status').disabled=true;
  try{
    const response=await fetch('/api/status');
    if(!response.ok)throw new Error(`Service check failed (HTTP ${response.status}).`);
    capabilities=await response.json();
    setText('model-health',`Text rules ready · Classifier ${capabilities.intent?`available (${(capabilities.intentLanguages??['en']).join(', ')})`:'unavailable'} · Local ASR ${capabilities.asr?(capabilities.asrBackend==='openai-whisper'?'available (batch CPU)':'available'):'unavailable'} · Pella/AASIST ${capabilities.deepfake?'available':'unavailable'} · ECAPA ${capabilities.speaker?'available':'unavailable'}`);
    $('model-health').title=Object.values(capabilities.reasons??{}).join('\n');
  }catch(error){
    capabilities=null;setText('model-health',`${error.message} Capabilities unknown; browser text rules still work.`);
  }finally{
    asrAvailable=capabilities?.asr===true;replayAvailable=capabilities?.replay===true;deepfakeAvailable=capabilities?.deepfake===true;speakerAvailable=capabilities?.speaker===true;
    $('inspect-call').disabled=!replayAvailable;$('transcribe-call').disabled=!asrAvailable;
    $('transcribe-reply').disabled=!asrAvailable||!recordingBlob||!isActive();$('inspect-reply').disabled=!replayAvailable||!recordingBlob;
    $('deepfake-call').disabled=!deepfakeAvailable||!$('call-audio').files[0];$('deepfake-reply').disabled=!deepfakeAvailable||!recordingBlob;$('compare-speaker').disabled=!speakerAvailable||!recordingBlob||!$('call-audio').files[0];
    setText('asr-status',asrAvailable?'Local speech service available.':capabilities?.reasons?.asr||'Local speech service unavailable. Text entry still works.');
    liveCall?.setCapabilities(capabilities);
    datasetLab?.setStatus(capabilities);
    $('demo-asr').disabled=!asrAvailable||!!recordedController;
    setText('demo-asr-status',asrAvailable?'Actual waveform recognition is separate from the supplied-script demo.':capabilities?.reasons?.asr||'Local speech recognition is unavailable; the supplied-script demo still works.');
    updateLabAudioControls();
    databaseControls();
    if(!databaseCatalogue)void initDatabaseAudio();
    $('refresh-status').disabled=false;
  }
  return capabilities;
}
$('refresh-status').onclick=()=>{readiness=refreshStatus();};
$('inspect-call').addEventListener('click',async()=>{
  const file=$('call-audio').files[0];if(!file){setText('asr-status','Select an audio file first.');return;}const revision=sessionRevision;$('inspect-call').disabled=true;
  renderReplay('call-replay',{status:'Analyzing waveform…',score:null,reason:'Running the trained replay classifier locally.'});
  try{const result=await apiModel('replay',file);if(revision===sessionRevision){callerReplay=result;renderReplay('call-replay',result);}}catch(e){renderReplay('call-replay',null,e.message);}finally{$('inspect-call').disabled=!replayAvailable;}
});
$('inspect-reply').addEventListener('click',async()=>{
  if(!recordingBlob||!challenge)return;const id=challenge.id;const blob=recordingBlob;$('inspect-reply').disabled=true;
  renderReplay('reply-replay',{status:'Analyzing waveform…',score:null,reason:'Running the trained replay classifier locally.'});
  try{const result=await apiModel('replay',blob);if(challenge?.id===id&&recordingBlob===blob){replyReplay=result;renderReplay('reply-replay',result);refreshLiveness();}}catch(e){if(challenge?.id===id)renderReplay('reply-replay',null,e.message);}finally{$('inspect-reply').disabled=!recordingBlob||!replayAvailable;}
});
$('deepfake-call').addEventListener('click',async()=>{const file=$('call-audio').files[0];if(!file)return;const button=$('deepfake-call');button.disabled=true;renderModelEvidence('call-deepfake',{status:'Running both anti-spoof detectors…',warning:'CPU inference may take time.'});try{callerDeepfake=await apiModel('deepfake',file);renderModelEvidence('call-deepfake',callerDeepfake);}catch(error){renderModelEvidence('call-deepfake',null,error.message);}finally{button.disabled=!deepfakeAvailable;}});
$('deepfake-reply').addEventListener('click',async()=>{if(!recordingBlob)return;const button=$('deepfake-reply');button.disabled=true;renderModelEvidence('reply-deepfake',{status:'Running both anti-spoof detectors…',warning:'CPU inference may take time.'});try{replyDeepfake=await apiModel('deepfake',recordingBlob);renderModelEvidence('reply-deepfake',replyDeepfake);}catch(error){renderModelEvidence('reply-deepfake',null,error.message);}finally{button.disabled=!deepfakeAvailable||!recordingBlob;}});
$('compare-speaker').addEventListener('click',async()=>{const reference=$('call-audio').files[0];if(!reference||!recordingBlob)return;const button=$('compare-speaker');button.disabled=true;renderModelEvidence('speaker-result',{status:'Comparing speaker embeddings…',warning:'This does not verify identity.'});try{speakerComparison=await compareSpeaker(reference,recordingBlob);renderModelEvidence('speaker-result',speakerComparison);}catch(error){renderModelEvidence('speaker-result',null,error.message);}finally{button.disabled=!speakerAvailable||!recordingBlob||!$('call-audio').files[0];}});
function selectedDatabaseSample(){return databaseCatalogue?.samples?.find(sample=>sample.id===$('database-select').value);}
function databaseControls(){const sample=selectedDatabaseSample();$('database-play').disabled=!sample||databaseBusy;$('database-analyze').disabled=!sample||databaseBusy||!asrAvailable;$('database-deepfake').disabled=!sample||databaseBusy||!deepfakeAvailable;}
function renderDatabaseSample(){
  const sample=selectedDatabaseSample();if(!sample)return;
  $('database-player').src=`/database-audio/${encodeURIComponent(sample.file)}`;
  $('database-model-result').hidden=true;
  if(sourceMode==='database'&&recordedSession?.source!==sample.id){
    recordedSession=null;renderCall(null);setText('session-mode','REAL AUDIO DATABASE');setText('pipeline-input',sample.title);setText('pipeline-text','Not analyzed');setText('pipeline-analysis','Waiting');
  }
  $('database-disclosure').replaceChildren(node('b',sample.title),document.createTextNode(`${sample.source} · ${sample.provenance}. Voice-origin reference: ${sample.voiceOrigin}. Language: ${sample.language}. Reference metadata is not supplied to inference.`));
  setText('database-status',`Source context only: ${sample.fraudContext} · ${sample.license} · ${(sample.bytes/1048576).toFixed(2)} MB. No fresh call-content level has been calculated yet.`);databaseControls();
}
async function initDatabaseAudio(){
  try{
    const response=await fetch('/api/database-audio');databaseCatalogue=await response.json();if(!response.ok)throw new Error(databaseCatalogue.error||'Catalogue unavailable');
    $('choose-database').disabled=false;$('choose-database').title='Use bundled real-world and synthetic reference audio';
    $('database-select').replaceChildren(...databaseCatalogue.samples.map(sample=>{const option=node('option',`${sample.title} · ${sample.voiceOrigin.includes('Synthetic')?'SYNTHETIC':'REAL-WORLD'}`);option.value=sample.id;return option;}));
    $('database-source-status').replaceChildren(...databaseCatalogue.sourceStatus.map(source=>node('p',`${source.name}: ${source.status}${source.count?` · ${source.count} bundled`:''}. ${source.reason||source.kind}`,'fine')));
    renderDatabaseSample();
  }catch(error){databaseCatalogue=null;$('choose-database').disabled=true;$('choose-database').title=`Database samples unavailable: ${error.message}. Press Recheck to retry.`;setText('database-status',`Database samples unavailable: ${error.message}. Press Recheck to retry.`);databaseControls();}
}
$('database-select').onchange=renderDatabaseSample;
$('database-play').onclick=()=>$('database-player').play();
$('database-analyze').onclick=async()=>{
  const sample=selectedDatabaseSample();if(!sample||databaseBusy)return;databaseBusy=true;databaseControls();setText('database-status','Running local ASR on the bundled waveform, then evaluating the recognized words…');
  try{
    const response=await fetch(`/database-audio/${encodeURIComponent(sample.file)}`);if(!response.ok)throw new Error(`Audio unavailable (HTTP ${response.status})`);const blob=await response.blob();
    const result=await transcribe(blob);if(sample!==selectedDatabaseSample())return;
    const session=await buildRecordedAnalysis(result,{source:sample.id,sourceTitle:sample.title,mode:'bundled-database-waveform-asr',reference:referenceEvidence(sample,'database-audio')});if(sample!==selectedDatabaseSample())return;
    renderRecordedMonitor(session,sample.source,'DATABASE AUDIO + LOCAL ASR');
    const score=session.intentModel?.usable?` Classifier scam-likeness score ${session.intentModel.score.toFixed(3)}.`:'';
    setText('database-status',`Fresh call-content result: ${detectionSummary(session)}. ${sample.title}: recognized ${result.duration.toFixed(1)} s of actual audio in ${(result.inference_ms/1000).toFixed(1)} s.${score} Source and voice-origin labels were not used for inference.`);
  }catch(error){setText('database-status',`Database audio analysis failed: ${error.message}`);}finally{databaseBusy=false;databaseControls();}
};
$('database-deepfake').onclick=async()=>{const sample=selectedDatabaseSample();if(!sample||databaseBusy)return;databaseBusy=true;databaseControls();renderModelEvidence('database-model-result',{status:'Running Pella and AASIST…',warning:'Supplementary anti-spoof evidence.'});try{const response=await fetch(`/database-audio/${encodeURIComponent(sample.file)}`);if(!response.ok)throw new Error('Audio unavailable');const result=await apiModel('deepfake',await response.blob());if(sample.voiceOrigin?.startsWith('Synthetic/deepfake')){const caught=hasSyntheticVoiceEvidence(result);result.warning=caught?'Publisher label: synthetic. At least one detector identified this clip; this is one sample, not an accuracy estimate.':'KNOWN MODEL MISS — the publisher labels this clip synthetic, but neither detector identified it. The ground-truth label is retained so failure is visible.';}renderModelEvidence('database-model-result',result);}catch(error){renderModelEvidence('database-model-result',null,error.message);}finally{databaseBusy=false;databaseControls();}};
configureMediaInput($('lab-audio'));configureMediaInput($('call-audio'));
initWorkspace();
initCaseLibrary();
initDatabaseAudio();
demoPlayback=initDemos({onPlay:()=>{if(!recordedSession)useSuppliedScript();},onSelect:useSuppliedScript});
attackLab=initAttackLab();
liveCall=initLiveCall((value,context,snapshot)=>{if(sourceMode==='live')renderCall(snapshot);});
readiness=refreshStatus();
initDatasetLab({status:readiness,loadText:record=>{
  sessionRevision++;profileRevision++;resetChallenge();callerReplay=null;callerProfile=null;selectedCase=null;$('call-audio').value='';$('call-replay').hidden=true;selectedDataset={id:record.id,label:record.label,source:record.source,evaluation_split:record.evaluation_split};
  turns=record.turns.map(t=>({...t}));$('utterance').value='';setText('input-status',`Public record ${record.id}. Reference label is not passed to inference.`);openView('review');renderTurns();renderAnalysis();
},useReply:(blob,record)=>{
  if(!isActive()){renderReplay('dataset-audio-result',null,'Issue a fresh challenge in section 03 first, then choose this prerecorded response.');return;}
  clearAudio();recordingBlob=blob;recordingUrl=URL.createObjectURL(blob);$('playback').src=recordingUrl;$('playback').hidden=false;
  profileAudio(blob).then(p=>{if(recordingBlob===blob){replyProfile=p;refreshLiveness();}}).catch(error=>{if(recordingBlob===blob)setText('record-status',`Audio profile unavailable: ${error.message}`);});
  $('transcribe-reply').disabled=!asrAvailable;$('inspect-reply').disabled=!replayAvailable;responseSource='pending ASR of public dataset audio';
  setText('record-status',`Public recording ${record.id} loaded (${record.label?'replay':'genuine'}). Transcribe, then check.`);openView('verify');
}}).then(lab=>{datasetLab=lab;}).catch(error=>{setText('text-sample-status',`Evidence library unavailable: ${error.message}`);});
async function chooseSource(mode){
  cancelRecorded();
  sourceMode=mode;
  if(mode!=='live'){await liveCall.reset();if(sourceMode!==mode)return;}
  demoPlayback.setEnabled(mode==='demo');
  $('demo-source').hidden=mode!=='demo';$('database-source').hidden=mode!=='database';$('live-source').hidden=mode!=='live';
  for(const value of ['demo','database','live']){
    const button=$(`choose-${value}`);button.classList.toggle('selected',value===mode);button.setAttribute('aria-pressed',String(value===mode));
  }
  setText('session-mode',mode==='demo'?'GUIDED DEMO':mode==='database'?'REAL AUDIO DATABASE':'LIVE ASR');
  setText('pipeline-text',mode==='demo'?'Supplied script':'Local recognizer');
  if(mode==='live'){renderCall(liveCall.snapshot());setText('pipeline-input','Capture off');setText('pipeline-analysis','Waiting');}
  if(mode==='database'){renderCall(recordedSession?.mode==='bundled-database-waveform-asr'?recordedSession:null);setText('pipeline-input','Bundled recording');setText('pipeline-analysis',recordedSession?.mode==='bundled-database-waveform-asr'?'Result available':'Waiting');}
}
$('choose-demo').onclick=()=>chooseSource('demo');$('choose-database').onclick=()=>chooseSource('database');$('choose-live').onclick=()=>chooseSource('live');
function recordedControls(busy){
  for(const id of ['demo-select','demo-start','demo-restart','choose-live','choose-demo'])$(id).disabled=busy;
  $('demo-player').controls=!busy;
  $('demo-asr').disabled=busy||!asrAvailable;
}
function cancelRecorded(){
  recordedRevision++;recordedController?.abort();recordedController=null;recordedSession=null;
  $('review-asr').hidden=true;recordedControls(false);
  if(sourceMode==='demo')useSuppliedScript();
}
function useSuppliedScript(){
  if(recordedController)return;
  recordedSession=null;$('review-asr').hidden=true;
  $('demo-disclosure').replaceChildren(node('b','Authored transcript mode'),document.createTextNode('Stock TTS audio with its supplied script. Approximate phrase cues follow the player. Rules are evaluated as phrases arrive; this is not speech recognition.'));
  $('demo-status').hidden=false;
  setText('demo-asr-status','Actual waveform recognition is separate from the supplied-script demo.');
  if(sourceMode==='demo'){
    setText('session-mode','GUIDED DEMO');
    demoPlayback?.setEnabled(true);
  }
}
$('demo-asr').onclick=async()=>{
  if(!asrAvailable){setText('demo-asr-status','Local ASR is unavailable. No recognition was attempted.');return;}
  const token=++recordedRevision;recordedSession=null;
  demoPlayback.setEnabled(false);
  const filename=$('demo-select').value;
  const controller=new AbortController();recordedController=controller;
  recordedControls(true);$('review-asr').hidden=true;renderCall(null);
  $('demo-disclosure').replaceChildren(node('b','Actual waveform recognition'),document.createTextNode('Only audio bytes go to the local Whisper model. No authored script is submitted. Results and ASR-derived timestamps appear after recognition finishes.'));
  $('demo-status').hidden=true;
  setText('session-mode','ACTUAL LOCAL ASR');
  setText('pipeline-input','WAV file');setText('pipeline-text','Recognizing waveform');setText('pipeline-analysis','Waiting for ASR');
  setText('demo-asr-status',`Running ${capabilities.model} on audio only. No script is submitted. CPU recognition may take several minutes; this is a batch check, not real-time analysis.`);
  try{
    const response=await fetch(`/demo-audio/${filename}.wav`,{signal:controller.signal});
    if(!response.ok)throw new Error(`Audio unavailable (HTTP ${response.status}).`);
    const blob=await response.blob();
    const hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
    const result=await transcribe(blob,controller.signal);
    if(token!==recordedRevision)return;
    recordedSession=await buildRecordedAnalysis(result,{source:filename,mode:'recorded-waveform-asr',
      timing:'ASR-derived segment timestamps; batch result, not streaming timestamps',
      input_sha256:Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('')});
    renderCall(recordedSession);
    setText('pipeline-text',`${recordedSession.entries.length} recognized segments`);setText('pipeline-analysis',detectionSummary(recordedSession));
    const elapsed=(result.inference_ms/1000).toFixed(1);
    setText('demo-asr-status',`Actual ${result.backend} result: ${result.duration.toFixed(1)} s audio processed in ${elapsed} s.${result.inference_ms>result.duration*1000?' Slower than playback; not real-time.':''} Review the recognized words. This measures transcription, not fraud-detection accuracy.`);
    $('review-asr').hidden=!recordedSession.entries.length;
  }catch(error){
    if(token===recordedRevision){setText('demo-asr-status',`Recognition failed: ${error.message.replace(/\.$/,'')}. No supplied transcript was substituted.`);setText('pipeline-text','Recognition failed');setText('pipeline-analysis','No result');}
  }finally{
    if(recordedController===controller){recordedController=null;recordedControls(false);}
  }
};
$('review-asr').onclick=()=>{
  if(!recordedSession)return;
  sessionRevision++;profileRevision++;selectedDataset=null;selectedCase=null;callerProfile=null;callerReplay=null;
  resetChallenge();$('call-audio').value='';$('call-replay').hidden=true;
  turns=buildAsrTurns(recordedSession.entries);
  setText('input-status',`Recognized from ${recordedSession.source}.wav using ${recordedSession.backend}; review transcription errors.`);
  openView('review');renderTurns();renderAnalysis();
};
window.addEventListener('workspacechange',event=>{if(event.detail!=='desk')demoPlayback.pause();if(event.detail!=='attack')attackLab.stop();});
window.addEventListener('beforeunload',releaseMedia);renderAnalysis();
