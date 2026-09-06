import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAsrTurns, createDemoCues, DemoSession, DEMO_SOURCE, evidenceUpdate, nextAction } from '../demo-session.mjs';
import { buildTrace } from '../reasoning.mjs';
import { analyze } from '../engine.mjs';

const manifest=JSON.parse(readFileSync(new URL('../demo-audio/manifest.json',import.meta.url),'utf8').replace(/^\uFEFF/,''));
const script=manifest.scripts['payment-pressure'];
const cues=createDemoCues(script,24);

test('demo script cues are explicitly authored, approximate and bounded by media duration',()=>{
  assert.equal(cues[0].start,0);
  assert.equal(cues.at(-1).end,24);
  assert.equal(cues.map(c=>c.text).join(' '),script);
  for(const [i,cue] of cues.entries()){
    assert.equal(cue.transcriptSource,DEMO_SOURCE);
    assert.match(cue.timing,/estimated/);
    assert.ok(cue.end>cue.start);
    if(i)assert.equal(cue.start,cues[i-1].end);
  }
});
test('no future words or assessment exist before the first phrase completes',()=>{
  const session=new DemoSession('payment-pressure',cues);
  const start=session.at(cues[0].end-.01);
  assert.equal(start.entries.length,0);
  assert.equal(start.events.length,0);
  assert.equal(start.assessment,null);
});
test('each arriving phrase runs the actual engine on only the available prefix',()=>{
  const session=new DemoSession('payment-pressure',cues);
  for(let i=0;i<cues.length;i++){
    const state=session.at(cues[i].end);
    const expected=analyze(cues.slice(0,i+1).map(c=>({role:c.role,text:c.text})));
    assert.deepEqual(state.assessment,expected);
    assert.equal(state.events.length,i+1);
    assert.ok(state.events.every(e=>e.at<=state.position));
  }
});
test('ASR boundaries cannot split a fraud phrase or repeat earlier evidence',()=>{
  const entries=[
    {end:5,text:'We would like to inform you that there is an order placed for Apple iPhone 11 Pro using',kind:'speech',transcriptSource:'local-asr'},
    {end:6.6,text:'your Amazon account.',kind:'speech',transcriptSource:'local-asr'},
    {end:11.4,text:'If you do not authorize this order, press 1 or press 2 to authorize this order.',kind:'speech',transcriptSource:'local-asr'}
  ];
  const prefix=[],events=[];
  let previousAssessment=null;
  for(const entry of entries){
    prefix.push(entry);
    const turns=buildAsrTurns(prefix);
    const event=evidenceUpdate(turns,entry,previousAssessment?.state??null,previousAssessment);
    events.push(event);previousAssessment=event.assessment;
  }
  assert.equal(events.at(-1).assessment.state,'Needs verification');
  assert.ok(events[1].evidence.some(item=>item.category==='threat'));
  assert.equal(events[2].evidence.some(item=>item.category==='threat'),false);
  assert.deepEqual(buildAsrTurns([entries[0],{kind:'gap',end:5.5,text:'unprocessed'},entries[1]]).map(turn=>turn.text),[entries[0].text,entries[1].text]);
});
test('rewinding removes later transcript, warnings and events',()=>{
  const session=new DemoSession('payment-pressure',cues);
  assert.equal(session.at(24).assessment.state,'Strongly suspicious');
  const first=session.at(cues[0].end);
  assert.equal(first.entries.length,1);
  assert.equal(first.events.length,1);
  assert.notEqual(first.assessment.state,'Strongly suspicious');
  assert.equal(session.at(0).assessment,null);
});
test('repeated pause updates do not duplicate events',()=>{
  const session=new DemoSession('payment-pressure',cues);
  const a=session.at(cues[2].end);
  assert.deepEqual(session.at(cues[2].end),a);
});
test('export snapshots do not expose mutable session data',()=>{
  const session=new DemoSession('payment-pressure',cues);
  const report=session.at(24);report.entries[0].text='modified';report.events.length=0;
  assert.notEqual(session.snapshot().entries[0].text,'modified');
  assert.equal(session.snapshot().events.length,cues.length);
});
test('every stored scenario is analysed from its script, not hardcoded outcomes',()=>{
  for(const [name,text] of Object.entries(manifest.scripts)){
    const all=new DemoSession(name,createDemoCues(text,30)).at(30);
    assert.equal(all.assessment.state,analyze([{role:'caller',text}]).state);
  }
  const safe=new DemoSession('safe',createDemoCues(manifest.scripts['legitimate-payment'],30)).at(30);
  assert.equal(safe.assessment.state,'No concerning combination');
});
test('empty or invalid cues and playback times fail visibly',()=>{
  assert.throws(()=>createDemoCues('',20),/script/);
  assert.throws(()=>createDemoCues(script,NaN),/duration/);
  assert.throws(()=>new DemoSession('bad',[]),/Invalid/);
  assert.throws(()=>new DemoSession('valid',cues).at(-1),/position/);
});
test('guidance blocks credential disclosure but never calls a clean result safe',()=>{
  assert.match(nextAction(analyze([{role:'caller',text:'Please share your OTP.'}])),/Do not share/);
  assert.match(nextAction(analyze([{role:'caller',text:'Hello.'}])),/not a safe-call/);
});
test('authored transcript explanations never claim ASR was run',()=>{
  const result=analyze([{role:'caller',text:script}]);
  const steps=buildTrace(result,{transcript:script,transcriptSource:DEMO_SOURCE});
  const text=steps.find(s=>s.stage==='transcribe');
  assert.equal(text.title,'Supplied demo transcript');
  assert.match(text.detail,/not speech recognition/);
});
test('explanation is deterministic and explains single OTP warnings correctly',()=>{
  const result=analyze([{role:'caller',text:'Please share your OTP.'}]);
  assert.deepEqual(buildTrace(result),buildTrace(result));
  assert.doesNotMatch(buildTrace(result).find(s=>s.stage==='fusion').detail,/single cue never/i);
});
