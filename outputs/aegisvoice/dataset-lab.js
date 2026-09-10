import { assertMediaInput } from './media-input.mjs';
import { analyze } from './engine.mjs';
import { directDecision } from './decision.mjs';

const $=id=>document.getElementById(id);
const element=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const pct=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'not reported';
const count=value=>Number.isFinite(value)?value.toLocaleString():'not reported';
const decimal=value=>Number.isFinite(value)?value.toFixed(3):'not reported';
export function savedTextDecision(record,report){
  if(!Array.isArray(record?.turns)||!Number.isFinite(record?.model_score)||!Number.isFinite(report?.low_risk_threshold)||!Number.isFinite(report?.high_risk_threshold))return null;
  const risk_band=record.model_score>=report.high_risk_threshold?'high-risk':record.model_score<=report.low_risk_threshold?'low-risk':'elevated-risk';
  return directDecision(analyze(record.turns),{usable:true,score:record.model_score,risk_band});
}
const sourceLinks=[
  ['BothBosu single-agent','https://huggingface.co/datasets/BothBosu/single-agent-scam-conversations'],
  ['BothBosu multi-agent','https://huggingface.co/datasets/BothBosu/multi-agent-scam-conversation'],
  ['Edinburgh ASVspoof 2017 V2','https://doi.org/10.7488/ds/2332'],
  ['NCSU Robocall Observatory','https://robocall.science/'],
  ['TeleAntiFraud-28k','https://github.com/JimmyMa99/TeleAntiFraud'],
  ['Fraud Call India','https://www.kaggle.com/datasets/narayanyadav/fraud-call-india-dataset/data'],
  ['Mendeley Fake Audio','https://data.mendeley.com/datasets/79g59sp69z/1']
];
function appendSourceLinks(host){
  for(const [index,[label,url]] of sourceLinks.entries()){
    if(index)host.append(element('span',' · '));
    const link=element('a',label);link.href=url;link.target='_blank';link.rel='noreferrer';host.append(link);
  }
}
  function sourceRevision(reports,prefix){
    return reports.sources?.files?.find(file=>file.name?.startsWith(`${prefix}/`))?.revision||'not reported';
  }
  function renderExternalDatasets(reports){
    const host=$('external-datasets');if(!host)return;
    const text=reports.intent,audio=reports.replay,mendeley=reports.mendeleyDeepfake;
    const card=({title,url,kind,origin,created,counts,use,license,revision,limit})=>{
      const box=element('article',undefined,'external-card');
      const heading=element('h4');const link=element('a',title);link.href=url;link.target='_blank';link.rel='noreferrer';heading.append(link);
      box.append(heading,element('span',kind,'external-kind'));
      const details=element('dl');
      for(const [term,value] of [['Source',origin],['Created with',created],['Records',counts],['Used here',use],['Licence',license],['Pinned revision',revision]]){
        const group=element('div');group.append(element('dt',term),element('dd',value));details.append(group);
      }
      box.append(details,element('p',limit,'external-limit'));return box;
    };
    const bothBosuTrain=text?.training_sources?.bothbosu??text?.train_count;
    const singleTotal=Number.isFinite(bothBosuTrain)&&Number.isFinite(text?.development_count)&&Number.isFinite(text?.published_test?.n)
      ?bothBosuTrain+text.development_count+text.published_test.n:null;
    host.replaceChildren(
      card({
        title:'BothBosu / single-agent scam conversations',url:sourceLinks[0][1],
        kind:'Synthetic English conversation dataset',origin:'Hugging Face · BothBosu',
        created:'meta-llama-3-70b-instruct',
        counts:singleTotal?`${count(singleTotal)} total · ${count(bothBosuTrain)} fit · ${count(text.development_count)} threshold development · ${count(text.published_test.n)} published test`:'Saved counts not reported',
        use:'TF-IDF/logistic-regression training, threshold selection and text-record browser',
        license:'Apache 2.0',revision:sourceRevision(reports,'scam_single'),
        limit:'Not recordings of real callers. Scenario family aligns with label, enabling topic shortcuts.'
      }),
      card({
        title:'BothBosu / multi-agent scam conversations',url:sourceLinks[1][1],
        kind:'Synthetic English agent-dialogue dataset',origin:'Hugging Face · BothBosu',
        created:'AutoGen agents with Together Inference API',
        counts:Number.isFinite(text?.transfer_test?.n)?`${count(text.transfer_test.n)} saved transfer records`:'Saved counts not reported',
        use:'Saved transfer-corpus evaluation and conversation browser; not classifier fitting',
        license:'Apache 2.0',revision:sourceRevision(reports,'scam_multi'),
        limit:'Synthetic agents and the same scenario families as the first source; not independent real-call validation.'
      }),
      card({
        title:'ASVspoof 2017 Database Version 2',url:sourceLinks[2][1],
        kind:'Recorded genuine / replay speech benchmark',origin:'University of Edinburgh CSTR',
        created:'ASVspoof challenge recordings and official protocols',
        counts:Number.isFinite(audio?.train_count)?`${count(audio.train_count)} train · ${count(audio.development_count)} development · ${count(audio.evaluation_count||audio.held_out_test?.n)} evaluation`:'Saved counts not reported',
        use:'LFCC/SVM replay-classifier training, calibration and saved evaluation metadata',
        license:'CC BY-NC 4.0',revision:sourceRevision(reports,'asvspoof2017'),
        limit:'Replay benchmark—not scam calls, caller identity, live voice conversion, or modern TTS/voice-clone validation.'
      }),
      card({title:'NCSU / FTC robocall material',url:sourceLinks[3][1],kind:'Real-world robocall campaign audio and transcripts',origin:'NCSU Robocall Observatory / FTC Project Point of No Entry',created:'Deployed calls observed through telephone infrastructure',counts:text?.ncsu_source_inventory?`${count(text.ncsu_source_inventory.rows)} catalogue rows · ${count(text.training_sources?.ncsu_ftc_weak_positive)} deduplicated training · ${count(text.ncsu_campaign_holdout?.n)} held out by FTC case`:'1,432 catalogue transcripts; saved training split not reported',use:'Weak-positive transcript training plus campaign-disjoint sensitivity evaluation; audio is used only by ASR',license:'Data public domain; documentation CC BY-ND 4.0',revision:'Catalogue bundled in this build',limit:'Mostly automated or prerecorded and no benign controls or per-call adjudication. It cannot measure specificity or validate interactive human vishing.'}),
      card({title:'TeleAntiFraud-28k',url:sourceLinks[4][1],kind:'Privacy-protected audio-text fraud dataset',origin:'TeleAntiFraud research project',created:'ASR-derived, TTS-regenerated and synthetic/adversarial construction',counts:'28,511 reported speech-text pairs; not downloaded in this build',use:'Potential auxiliary fraud-language evaluation after licence/provenance review',license:'Verify dataset release terms',revision:'Not pinned in this build',limit:'Original sensitive audio is anonymized and regenerated; it is not a corpus of raw interactive human-victim scam calls.'})
      ,card({title:'Fraud Call Detection Dataset · India',url:sourceLinks[5][1],kind:'Downloaded fraud/normal utterance text dataset',origin:'Kaggle · Narayan Yadav',created:'Publisher-provided call utterances; collection method not documented',counts:'5,927 records · 638 fraud · 5,289 normal · 0 audio files',use:'Browsable auxiliary India-oriented fraud-language evidence; excluded from human-audio coverage',license:'CC0: Public Domain',revision:'Downloaded archive SHA-256 d659fa6e…acf41',limit:'Text-only, single utterances with no speaker, channel, annotator or split metadata. It cannot establish interactive human-call or acoustic performance.'}),
      card({title:'Mendeley Fake Audio Dataset',url:sourceLinks[6][1],kind:'Publisher-labelled synthetic TTS / voice-conversion audio',origin:'Mendeley Data · ElevenLabs and Respeecher corpus',created:'ElevenLabs and Respeecher; synthetic-only',counts:mendeley?`${count(mendeley.evaluatedCount)} evaluated · Pella sensitivity ${pct(mendeley.overall?.pellaSyntheticDetectionRate)} · AASIST sensitivity ${pct(mendeley.overall?.aasistSpoofDetectionRate)} · either ${pct(mendeley.overall?.eitherDetectorRate)} · disagreement ${pct(mendeley.overall?.detectorDisagreementRate)}`:'600 installed WAVs · evaluation still running or report unavailable',use:'External Pella/AASIST sensitivity challenge; eight stratified clips in Call Desk',license:'CC BY 4.0',revision:'DOI 10.17632/79g59sp69z.1',limit:'No genuine class and no fraud labels, so this cannot estimate specificity, balanced accuracy, caller identity, or scam detection.'})
    );
  }
