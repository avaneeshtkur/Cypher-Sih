// Deterministic software-behavior diagnostic for the exact generators used by
// the visible Attack Lab. These proxies are not real attack classes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ATTACK_CLASSES, ATTACK_MODEL_LIMITS, classifyAttackPath, extractAttackObservation } from '../attack-model.mjs';
import { ATTACK_SIMULATIONS, simulateAttackCondition } from '../attack-simulations.mjs';

const TRIALS=12,WINDOWS=4,WINDOW_SECONDS=1.1;
const round=value=>Math.round(value*10000)/10000;
const percentile=(values,q)=>[...values].sort((a,b)=>a-b)[Math.min(values.length-1,Math.floor((values.length-1)*q))];
const trialRows=[];

for(const condition of ATTACK_SIMULATIONS){
  for(let trial=0;trial<TRIALS;trial++){
    const simulation=simulateAttackCondition(condition.id,{windows:WINDOWS,seconds:WINDOW_SECONDS,seed:1000+trial*97});
    const observations=[];let previous=null;
    for(const pcm of simulation.windows){
      const observation=extractAttackObservation(pcm,simulation.rate,previous);
      observations.push(observation);previous=observation;
    }
    const result=classifyAttackPath(observations,{
      ...condition.context,
      labCondition:{id:condition.id,label:condition.label,expectedClass:condition.expectedClass,simulated:true}
    });
    trialRows.push({
      condition:condition.id,expectedClass:condition.expectedClass,topClass:result.topClass,
      supportScores:Object.fromEntries(ATTACK_CLASSES.map(label=>[label,result.classes[label].support])),
      margin:result.margin,uncertainty:result.uncertainty,sufficientEvidence:result.sufficientEvidence,
      featureSummary:result.featureSummary
    });
  }
}

function summarize(condition){
  const rows=trialRows.filter(row=>row.condition===condition.id);
  const decisions=Object.fromEntries([...ATTACK_CLASSES,'uncertain'].map(label=>[label,0]));
  rows.forEach(row=>decisions[row.topClass]++);
  const supportMean={},supportRange={};
  for(const label of ATTACK_CLASSES){
    const values=rows.map(row=>row.supportScores[label]);
    supportMean[label]=round(values.reduce((sum,value)=>sum+value,0)/values.length);
    supportRange[label]={min:round(Math.min(...values)),max:round(Math.max(...values))};
  }
  const margins=rows.map(row=>row.margin),uncertainty=rows.map(row=>row.uncertainty);
  const featureMean={};
  for(const key of ['acousticSpace','reverbProxySeconds','highBandRatio','spectralFlatness','spectralCentroidHz','spectralTiltDb','zeroCrossingRate','snrDb','silenceRatio','crestFactor','harmonicity','noiseFloorRms','featureDrift','noiseContinuity']){
    const values=rows.map(row=>row.featureSummary[key]).filter(Number.isFinite);
    featureMean[key]=values.length?round(values.reduce((sum,value)=>sum+value,0)/values.length):null;
  }
  return {
    id:condition.id,label:condition.label,expected_simulation_label:condition.expectedClass,
    capture_context:condition.context,transform:condition.description,trials:rows.length,decisions,
    sufficient_evidence_trials:rows.filter(row=>row.sufficientEvidence).length,
    feature_mean:featureMean,support_mean:supportMean,support_range:supportRange,
    margin:{min:round(Math.min(...margins)),p50:round(percentile(margins,.5)),p90:round(percentile(margins,.9)),max:round(Math.max(...margins))},
    uncertainty:{min:round(Math.min(...uncertainty)),mean:round(uncertainty.reduce((sum,value)=>sum+value,0)/uncertainty.length),max:round(Math.max(...uncertainty))}
  };
}

const conditions=ATTACK_SIMULATIONS.map(summarize);
const confusionCounts={};
for(const condition of ATTACK_SIMULATIONS){
  confusionCounts[condition.expectedClass]=Object.fromEntries([...ATTACK_CLASSES,'uncertain'].map(label=>[
    label,trialRows.filter(row=>row.condition===condition.id&&row.topClass===label).length
  ]));
}
const pairs=[];
for(let left=0;left<conditions.length;left++)for(let right=left+1;right<conditions.length;right++){
  const overlapping=[];
  for(const label of ATTACK_CLASSES){
    const a=conditions[left].support_range[label],b=conditions[right].support_range[label];
    const width=Math.min(a.max,b.max)-Math.max(a.min,b.min);
    if(width>=0)overlapping.push({class:label,interval_width:round(width)});
  }
  pairs.push({conditions:[conditions[left].id,conditions[right].id],overlapping_support_classes:overlapping});
}

const report={
  artifact_version:3,deterministic:true,generated_by:'tools/calibrate-attack-model.mjs',
  generator_module:'attack-simulations.mjs',
  method:'Deterministic synthetic speech-like signals under controlled transforms shared with the visible Attack Lab. These simulations are not real attack classes and do not measure field performance.',
  support_semantics:'Scores are normalized relative display support from heuristic cues, not calibrated class likelihoods.',
  api_contract:{
    version:1,
    observation:{signature:'extractAttackObservation(pcm, rate, previous?)',shape:{schemaVersion:'number',sequence:'non-negative integer',usable:'boolean',reason:'string|null',profile:'channelProfile object',metrics:'DSP metrics object',pcmSummary:'bounded PCM analysis summary object',temporal:'backward-looking comparison object',start:'number|null',end:'number|null'}},
    classifier:{signature:'classifyAttackPath(observations, { captureKind, knownSource, labCondition? })',class_keys:ATTACK_CLASSES,primary_shape:{classes:'object keyed by all four class keys',uncertainty:'number from 0 through 1',sufficientEvidence:'boolean',topClass:'one class key or uncertain',margin:'number from 0 through 1',evidence:'evidence item array',contradictions:'contradiction item array',coverageSeconds:'bounded sum of usable observation durations'}}
  },
  configuration:{sample_rate:16000,trials_per_condition:TRIALS,windows_per_trial:WINDOWS,seconds_per_window:WINDOW_SECONDS,model_limits:ATTACK_MODEL_LIMITS},
  conditions,confusion_counts:confusionCounts,
  overlap:{any_pairwise_support_overlap:pairs.some(pair=>pair.overlapping_support_classes.length>0),pairwise_support_overlap:pairs},
  limitations:[
    'Controlled simulations exercise software behavior; they are not recordings of real human, voice-conversion, injection, or speaker-replay attacks.',
    'The visible lab and calibration now import the same generator module, but that does not create deployment validity.',
    'Support weights are not probabilities and cannot establish identity or voice authenticity.',
    'Microphones, rooms, loudspeakers, codecs and real voice-conversion systems require independent field evaluation.'
  ]
};

const target=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','models');
mkdirSync(target,{recursive:true});
writeFileSync(path.join(target,'attack_calibration.json'),JSON.stringify(report,null,2));
console.log('condition'.padEnd(31),'expected'.padEnd(24),'uncertain'.padEnd(10),'margin p50','uncertainty mean');
for(const condition of conditions)console.log(condition.label.padEnd(31),condition.expected_simulation_label.padEnd(24),String(condition.decisions.uncertain).padEnd(10),condition.margin.p50.toFixed(4).padEnd(10),condition.uncertainty.mean.toFixed(4));
console.log('written: models/attack_calibration.json');
