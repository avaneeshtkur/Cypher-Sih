import test from 'node:test';
import assert from 'node:assert/strict';
import { CALL_CASES, CASE_GROUPS, casesFor, caseById } from '../case-library.mjs';
import { analyze, categories } from '../engine.mjs';

test('library contains exactly six authored cases in each reference group',()=>{
  assert.equal(CALL_CASES.length,18);
  assert.deepEqual(CASE_GROUPS.map(group=>group.id),['all','scam-like','genuine','unclear']);
  for(const group of ['scam-like','genuine','unclear'])assert.equal(casesFor(group).length,6,group);
  assert.equal(casesFor('all').length,18);
});

test('case identifiers and transcript turns are valid and reference labels cannot leak into inference',()=>{
  assert.equal(new Set(CALL_CASES.map(item=>item.id)).size,CALL_CASES.length);
  for(const item of CALL_CASES){
    assert.equal(caseById(item.id),item);
    assert.ok(item.title&&item.summary&&item.why);
    assert.ok(['scam-like','genuine','unclear'].includes(item.reference));
    assert.ok(item.turns.length>=2);
    for(const turn of item.turns){
      assert.deepEqual(Object.keys(turn).sort(),['role','text']);
      assert.ok(['caller','employee'].includes(turn.role));
      assert.ok(turn.text.trim());
      assert.doesNotMatch(turn.text,new RegExp(item.reference,'i'));
    }
  }
  assert.equal(caseById('missing'),null);
});

test('scam-like references all trigger a warning while genuine references do not',()=>{
  const scam=casesFor('scam-like').map(item=>analyze(item.turns));
  assert.ok(scam.every(result=>result.state!=='No concerning combination'));
  assert.ok(scam.filter(result=>result.state==='Strongly suspicious').length>=4);
  assert.ok(casesFor('genuine').every(item=>analyze(item.turns).state==='No concerning combination'));
});

test('unclear library deliberately contains both warning and non-warning outcomes without strong claims',()=>{
  const states=new Set(casesFor('unclear').map(item=>analyze(item.turns).state));
  assert.ok(states.has('Needs verification'));
  assert.ok(states.has('No concerning combination'));
  assert.ok(!states.has('Strongly suspicious'));
});

test('library collectively exercises every visible manipulation category and key sensitive actions',()=>{
  const results=CALL_CASES.map(item=>analyze(item.turns));
  assert.deepEqual(new Set(results.flatMap(result=>result.detected)),new Set(Object.keys(categories)));
  const actions=new Set(results.flatMap(result=>result.actionNames));
  for(const action of ['Payment','Credentials / OTP','Remote access'])assert.ok(actions.has(action),action);
});

test('audio links only point at existing guided-demo identifiers',()=>{
  const allowed=new Set(['payment-pressure','legitimate-payment','digital-arrest','refund-lure']);
  for(const item of CALL_CASES.filter(item=>item.audio))assert.ok(allowed.has(item.audio));
});
