// Measures the rule engine against every labelled record in models/text_examples.json.
// Run with: node tools/benchmark-rules.mjs
//
// This is a reused-corpus diagnostic, not a blind evaluation. The entire corpus
// and examples were inspected before and during rule tuning. Source split names
// describe the saved datasets, not separation from rule development. The labels are
// conversation-level "is this a scam call"; the rules answer a narrower question,
// "does this call combine manipulation with a sensitive request", so the two are
// related but not identical. Gaps are reported rather than explained away.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze, categories } from '../engine.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..');
const rows = JSON.parse(readFileSync(path.join(app, 'models', 'text_examples.json'), 'utf8'));

// Retain alternating diagnostic partitions for comparison with older artifacts.
// Neither partition is independent of rule tuning.
const EVEN = 0, ODD = 1;
const half = i => i % 2;

const OPERATING_POINTS = {
  'any concern': state => state !== 'No concerning combination',
  'strongly suspicious only': state => state === 'Strongly suspicious'
};

function score(predictions, labels) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < labels.length; i++) {
    if (predictions[i] && labels[i]) tp++;
    else if (predictions[i] && !labels[i]) fp++;
    else if (!predictions[i] && labels[i]) fn++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return {
    n: labels.length, tp, fp, tn, fn,
    accuracy: +((tp + tn) / labels.length).toFixed(4),
    precision: +precision.toFixed(4), recall: +recall.toFixed(4),
    f1: +(precision + recall ? (2 * precision * recall) / (precision + recall) : 0).toFixed(4),
    false_positive_rate: +(fp + tn ? fp / (fp + tn) : 0).toFixed(4),
    specificity: +(fp + tn ? tn / (fp + tn) : 0).toFixed(4)
  };
}

console.log(`Analysing ${rows.length} labelled conversations…`);
const started = Date.now();
const analysed = rows.map(r => ({ row: r, result: analyze(r.turns) }));
const elapsed = Date.now() - started;
const labels = analysed.map(a => a.row.label);

const report = {
  generated_at: new Date().toISOString(),
  evaluation_kind: 'reused-corpus diagnostic',
  engine: analysed[0].result.engine,
  records: rows.length,
  label_balance: { scam: labels.filter(Boolean).length, non_scam: labels.filter(l => !l).length },
  provenance: 'models/text_examples.json contains source-labelled published-test and transfer records. The entire corpus and examples were inspected before and during rule tuning. These reused records measure diagnostic agreement only, not independent generalization.',
  label_caveat: 'Labels are conversation-level scam/non-scam. The rules answer a narrower question (manipulation combined with a sensitive request), so perfect agreement is not the target and recall gaps are expected.',
  throughput_ms_per_record: +(elapsed / rows.length).toFixed(3),
  operating_points: {}, by_split: {}, by_scenario: {}, category_signal: {}, errors: {}
};

for (const [name, decide] of Object.entries(OPERATING_POINTS)) {
  const predictions = analysed.map(a => decide(a.result.state));
  report.operating_points[name] = score(predictions, labels);
}

// Legacy keys below are retained for consumers of older reports, not as split claims.
const primaryAll = analysed.map(a => a.result.state !== 'No concerning combination');
const devIdx = analysed.map((_, i) => i).filter(i => half(i) === EVEN);
const heldIdx = analysed.map((_, i) => i).filter(i => half(i) === ODD);
report.split_discipline = {
  method: 'Alternating even/odd index diagnostic partitions. Both contain records inspected before and during rule tuning; neither is an independent evaluation.',
  legacy_keys: { development: 'even-index reused records', held_out: 'odd-index reused records; not held out from rule development' },
  development: score(devIdx.map(i => primaryAll[i]), devIdx.map(i => labels[i])),
  held_out: score(heldIdx.map(i => primaryAll[i]), heldIdx.map(i => labels[i]))
};

// Scenario family versus label. If a family is entirely one label, topic alone
// predicts the answer and any model trained here can shortcut.
const familyTable = {};
for (const r of rows) {
  const f = (familyTable[r.type] ??= { scam: 0, non_scam: 0 });
  f[r.label ? 'scam' : 'non_scam']++;
}
const pure = Object.entries(familyTable).filter(([, v]) => v.scam === 0 || v.non_scam === 0);
report.topic_shortcut_audit = {
  families: familyTable,
  single_label_families: pure.map(([k]) => k),
  every_family_is_single_label: pure.length === Object.keys(familyTable).length,
  finding: pure.length === Object.keys(familyTable).length
    ? 'Every scenario family carries exactly one label. Topic alone predicts the label on this corpus, so a high score here can be achieved without modelling fraud at all. This is direct evidence for the topic-shortcut limitation stated in the README, and it applies to the trained classifier as well as to these rules.'
    : 'Scenario families contain both labels.'
};

