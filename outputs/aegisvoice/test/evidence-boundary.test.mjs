import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceReport, contentRiskEvidence, hasSyntheticVoiceEvidence, referenceEvidence, replayEvidence, voiceOriginEvidence } from '../evidence-boundary.mjs';

test('dataset reference labels are retained but never marked as inference input',()=>{
  const result=referenceEvidence({id:'ncsu-1',label:'suspected-malicious',voiceOrigin:'unlabelled',fraudContext:'publisher context'},'database-audio');
  assert.equal(result.referenceLabel,'suspected-malicious');
  assert.equal(result.referenceLabelUsedForInference,false);
  assert.equal(result.fraudContext,'publisher context');
});

test('call-content, replay, and voice-origin evidence use independent scopes',()=>{
  const content=contentRiskEvidence({decision:{level:'low',rank:1},turns:[{role:'caller',text:'hello'}]});
  const replay=replayEvidence({caller:{status:'Replay-like'}});
  const voice=voiceOriginEvidence({caller:{status:'Synthetic/spoof evidence'}});
  assert.equal(content.scope,'call-content');
  assert.equal(replay.scope,'replay-and-channel');
  assert.equal(voice.scope,'voice-origin-and-similarity');
  assert.equal(content.decision.level,'low');
  assert.equal(replay.caller.status,'Replay-like');
  assert.equal(voice.caller.status,'Synthetic/spoof evidence');
});

test('the evidence report keeps all dimensions and an explicit no-label-leakage marker',()=>{
  const report=buildEvidenceReport({
    datasetRecord:{id:'sample',label:1,evaluation_split:'published test'},
    turns:[{role:'caller',text:'Verify on the official number.'}],assessment:{state:'No concerning combination'},
    decision:{level:'low',rank:1},callerReplay:{status:'Uncertain'},callerDeepfake:{status:'Synthetic/spoof evidence'}
  });
  assert.equal(report.reference.kind,'dataset-record');
  assert.equal(report.reference.referenceLabelUsedForInference,false);
  assert.equal(report.callContent.decision.level,'low');
  assert.equal(report.replayAndChannel.caller.status,'Uncertain');
  assert.equal(report.voiceOrigin.caller.status,'Synthetic/spoof evidence');
});

test('publisher-labelled synthetic samples recognize actual detector label values',()=>{
  assert.equal(hasSyntheticVoiceEvidence({detectors:{pella:{available:true,label:'synthetic-like'}}}),true);
  assert.equal(hasSyntheticVoiceEvidence({detectors:{aasist:{available:true,label:'spoof-like'}}}),true);
  assert.equal(hasSyntheticVoiceEvidence({detectors:{pella:{available:true,label:'real-like'},aasist:{available:true,label:'bonafide-like'}}}),false);
  assert.equal(hasSyntheticVoiceEvidence({detectors:{pella:{available:false,label:'synthetic-like'}}}),false);
});