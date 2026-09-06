import { readFile } from 'node:fs/promises';
import { analyze } from '../engine.mjs';
import { directDecision } from '../decision.mjs';

const root = new URL('../', import.meta.url);
const [rows, report] = await Promise.all([
  readFile(new URL('models/text_examples.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('models/text_report.json', root), 'utf8').then(JSON.parse)
]);

const increment = (target, key) => { target[key] = (target[key] ?? 0) + 1; };
const stateCounts = {}, bandCounts = {}, levelCounts = {}, cross = {};
const examples = {};

for (const row of rows) {
  const rules = analyze(row.turns);
  const riskBand = row.model_score >= report.high_risk_threshold ? 'high-risk'
    : row.model_score <= report.low_risk_threshold ? 'low-risk' : 'elevated-risk';
  const decision = directDecision(rules, { usable: true, score: row.model_score, risk_band: riskBand });
  const crossKey = `${rules.state} | ${riskBand}`;
  increment(stateCounts, rules.state);
  increment(bandCounts, riskBand);
  increment(levelCounts, decision.level);
  increment(cross, crossKey);
  examples[decision.level] ??= [];
  if (examples[decision.level].length < 2) examples[decision.level].push({
    id: row.id, source: row.source, evaluationSplit: row.evaluation_split,
    score: row.model_score, riskBand, ruleState: rules.state, label: decision.label
  });
}

const result = {
  records: rows.length,
  thresholds: { low: report.low_risk_threshold, binary: report.threshold, high: report.high_risk_threshold },
  stateCounts, bandCounts, levelCounts, cross, examples
};

const origin = process.argv[2];
if (origin) {
  result.live = {};
  for (const expected of ['low', 'caution', 'suspicious', 'high']) {
    const selected = rows.find(row => row.id === examples[expected]?.[0]?.id);
    if (!selected) throw new Error(`No ${expected} representative is available.`);
    const response = await fetch(`${origin.replace(/\/$/, '')}/api/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turns: selected.turns })
    });
    const model = await response.json();
    if (!response.ok) throw new Error(`${expected} live inference failed: ${model.error ?? response.status}`);
    const rules = analyze(selected.turns), liveDecision = directDecision(rules, model);
    if (liveDecision.level !== expected) throw new Error(`${selected.id}: expected ${expected}, received ${liveDecision.level}.`);
    result.live[expected] = {
      id: selected.id, score: model.score, riskBand: model.risk_band,
      ruleState: rules.state, level: liveDecision.level, rank: liveDecision.rank, label: liveDecision.label
    };
  }
}

console.log(JSON.stringify(result, null, 2));