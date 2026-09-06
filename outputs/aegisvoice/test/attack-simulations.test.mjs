import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ATTACK_SIMULATIONS, simulateAttackCondition } from '../attack-simulations.mjs';
import { ATTACK_CLASSES, extractAttackObservation, classifyAttackPath } from '../attack-model.mjs';

test('visible calibration simulations are deterministic and labels never leak into support',()=>{
  for(const condition of ATTACK_SIMULATIONS){
    const first=simulateAttackCondition(condition.id),second=simulateAttackCondition(condition.id);
    assert.deepEqual(first.windows,second.windows);
    const build=simulation=>{
      let previous=null;
      return simulation.windows.map(pcm=>{const current=extractAttackObservation(pcm,simulation.rate,previous);previous=current;return current;});
    };
    const observations=build(first);
    const base=classifyAttackPath(observations,condition.context);
    const labelled=classifyAttackPath(observations,{...condition.context,labCondition:{expectedClass:condition.expectedClass,label:'comparison only'}});
    assert.deepEqual(base.classes,labelled.classes,`${condition.id} leaked its label into scores`);
    assert.equal(base.uncertainty,labelled.uncertainty);
    assert.equal(Object.values(base.classes).reduce((sum,item)=>sum+item.support,0),1);
    for(const key of ATTACK_CLASSES)assert.ok(base.classes[key].explanation);
  }
});

test('all four visible proxies exercise distinct expected contexts without claiming field validation',()=>{
  assert.deepEqual(new Set(ATTACK_SIMULATIONS.map(c=>c.expectedClass)),new Set(ATTACK_CLASSES));
  assert.equal(ATTACK_SIMULATIONS.find(c=>c.expectedClass==='direct-injection').context.knownSource,true);
  assert.equal(ATTACK_SIMULATIONS.find(c=>c.expectedClass==='speaker-replay').context.captureKind,'microphone');
  assert.equal(ATTACK_SIMULATIONS.find(c=>c.expectedClass==='live-voice-conversion').context.captureKind,'shared-audio');
  assert.match(ATTACK_SIMULATIONS.find(c=>c.expectedClass==='live-voice-conversion').description,/not a real vocoder/i);
});

test('visible proxy catalogue matches the saved calibration catalogue',()=>{
  const artifact=JSON.parse(readFileSync(new URL('../models/attack_calibration.json',import.meta.url),'utf8'));
  assert.equal(artifact.generator_module,'attack-simulations.mjs');
  assert.deepEqual(artifact.conditions.map(c=>c.id),ATTACK_SIMULATIONS.map(c=>c.id));
  assert.deepEqual(artifact.conditions.map(c=>c.expected_simulation_label),ATTACK_SIMULATIONS.map(c=>c.expectedClass));
  assert.match(artifact.method,/not real attack classes/i);
  assert.match(artifact.support_semantics,/not calibrated class likelihoods/i);
});

test('invalid simulation identifiers fail visibly',()=>{
  assert.throws(()=>simulateAttackCondition('unknown'),/Unknown attack simulation/);
});
