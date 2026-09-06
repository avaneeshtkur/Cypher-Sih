import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyze } from '../engine.mjs';
import { directDecision } from '../decision.mjs';

const [rows,report]=await Promise.all([
  readFile(new URL('../models/text_examples.json',import.meta.url),'utf8').then(JSON.parse),
  readFile(new URL('../models/text_report.json',import.meta.url),'utf8').then(JSON.parse)
]);

test('saved evaluation records exercise all four call-content risk levels',()=>{
  const counts={low:0,caution:0,suspicious:0,high:0};
  for(const row of rows){
    const risk_band=row.model_score>=report.high_risk_threshold?'high-risk':row.model_score<=report.low_risk_threshold?'low-risk':'elevated-risk';
    const decision=directDecision(analyze(row.turns),{usable:true,score:row.model_score,risk_band});
    if(Object.hasOwn(counts,decision.level))counts[decision.level]++;
  }
  assert.equal(Object.values(counts).reduce((sum,value)=>sum+value,0),rows.length);
  for(const [level,value] of Object.entries(counts))assert.ok(value>0,`${level} has no evaluation examples`);
});