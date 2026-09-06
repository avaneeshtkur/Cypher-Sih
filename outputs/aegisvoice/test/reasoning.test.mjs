import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../engine.mjs';
import { buildTrace, traceSummary, resetTrace, STAGES } from '../reasoning.mjs';

const caller = text => ({ role: 'caller', text });
const SCAM = [
  caller('This is the CFO. I need you to transfer 20 lakh within the next twenty minutes.'),
  { role: 'employee', text: 'Should I confirm the beneficiary with our finance team?' },
  caller("Use the new account details. Skip the usual approval. Don't call me back. Keep this between us.")
];

test('the trace ends with the same decision the engine made', () => {
  const a = analyze(SCAM);
  const trace = buildTrace(a);
  const last = trace[trace.length - 1];
  assert.equal(last.stage, 'decision');
  assert.equal(last.state, a.state);
  assert.equal(last.detail, a.reason);
});
test('the visible trace uses a direct risk label instead of the internal review state', () => {
  const a = analyze([
    caller('We would like to inform you that there is an order placed for an Apple iPhone using your Amazon account.'),
    caller('If you do not authorize this order, press 1 or press 2 to authorize this order.')
  ]);
  assert.equal(a.state, 'Needs verification');
  const last = buildTrace(a).at(-1);
  assert.equal(last.title, 'SUSPICIOUS REQUEST DETECTED');
  assert.doesNotMatch(last.title, /needs verification/i);
});
test('every detected category appears in the trace', () => {
  const a = analyze(SCAM);
  const trace = buildTrace(a);
  const traced = new Set(trace.filter(s => s.stage === 'rule').map(s => s.category));
  for (const key of a.detected) assert.ok(traced.has(key), `category ${key} missing from trace`);
});
test('the trace never invents a category the engine did not detect', () => {
  const a = analyze(SCAM);
  const trace = buildTrace(a);
  for (const s of trace.filter(s => s.stage === 'rule')) assert.ok(a.detected.includes(s.category), `invented ${s.category}`);
});
test('evidence that argues against an alert is shown, not hidden', () => {
  const a = analyze([caller('This payment is urgent. Please complete the usual approval. Call the vendor on our saved number.')]);
  const trace = buildTrace(a);
  assert.ok(trace.some(s => s.stage === 'safeguard'), 'safeguards must appear');
  assert.ok(trace.some(s => s.weight === 'lowers'), 'a lowering step must appear');
});
test('excluded evidence is explained rather than dropped silently', () => {
  const a = analyze([caller('Do not transfer the money. Never skip the usual approval.')]);
  const trace = buildTrace(a);
  const excluded = trace.filter(s => s.stage === 'exclusion');
  assert.ok(excluded.length >= 1);
  assert.match(excluded[0].detail, /would be a false alarm/);
});
test('steps are sequential and every stage is known', () => {
  resetTrace();
  const trace = buildTrace(analyze(SCAM));
  trace.forEach((s, i) => {
    assert.equal(s.seq, i + 1, 'sequence must be gapless');
    assert.ok(STAGES[s.stage], `unknown stage ${s.stage}`);
    assert.ok(s.title && s.detail, 'every step must explain itself');
  });
});
test('an unusable model result is reported as withheld, not as evidence', () => {
  const trace = buildTrace(analyze(SCAM), { model: { usable: false, status: 'Outside training vocabulary', score: 0.9 } });
  const step = trace.find(s => s.stage === 'model');
  assert.match(step.title, /withheld/);
  assert.equal(step.weight, 'neutral');
});
test('a usable model result reports its score and direction', () => {
  const trace = buildTrace(analyze(SCAM), { model: { usable: true, score: 0.94, threshold: 0.5, prediction: 'scam', contributions: [{ phrase: 'skip approval', direction: 'scam' }] } });
  const step = trace.find(s => s.stage === 'model');
  assert.match(step.title, /0\.940/);
  assert.equal(step.weight, 'raises');
});
test('a clean conversation produces a lowering decision and no rule steps', () => {
  const a = analyze([caller('Hello, I am calling about the meeting agenda for tomorrow.')]);
  const trace = buildTrace(a);
  assert.equal(trace.filter(s => s.stage === 'rule').length, 0);
  assert.equal(trace[trace.length - 1].weight, 'lowers');
});
test('the decision step always carries its caveat', () => {
  for (const turns of [SCAM, [caller('Hello there.')]]) {
    const decision = buildTrace(analyze(turns)).find(s => s.stage === 'decision');
    assert.match(decision.caveat, /does not establish fraud/);
  }
});
test('escalation after resistance is explained in the trace', () => {
  const trace = buildTrace(analyze(SCAM));
  const step = trace.find(s => s.stage === 'dynamics');
  assert.ok(step, 'dynamics step expected');
  assert.match(step.detail, /turn 2/);
});
test('Indic rule evidence is labelled with its language', () => {
  const a = analyze([caller('Main CBI officer bol raha hoon. Turant paise bhejo. Kisi ko mat batao.')]);
  const trace = buildTrace(a);
  assert.ok(trace.some(s => s.stage === 'language'));
  assert.ok(trace.some(s => s.stage === 'rule' && s.language));
});
test('summary counts match the steps present', () => {
  const trace = buildTrace(analyze(SCAM));
  const s = traceSummary(trace);
  assert.equal(s.steps, trace.length);
  assert.equal(s.raises, trace.filter(t => t.weight === 'raises').length);
  assert.equal(s.state, trace[trace.length - 1].state);
});
test('liveness and channel evidence appear when supplied', () => {
  const trace = buildTrace(analyze(SCAM), {
    channel: { usable: true, snrDb: 22, speechSeconds: 4.2, narrowband: false, clippingRatio: 0 },
    liveness: { state: 'Live-consistent', reason: 'ok', support: 'phrase-only', channel: { state: 'consistent' }, reliability: 0.85 }
  });
  assert.ok(trace.some(s => s.stage === 'channel'));
  const live = trace.find(s => s.stage === 'liveness');
  assert.match(live.detail, /Identity is not established/);
});