export function speakerOverlapClaim(overlap){
  const pairs=['train_dev','train_eval','dev_eval'];
  if(!overlap||!pairs.every(key=>Array.isArray(overlap[key])))return 'Speaker overlap was not fully reported; current separation is unverified.';
  return pairs.every(key=>overlap[key].length===0)
    ?'The saved report claims zero shared speakers across all three split pairs; this session has not verified those speaker sets.'
    :'The saved report records speaker overlap; this session has not rechecked those speaker sets.';
}
function renderAudit(reports){
  const host=$('audit-grid');if(!host)return;
  const cards=[];
  const card=(title,value,note,diagnostics=[])=>{
    const box=element('div',undefined,'audit-card');
    box.append(element('h4',title),element('b',value));
    if(note)box.append(element('small',note));
    const details=element('details');details.append(element('summary','Saved diagnostics · not rerun'));
    for(const line of diagnostics)details.append(element('p',line));
    box.append(details);
    cards.push(box);
  };
  const t=reports.intent,a=reports.replay,rb=reports.rules,ch=reports.channel,attack=reports.attack;
  const rules=rb?.operating_points?.['any concern'];
  card('Rules · reused-corpus diagnostic',rb?`${pct(rules?.accuracy)} saved accuracy`:'No saved rule report',
    'The entire corpus and examples were inspected before and during tuning. This is not an independent generalization estimate.',
    rb?[
      `${count(rb.records)} reused records. Precision ${decimal(rules?.precision)}; recall ${decimal(rules?.recall)}; F1 ${decimal(rules?.f1)}. Saved ${rb.generated_at||'date not reported'}.`,
      `${count(rb.errors?.missed_scam_calls)} missed scam calls; ${count(rb.errors?.false_alarms)} false alarms. False-positive rate ${pct(rules?.false_positive_rate)} uses all non-scam records as its denominator.`,
      'The legacy development/held_out keys are alternating diagnostic partitions of the same reused corpus, not blind evaluation splits.',
      rb.topic_shortcut_audit?.every_family_is_single_label?'Saved topic audit: every scenario family has a single label, so topic alone predicts the answer.':'Topic shortcuts may inflate agreement with corpus labels.'
    ]:[]);
  card('Scam classifier · saved report',t?`F1 ${decimal(t.published_test?.f1)}`:'No saved text report',
    'Synthetic English plus weak-labelled real-world robocall transcripts. Stored metrics, not a real-world fraud probability.',
    t?[
      `Report claims ${count(t.train_count)} training records (${count(t.training_sources?.bothbosu)} BothBosu; ${count(t.training_sources?.ncsu_ftc_weak_positive)} NCSU/FTC weak positives) and ${count(t.development_count)} synthetic development records; published-test subset ${count(t.published_test?.n)}, accuracy ${pct(t.published_test?.accuracy)}.`,
      t.ncsu_campaign_holdout?`NCSU/FTC case-group holdout: ${count(t.ncsu_campaign_holdout.n)} positive-only calls across ${count(t.ncsu_campaign_holdout.campaign_groups)} cases; sensitivity ${pct(t.ncsu_campaign_holdout.sensitivity)}. No specificity can be computed.`:'NCSU campaign holdout not reported.',
      `Reported transfer subset ${count(t.transfer_test?.n)}, F1 ${decimal(t.transfer_test?.f1)}; exact duplicates removed ${count(t.exact_duplicates_removed)}. Split and deduplication claims have not been reverified here.`,
      `Reported near-training neighbors: ${count(t.near_duplicate_diagnostic?.near_training_neighbors)}. Topic shortcuts can inflate these results.`
    ]:[]);
  card('Replay classifier · saved report',a?`AUROC ${decimal(a.held_out_test?.auroc)}`:'No saved replay report',
    'Recorded replay benchmark only; it does not verify identity, live speech, or modern synthetic-voice detection.',
    a?[
      `Reported evaluation recordings ${count(a.held_out_test?.n)}; balanced accuracy ${pct(a.held_out_test?.balanced_accuracy)}; EER ${pct(a.held_out_test?.eer_approx)}.`,
      `Uncertain: ${pct(Number.isFinite(a.selective_test?.coverage)?1-a.selective_test.coverage:NaN)} of all evaluation recordings. Replay accepted as genuine-like: ${pct(a.selective_test?.attack_acceptance_rate)} of all replay recordings; genuine rejected: ${pct(a.selective_test?.genuine_rejection_rate)} of all genuine recordings. These class denominators include uncertain recordings, not just confident calls.`,
      speakerOverlapClaim(a.speaker_overlap)
    ]:[]);
  card('DSP path model · saved calibration',attack?`${count(attack.conditions?.length)} simulated paths`:ch?`${count(ch.results?.length)} stored conditions`:'No saved DSP report',
    'Controlled signal transformations only; support scores are not class probabilities or attack validation.',
    attack?[
      attack.method,
      attack.support_semantics,
      `Stored conditions: ${attack.conditions?.map(result=>result.label).join(' · ')||'not reported'}.`,
      ...(attack.conditions||[]).map(result=>`${result.label}: ${result.decisions?.uncertain??'not reported'} of ${result.trials??'unknown'} trials remained uncertain.`),
      'The voice-conversion proxy is deliberately uncertain; a real vocoder, room and device evaluation is still required.'
    ]:ch?[
      `Reported trials per condition: ${count(ch.trials_per_condition)}; worst same-path distance: ${decimal(ch.separation?.worst_same_path_distance)}.`,
      `Saved report claims same/changed-path overlap: ${ch.separation?.same_and_changed_overlap===true?'present':ch.separation?.same_and_changed_overlap===false?'absent':'not reported'}. Threshold behavior on a live device is unverified.`
    ]:[]);
  host.replaceChildren(...cards);
}
function renderRealHumanAnalysis(status,coverage){
  const host=$('real-human-analysis');if(!host)return;
  const counts=coverage?.verifiedInteractiveHuman||{};
  const card=(title,badge,body,analysis,cls='')=>{
    const box=element('article',undefined,`human-analysis-card ${cls}`.trim());
    box.append(element('span',badge,'human-analysis-badge'),element('h4',title),element('p',body),element('b','Our analysis'),element('p',analysis,'fine'));
    return box;
  };
  host.replaceChildren(
    card('ASVspoof 2017 human speech',status.datasetAudio?'LOCAL AUDIO READY':'METADATA / AUDIO NOT READY','Genuine human speech and replayed versions of benchmark phrases feed the LFCC/SVM replay detector.','Useful for replay-channel behavior. It does not contain scam conversations and cannot decide whether a request is fraudulent.',status.datasetAudio?'available':'limited'),
    card('Mendeley ElevenLabs + Respeecher','600 SYNTHETIC WAVS INSTALLED','Publisher-labelled TTS and voice-to-voice samples provide a modern external challenge set for Pella and AASIST. Eight generator/type/gender-stratified recordings are available in Call Desk.','This corpus contains no genuine class and no fraud labels. It can measure synthetic-sample detection sensitivity, but cannot establish specificity, caller identity, or scam intent.','available'),
    card('Fraud Call India', '5,927 TEXT RECORDS','The downloaded CC0 release contributes 638 fraud-labelled and 5,289 normal-labelled utterances; 5,602 unique texts are split into training, calibration and untouched holdout groups.','Used as publisher-labelled intent training evidence alongside BothBosu and NCSU transcripts. It contains zero audio files and is not independently adjudicated human-call evidence.','limited'),
    card('Interactive human-vishing audio',coverage?.evaluationReady?'EVALUATION READY':`${counts.scam||0} SCAM / ${counts.genuine||0} GENUINE`,'The deployment track requires byte-verified, multi-turn human scam and matched genuine calls with governance and isolated test groups.','No qualifying corpus is currently present, so AegisVoice withholds a real-human-vishing performance claim instead of converting proxy evidence into a result.',coverage?.evaluationReady?'available':'missing'),
    card('Live or uploaded human audio','LOCAL INFERENCE','With consent, an operator can supply a live capture or uploaded clip to ASR, replay, Pella, AASIST and optional speaker-similarity analysis.','These are per-call detector signals, not a labelled evaluation dataset. Results support review but do not establish identity, authenticity, or population-level accuracy.','available')
  );
}
export async function apiModel(command,body){if(command!=='intent')assertMediaInput(body,'Audio-bearing media');const endpoint=command==='deepfake'?'diagnostic':command;const response=await fetch(`/api/${endpoint}`,{method:'POST',headers:{'Content-Type':command==='intent'?'application/json':'application/octet-stream'},body:command==='intent'?JSON.stringify(body):body});const data=await response.json();if(!response.ok)throw new Error(data.error||'Model request failed');return data;}
export function renderLearned(result,error=null){
 const host=$('learned-result');host.replaceChildren(element('b','Learned scam classifier'));
 if(error){host.append(element('p',error));return;}
 if(!result){host.append(element('p','Add a conversation to run the trained model.'));return;}
 host.append(element('p',`${result.usable?(result.decision||result.prediction.toUpperCase()):result.status} · model score ${result.score.toFixed(3)} · ${result.inference_ms} ms`,'model-verdict'));
 host.append(element('p',result.score_meaning,'fine'));
 const terms=element('div',undefined,'model-terms');for(const term of result.contributions.slice(0,8))terms.append(element('span',`${term.phrase} ${term.direction==='scam'?'↑':'↓'}`,term.direction==='scam'?'term-positive':'term-negative'));host.append(terms);
 const details=element('details');details.append(element('summary','Closest training examples & model evidence'));
 details.append(element('p','Terms show linear-model contributions, not independent intent categories. Similarity retrieves training examples; it does not prove fraud.'));
 for(const item of result.neighbors){details.append(element('p',`${item.id} · ${item.label?'scam':'non-scam'} · similarity ${item.similarity.toFixed(3)}\n${item.excerpt}`));}host.append(details);
}
export function renderReplay(id,result,error=null){const host=$(id);host.hidden=false;host.replaceChildren();
 if(error){host.append(element('b','Replay analysis unavailable'),element('p',error));return;}
 host.append(element('b',`${result.status}${result.score===null?'':` · score ${result.score.toFixed(3)}`}`),element('p',result.reason),element('small',`Fresh request, not a saved prediction · ASVspoof 2017 V2 replay model · ${result.inference_ms||0} ms. A genuine-like result does not verify identity.`));
}
async function fetchJSON(url){const response=await fetch(url);const data=await response.json();if(!response.ok)throw new Error(data.error||'Local service request failed');return data;}
export async function initDatasetLab({loadText,useReply,status:sharedStatus}={}){
 const unknownStatus=()=>({runtime:false,asr:false,intent:false,replay:false,datasetAudio:false,evaluationVerified:false,reasons:{runtime:'Readiness could not be checked. Saved reports do not establish local availability.',datasetAudio:'Audio availability could not be checked; saved metadata remains browsable.'}});
 const statusPromise=Promise.resolve(sharedStatus===undefined?fetchJSON('/api/status'):sharedStatus).then(value=>value&&['runtime','asr','intent','replay','datasetAudio'].every(key=>typeof value[key]==='boolean')?{value,available:true}:{value:unknownStatus(),available:false},()=>({value:unknownStatus(),available:false}));
 const reportsPromise=fetchJSON('/api/reports').then(value=>({value:value||{},available:true}),()=>({value:{},available:false}));
 const coveragePromise=fetchJSON('/api/human-vishing-coverage').catch(error=>({deploymentValidated:false,evaluationReady:false,evidencePackageComplete:false,source:'unavailable',gaps:[error.message],verifiedInteractiveHuman:{scam:0,genuine:0,matchedTopicGroups:0,confirmedLiveVoiceConversion:0},wording:'Interactive human-vishing coverage could not be verified.'}));
 const [readiness,saved,coverage]=await Promise.all([statusPromise,reportsPromise,coveragePromise]);
 let status=readiness.value;const reports=saved.value;
 const metricHost=$('dataset-metrics');metricHost.replaceChildren(element('small',saved.available?'BothBosu conversations + Fraud Call India publisher labels + weak-labelled NCSU transcripts / replay benchmark; not interactive-human-call validated. Saved metrics are not rerun on page load.':'Intent and replay reports unavailable; not real-call validated. Dataset metadata may still be browsed.'));
 const visibleSources=element('p',undefined,'fine');appendSourceLinks(visibleSources);metricHost.append(visibleSources);
 const catalogueSources=$('catalogue-sources');
 if(catalogueSources){catalogueSources.replaceChildren(element('b','Dataset sources: '));appendSourceLinks(catalogueSources);}
 if(sharedStatus===undefined)$('model-health').textContent=readiness.available
  ?`Text rules ready · Classifier ${status.intent?'checked':'unavailable'} · Replay ${status.replay?'checked':'unavailable'} · Speech ${status.asr?'checked':'unavailable'}.`
  :'Local readiness unverified · browser text rules still work.';
 $('model-health').title=Object.values(status.reasons||{}).join('\n');
 renderAudit(reports);
 renderRealHumanAnalysis(status,coverage);
 renderExternalDatasets(reports);
 const coverageHost=$('human-vishing-coverage');if(coverageHost){const counts=coverage.verifiedInteractiveHuman||{};const box=element('div',undefined,'audit-card');box.append(element('h4','Interactive human-vishing evidence'),element('b',coverage.evidencePackageComplete?'EVIDENCE PACKAGE COMPLETE — EXTERNAL DECISION STILL REQUIRED':coverage.evaluationReady?'EVALUATION READY — NOT DEPLOYMENT VALIDATED':'NOT VALIDATED'),element('p',coverage.wording),element('small',`${counts.scam||0} byte-verified human interactive scam · ${counts.genuine||0} byte-verified genuine · ${counts.matchedTopicGroups||0} matched groups · ${counts.confirmedLiveVoiceConversion||0} confirmed live-VC · source: ${coverage.source}`));for(const gap of coverage.gaps||[])box.append(element('p',gap,'fine'));for(const error of coverage.errors||[])box.append(element('p',`Audit error: ${error}`,'fine'));coverageHost.replaceChildren(box);}
 const sources=$('source-list');sources.replaceChildren();
 appendSourceLinks(sources);
 sources.append(element('p','Source-card descriptions: BothBosu single-agent conversations were generated with meta-llama-3-70b-instruct; the multi-agent corpus uses AutoGen/Together synthetic agents. Scenario families align with labels, so topic shortcuts can inflate scores. Neither is a real-call validation corpus.'));
 sources.append(element('p','Edinburgh ASVspoof 2017 V2 is a recorded replay benchmark, not proof of real-call fraud detection, identity, liveness, or modern synthetic-voice detection. Stored reports and example metadata do not mean the original waveform archives are available locally.'));
 sources.append(element('p','Source links, retrieval dates, sizes, licenses and checksums below are saved report claims, not current verification. No source files or speaker sets were rehashed or rechecked by this page.'));
 for(const file of reports.sources?.files||[])sources.append(element('p',`Saved claim: ${file.name} · ${(file.bytes/1048576).toFixed(1)} MB · ${file.license}\nReported SHA-256 ${file.sha256||'not reported'}`));
 for(const warning of [...reports.intent?.limitations||[],...reports.replay?.limitations||[]])sources.append(element('p',`Saved report limitation: ${warning}`));
 $('download-report').onclick=()=>{const blob=new Blob([JSON.stringify(reports,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=element('a');a.href=url;a.download='aegisvoice-public-dataset-results.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const state={text:{offset:0,rows:[],total:0,request:0,available:false},audio:{offset:0,rows:[],total:0,request:0,available:false}};
 let audioBusy=false;
 const selected=kind=>state[kind].rows.find(r=>r.id===$(kind+'-sample').value);
 const audioAvailable=record=>Boolean(record&&status.datasetAudio&&record.audioAvailable!==false);
 function controls(){
   $('load-text').disabled=!selected('text')||typeof loadText!=='function';
   $('run-audio').disabled=audioBusy||!audioAvailable(selected('audio'))||!status.replay;
   $('use-reply').disabled=audioBusy||!audioAvailable(selected('audio'))||!status.asr||typeof useReply!=='function';
   $('run-audio').title=!audioAvailable(selected('audio'))?'Original recording unavailable locally.':!status.replay?status.reasons?.replay||'Replay inference unavailable.':'Run fresh waveform analysis';
   $('use-reply').title=!audioAvailable(selected('audio'))?'Original recording unavailable locally.':!status.asr?status.reasons?.asr||'Speech inference unavailable.':'Use this stored recording, not a live response';
 }
 function resetPlayback(){const player=$('dataset-playback');player.pause();player.removeAttribute('src');player.load();player.hidden=true;}
 resetPlayback();$('dataset-playback').preload='none';
 function preview(kind){const r=selected(kind);if(!r)return;
   if(kind==='text'){
     const savedDecision=savedTextDecision(r,reports.intent),level=savedDecision?`Saved call-content snapshot: level ${savedDecision.rank}/4 ${savedDecision.levelName} · ${savedDecision.label}. `:'';
     $('text-preview').textContent=`${r.evaluation_split} (source split name) · ${r.type} · saved label ${r.label?'scam':'non-scam'} · ${Number.isInteger(r.prediction)?`saved model prediction ${r.prediction?'scam':'non-scam'}`:'not scored by the local model'}.\n${level}This is stored evaluation output, not fresh inference. Open it in Transcript Lab to rerun rules and the current model.\n${r.turns.filter(t=>t.role==='caller').map(t=>t.text).join(' ').slice(0,400)}`;
   }
   else{
     const available=audioAvailable(r);
     $('audio-preview').textContent=`${r.id} · reported speaker ${r.speaker??'unknown'} · saved label ${r.label?'replay':'genuine'} · saved binary prediction ${r.prediction?'replay':'genuine'}.\n${available?'Recording available for playback. Fresh inference is a separate action and uses an uncertainty band.':r.audioAvailable===false?'This recording is unavailable locally; saved metadata only.':status.reasons?.datasetAudio||'Original recording unavailable locally; saved metadata only.'}${available&&!status.replay?' Replay inference is unavailable.':''}`;
     resetPlayback();
     if(available){$('dataset-playback').hidden=false;$('dataset-playback').src=`/api/dataset/audio/${encodeURIComponent(r.id)}`;}
     $('dataset-audio-result').hidden=true;
   }
   controls();
 }
 async function refresh(kind){const s=state[kind];const params=new URLSearchParams({offset:String(s.offset),limit:'12',label:$(kind+'-label').value,errors:$(kind+'-errors').checked?'1':'0'});
   const request=++s.request;s.rows=[];s.available=false;controls();
   $(kind+'-prev').disabled=$(kind+'-next').disabled=true;
   $(kind+'-sample').replaceChildren();$(kind+'-preview').textContent='';$(kind+'-page').textContent='Loading saved metadata…';
   if(kind==='audio'){resetPlayback();$('dataset-audio-result').hidden=true;}
   try{const res=await fetch(`/api/dataset/${kind}?${params}`);const result=await res.json();if(!res.ok)throw new Error(result.error);
    if(request!==s.request)return;s.rows=result.rows;s.total=result.total;s.available=true;
    $(kind+'-sample').replaceChildren(...s.rows.map(r=>{const savedDecision=kind==='text'?savedTextDecision(r,reports.intent):null;const n=element('option',kind==='text'?`${r.id} · ${savedDecision?`LEVEL ${savedDecision.rank}/4 ${savedDecision.levelName}`:`${r.label?'scam':'non-scam'} · ${r.type}`}`:`${r.id} · ${r.label?'replay':'genuine'}`);n.value=r.id;return n;}));
    $(kind+'-page').textContent=s.total?`${s.offset+1}–${s.offset+s.rows.length} of ${s.total.toLocaleString()}`:'No records match this filter';
    $(kind+'-prev').disabled=s.offset===0;$(kind+'-next').disabled=s.offset+12>=s.total;
    controls();
    if(s.rows.length)preview(kind);else{$(kind+'-preview').textContent='';if(kind==='audio'){$('dataset-playback').removeAttribute('src');$('dataset-audio-result').hidden=true;}}
   }catch(e){if(request===s.request){s.rows=[];s.available=false;controls();$(kind+'-page').textContent=e.message;}}
 }
 for(const kind of ['text','audio']){
   $(kind+'-label').onchange=$(kind+'-errors').onchange=()=>{state[kind].offset=0;refresh(kind);};
   $(kind+'-prev').onclick=()=>{state[kind].offset=Math.max(0,state[kind].offset-12);refresh(kind);};
   $(kind+'-next').onclick=()=>{state[kind].offset+=12;refresh(kind);};
   $(kind+'-sample').onchange=()=>preview(kind);
 }
 $('load-text').onclick=()=>{const r=selected('text');if(r&&typeof loadText==='function'){loadText(r);$('text-sample-status').textContent=`Loaded ${r.id}. Saved source label: ${r.label?'scam':'non-scam'}. Rule analysis is separate; ${status.intent?'fresh learned inference can be requested.':'learned inference is unavailable.'}`;}};
 async function recording(record){const response=await fetch(`/api/dataset/audio/${encodeURIComponent(record.id)}`);if(!response.ok){const error=await response.json();throw new Error(error.error||'Recording unavailable');}return response.blob();}
 $('run-audio').onclick=async()=>{const r=selected('audio');if(audioBusy||!audioAvailable(r)||!status.replay)return;audioBusy=true;controls();renderReplay('dataset-audio-result',{status:'Fresh waveform analysis…',score:null,reason:'Reading the local recording and extracting acoustic features; saved predictions are not reused.'});
   try{const blob=await recording(r);const result=await apiModel('replay',blob);if(selected('audio')?.id===r.id)renderReplay('dataset-audio-result',result);}catch(e){if(selected('audio')?.id===r.id)renderReplay('dataset-audio-result',null,e.message);}finally{audioBusy=false;controls();}
 };
 $('use-reply').onclick=async()=>{const r=selected('audio');if(audioBusy||!audioAvailable(r)||!status.asr||typeof useReply!=='function')return;audioBusy=true;controls();try{const blob=await recording(r);await useReply(blob,r);}catch(e){if(selected('audio')?.id===r.id)renderReplay('dataset-audio-result',null,e.message);}finally{audioBusy=false;controls();}};
 await Promise.all([refresh('text'),refresh('audio')]);
 return {status,reports,readinessAvailable:readiness.available,reportsAvailable:saved.available,textMetadataAvailable:state.text.available,audioMetadataAvailable:state.audio.available,
   setStatus(value){status=value??unknownStatus();controls();preview('audio');}
 };
}
