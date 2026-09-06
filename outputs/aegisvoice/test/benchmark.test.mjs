import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from '../engine.mjs';

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkPath = path.join(app, 'models', 'rules_benchmark.json');
const corpusPath = path.join(app, 'models', 'text_examples.json');
const available = existsSync(benchmarkPath) && existsSync(corpusPath);

// Floors, not targets. They exist so a future rule edit cannot quietly make
// detection worse without the change being noticed.
const FLOORS = { accuracy: 0.80, precision: 0.85, recall: 0.72 };
const MAX_FALSE_POSITIVE_RATE = 0.12;

test('the saved rule benchmark discloses corpus reuse and legacy partition names', { skip: !available && 'benchmark artifacts not present' }, () => {
  const report = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
  assert.ok(report.records > 1000, 'benchmark should cover the full corpus');
  assert.equal(report.evaluation_kind, 'reused-corpus diagnostic');
  assert.match(report.provenance, /entire corpus and examples were inspected before and during rule tuning/i);
  assert.match(report.split_discipline.method, /neither is an independent evaluation/i);
  assert.match(report.split_discipline.legacy_keys.held_out, /odd-index reused records/);
  assert.ok(report.split_discipline.held_out.n > 400);
  const generator = readFileSync(path.join(app, 'tools', 'benchmark-rules.mjs'), 'utf8');
  assert.ok(generator.includes("evaluation_kind: 'reused-corpus diagnostic'"));
  assert.ok(generator.includes(report.provenance));
  assert.ok(generator.includes(report.split_discipline.method));
  for (const text of [generator, report.provenance, report.split_discipline.method]) {
    assert.doesNotMatch(text, /never used to adjust a rule|not used to author the rules|not tuned to this half|development half only/i);
  }
});

test('reused-corpus diagnostic accuracy has not regressed below its floor', { skip: !available && 'benchmark artifacts not present' }, () => {
  const rows = JSON.parse(readFileSync(corpusPath, 'utf8'));
  // Recompute agreement on all reused records; these floors do not test generalization.
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of rows) {
    const alert = analyze(row.turns).state !== 'No concerning combination';
    if (alert && row.label) tp++; else if (alert && !row.label) fp++;
    else if (!alert && row.label) fn++; else tn++;
  }
  const accuracy = (tp + tn) / rows.length;
  const precision = tp / (tp + fp);
  const recall = tp / (tp + fn);
  const fpr = fp / (fp + tn);
  assert.ok(accuracy >= FLOORS.accuracy, `reused-corpus accuracy ${accuracy.toFixed(4)} below floor ${FLOORS.accuracy}`);
  assert.ok(precision >= FLOORS.precision, `precision ${precision.toFixed(4)} below floor ${FLOORS.precision}`);
  assert.ok(recall >= FLOORS.recall, `recall ${recall.toFixed(4)} below floor ${FLOORS.recall}`);
  assert.ok(fpr <= MAX_FALSE_POSITIVE_RATE, `false-positive rate ${fpr.toFixed(4)} above ceiling ${MAX_FALSE_POSITIVE_RATE}`);
  const report = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
  const saved = report.operating_points['any concern'];
  assert.deepEqual({ tp: saved.tp, fp: saved.fp, tn: saved.tn, fn: saved.fn }, { tp, fp, tn, fn });
  assert.equal(saved.n, rows.length);
});

test('the corpus topic-shortcut flaw is recorded, not hidden', { skip: !available && 'benchmark artifacts not present' }, () => {
  const report = JSON.parse(readFileSync(benchmarkPath, 'utf8'));
  const audit = report.topic_shortcut_audit;
  assert.ok(audit, 'topic shortcut audit must be present');
  if (audit.every_family_is_single_label) assert.match(audit.finding, /without modelling fraud/);
});

test('institutional impersonation is treated as claimed authority', () => {
  for (const line of [
    'Hello, this is John from the Federal Trade Commission.',
    "Hello, my name is David and I'm calling from the Microsoft Refund Department.",
    'Hello, this is Alex from the customer service department of Amazon.',
    'This is John from Windows Technical Support.'
  ]) assert.ok(analyze([{ role: 'caller', text: line }]).detected.includes('authority'), `missed authority in: ${line}`);
});

test('device-compromise claims are treated as a threat tactic', () => {
  for (const line of [
    'We have received a notification that your computer is infected with malware.',
    'There is a virus on your computer and it is spreading rapidly.',
    'Your system has been compromised by hackers.'
  ]) assert.ok(analyze([{ role: 'caller', text: line }]).detected.includes('threat'), `missed threat in: ${line}`);
});

test('an ordinary business call still does not trigger authority or threat', () => {
  const r = analyze([{ role: 'caller', text: 'Hi, I am calling about the meeting agenda and the quarterly report.' }]);
  assert.ok(!r.detected.includes('authority'));
  assert.ok(!r.detected.includes('threat'));
  assert.equal(r.state, 'No concerning combination');
});