const primary = analysed.map(a => a.result.state !== 'No concerning combination');
for (const split of [...new Set(rows.map(r => r.evaluation_split))]) {
  const idx = analysed.map((a, i) => (a.row.evaluation_split === split ? i : -1)).filter(i => i >= 0);
  report.by_split[split] = score(idx.map(i => primary[i]), idx.map(i => labels[i]));
}
for (const type of [...new Set(rows.map(r => r.type))].sort()) {
  const idx = analysed.map((a, i) => (a.row.type === type ? i : -1)).filter(i => i >= 0);
  report.by_scenario[type] = score(idx.map(i => primary[i]), idx.map(i => labels[i]));
}

// How much does each individual category discriminate on its own? A category that
// fires equally on scam and non-scam calls is not carrying weight.
for (const key of Object.keys(categories)) {
  let onScam = 0, onClean = 0;
  analysed.forEach((a, i) => {
    if (a.result.detected.includes(key)) (labels[i] ? onScam++ : onClean++);
  });
  const total = onScam + onClean;
  report.category_signal[categories[key].name] = {
    fired_on_scam: onScam, fired_on_non_scam: onClean,
    scam_share: +(total ? onScam / total : 0).toFixed(4),
    coverage_of_scam: +(onScam / report.label_balance.scam).toFixed(4)
  };
}

const missed = analysed.filter((a, i) => labels[i] && !primary[i]);
const falseAlarms = analysed.filter((a, i) => !labels[i] && primary[i]);
report.errors = {
  missed_scam_calls: missed.length,
  false_alarms: falseAlarms.length,
  missed_by_scenario: missed.reduce((acc, a) => { acc[a.row.type] = (acc[a.row.type] || 0) + 1; return acc; }, {}),
  false_alarms_by_scenario: falseAlarms.reduce((acc, a) => { acc[a.row.type] = (acc[a.row.type] || 0) + 1; return acc; }, {}),
  missed_examples: missed.slice(0, 8).map(a => ({
    id: a.row.id, type: a.row.type,
    detected: a.result.detected, actions: a.result.actionNames,
    first_caller_turn: a.row.turns.find(t => t.role === 'caller')?.text.slice(0, 190)
  })),
  false_alarm_examples: falseAlarms.slice(0, 8).map(a => ({
    id: a.row.id, type: a.row.type, state: a.result.state,
    detected: a.result.detected, actions: a.result.actionNames,
    phrases: a.result.evidence.slice(0, 3).map(e => e.phrase)
  }))
};

writeFileSync(path.join(app, 'models', 'rules_benchmark.json'), JSON.stringify(report, null, 2), 'utf8');

const p = report.operating_points['any concern'];
console.log(`\nOperating point "any concern"  n=${p.n}  acc ${(p.accuracy * 100).toFixed(1)}%  P ${p.precision}  R ${p.recall}  F1 ${p.f1}  FPR ${p.false_positive_rate}`);
const s = report.operating_points['strongly suspicious only'];
console.log(`Operating point "strong only"  acc ${(s.accuracy * 100).toFixed(1)}%  P ${s.precision}  R ${s.recall}  F1 ${s.f1}  FPR ${s.false_positive_rate}`);
const dv = report.split_discipline.development, hd = report.split_discipline.held_out;
console.log('\nEvaluation: reused-corpus diagnostic. Entire corpus inspected before and during tuning.');
console.log(`even-index partition  n=${dv.n}  acc ${(dv.accuracy * 100).toFixed(1)}%  P ${dv.precision}  R ${dv.recall}  F1 ${dv.f1}`);
console.log(`odd-index partition   n=${hd.n}  acc ${(hd.accuracy * 100).toFixed(1)}%  P ${hd.precision}  R ${hd.recall}  F1 ${hd.f1}  FPR ${hd.false_positive_rate}`);
console.log(`\ntopic shortcut: every family single-label = ${report.topic_shortcut_audit.every_family_is_single_label}`);
console.log(`\nmissed ${report.errors.missed_scam_calls} scam calls; ${report.errors.false_alarms} false alarms; ${report.throughput_ms_per_record} ms/record`);
console.log('\nby scenario (any concern):');
for (const [k, v] of Object.entries(report.by_scenario)) console.log(`  ${k.padEnd(12)} n=${String(v.n).padEnd(5)} acc ${(v.accuracy * 100).toFixed(1)}%  R ${v.recall}  FPR ${v.false_positive_rate}`);
console.log('\ncategory signal (share of firings that were on real scam calls):');
for (const [k, v] of Object.entries(report.category_signal)) console.log(`  ${k.padEnd(24)} scam ${String(v.fired_on_scam).padEnd(5)} clean ${String(v.fired_on_non_scam).padEnd(5)} share ${v.scam_share}`);
console.log('\nwritten: models/rules_benchmark.json');
