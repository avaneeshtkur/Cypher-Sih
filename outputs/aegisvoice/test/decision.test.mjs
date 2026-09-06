import test from 'node:test';
import assert from 'node:assert/strict';
import { directDecision, decisionTone, displayRuleState, RISK_LEVELS } from '../decision.mjs';

test('strong explicit evidence produces a direct high-risk decision',()=>{
  const decision=directDecision({state:'Strongly suspicious',reason:'OTP and urgency detected.'},{usable:true,risk_band:'low-risk',score:.1});
  assert.equal(decision.level,'high');
  assert.equal(decision.label,'HIGH-RISK SCAM BEHAVIOR DETECTED');
  assert.equal(decision.rank,4);
  assert.equal(decision.scope,'call-content');
});

test('corroborated learned high-risk band produces the combined warning',()=>{
  const decision=directDecision({state:'Needs verification',reason:'Payment request detected.'},{usable:true,risk_band:'high-risk',score:.981});
  assert.equal(decision.level,'high');
  assert.equal(decision.label,'HIGH-RISK SCAM-LIKE CALL');
  assert.match(decision.reason,/0\.981/);
});

test('low-risk band is shown only without conflicting rule evidence',()=>{
  const low=directDecision({state:'No concerning combination'},{usable:true,risk_band:'low-risk',score:.12});
  const suspicious=directDecision({state:'Needs verification',reason:'Verify independently.'},{usable:true,risk_band:'low-risk',score:.12});
  assert.equal(low.level,'low');assert.equal(low.rank,1);assert.equal(low.label,'LOW-RISK / LEGITIMATE-LIKE');
  assert.equal(suspicious.level,'suspicious');assert.equal(suspicious.rank,3);assert.equal(suspicious.label,'SUSPICIOUS REQUEST DETECTED');
});

test('middle scores receive a caution level distinct from suspicious rule evidence',()=>{
  const decision=directDecision({state:'No concerning combination'},{usable:true,risk_band:'elevated-risk',score:.6});
  assert.equal(decision.level,'caution');
  assert.equal(decision.rank,2);
  assert.equal(decision.label,'ELEVATED-RISK LANGUAGE — USE CAUTION');
  assert.equal(decision.confidence,'low');
});

test('an uncorroborated high model band is caution rather than a red verdict',()=>{
  const decision=directDecision({state:'No concerning combination'},{usable:true,risk_band:'high-risk',score:.98});
  assert.equal(decision.level,'caution');
  assert.equal(decision.rank,2);
  assert.match(decision.label,/WITHOUT RULE CORROBORATION/);
});

test('unusable speech is reported as an input failure rather than guessed',()=>{
  const decision=directDecision({state:'No concerning combination'},{usable:false,risk_band:'elevated-risk',score:.6});
  assert.equal(decision.level,'uncertain');
  assert.equal(decision.label,'AUDIO / TRANSCRIPT NOT ANALYSABLE');
});

test('internal review states are presented as concrete risk labels',()=>{
  assert.equal(displayRuleState('Needs verification'),'SUSPICIOUS REQUEST DETECTED');
  assert.equal(displayRuleState('Strongly suspicious'),'HIGH-RISK SCAM BEHAVIOR DETECTED');
  assert.equal(displayRuleState('No concerning combination'),'NO EXPLICIT SCAM BEHAVIOR DETECTED');
});

test('risk tones preserve all four ordered levels',()=>{
  assert.deepEqual(Object.fromEntries(['low','caution','suspicious','high'].map(level=>[level,RISK_LEVELS[level].rank])),{low:1,caution:2,suspicious:3,high:4});
  for(const level of ['low','caution','suspicious','high'])assert.equal(decisionTone({level}),level);
  assert.equal(decisionTone(null,{state:'Needs verification'}),'suspicious');
  assert.equal(decisionTone({level:'uncertain'}),'neutral');
});
