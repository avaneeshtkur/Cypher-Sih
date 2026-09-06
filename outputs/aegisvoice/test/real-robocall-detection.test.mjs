import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { analyze } from '../engine.mjs';
import { buildAsrTurns } from '../demo-session.mjs';

const manifest=JSON.parse(await readFile(new URL('../database-audio/manifest.json',import.meta.url),'utf8'));
const calls=manifest.samples.filter(sample=>sample.id.startsWith('ncsu-'));
const synthetic=manifest.samples.filter(sample=>sample.id.startsWith('mendeley-fake-'));

test('all bundled real-world malicious robocall transcripts trigger verification',()=>{
  assert.equal(calls.length,6);
  for(const call of calls){
    const result=analyze([{role:'caller',text:call.publisherTranscript}]);
    assert.notEqual(result.state,'No concerning combination',`${call.id} was missed`);
    assert.ok(result.actionNames.includes('Call routing / callback')||result.detected.length>=2,`${call.id} has no actionable evidence`);
  }
});

test('ASR segment boundaries cannot hide any bundled robocall warning',()=>{
  for(const call of calls){
    const entries=call.publisherTranscript.trim().split(/\s+/).map((text,index)=>({
      end:index+1,text,kind:'speech',transcriptSource:'local-asr'
    }));
    const result=analyze(buildAsrTurns(entries));
    assert.notEqual(result.state,'No concerning combination',`${call.id} was missed after ASR segmentation`);
  }
});

test('robocall rules expose the specific real-call behaviors',()=>{
  const results=Object.fromEntries(calls.map(call=>[call.id,analyze([{role:'caller',text:call.publisherTranscript}])]));
  assert.ok(results['ncsu-1'].actionNames.includes('Call routing / callback'));
  assert.ok(results['ncsu-2'].detected.includes('reward'));
  assert.ok(results['ncsu-3'].detected.includes('threat'));
  assert.ok(results['ncsu-4'].detected.includes('urgency'));
  assert.ok(results['ncsu-5'].detected.includes('threat'));
  assert.ok(results['ncsu-6'].actionNames.includes('Payment'));
  assert.ok(results['ncsu-6'].actionNames.includes('Call routing / callback'));
});

test('ordinary opt-in support navigation is not classified as strongly suspicious',()=>{
  const result=analyze([{role:'caller',text:'Thank you for calling our published support number. Press 1 for account support or stay on the line.'}]);
  assert.equal(result.state,'No concerning combination');
});

test('Mendeley synthetic showcase is waveform-backed and generator/type/gender stratified',async()=>{
  assert.equal(synthetic.length,8);
  const combinations=new Set(synthetic.map(row=>`${row.generator}/${row.generationType}/${row.gender}`));
  assert.equal(combinations.size,8);
  for(const row of synthetic){
    assert.equal(row.voiceOrigin,'Synthetic/deepfake (publisher label)');
    assert.match(row.fraudContext,/No fraud label/);
    assert.equal(row.license,'CC BY 4.0');
    const bytes=await readFile(new URL(`../database-audio/${row.file}`,import.meta.url));
    assert.equal(bytes.length,row.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256);
  }
});
