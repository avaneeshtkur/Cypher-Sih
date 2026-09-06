// Real integration check, not a fraud benchmark. Only WAV bytes are sent to ASR.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { analyze } from '../engine.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const origin=process.env.AEGIS_TEST_URL||'http://127.0.0.1:4173';
const status=await (await fetch(`${origin}/api/status`)).json();
assert.equal(status.asr,true,'Actual local ASR prerequisites are not ready.');
const records=[];
for(const [filename,expected] of [['digital-arrest','Strongly suspicious'],['legitimate-payment','No concerning combination']]){
  const audio=await readFile(path.join(root,'demo-audio',`${filename}.wav`));
  const started=performance.now();
  const response=await fetch(`${origin}/api/transcribe`,{method:'POST',headers:{'Content-Type':'audio/wav'},body:audio});
  const result=await response.json();
  assert.equal(response.status,200,JSON.stringify(result));
  assert.equal(result.transcriptSource,'local-asr');
  assert.ok(result.text.trim(),'ASR must return recognized words.');
  const assessment=analyze([{role:'caller',text:result.text}]);
  assert.equal(assessment.state,expected);
  records.push({
    filename:`${filename}.wav`,sha256:createHash('sha256').update(audio).digest('hex'),
    submitted:'WAV bytes only; no scenario text or expected phrase',transcript:result.text,
    segments:result.segments,backend:result.backend,model:result.model,
    audio_seconds:result.duration,inference_ms:result.inference_ms,wall_ms:Math.round(performance.now()-started),
    assessment
  });
  console.log(`${filename}: ${result.duration.toFixed(1)}s audio -> ${(result.inference_ms/1000).toFixed(1)}s inference -> ${assessment.state}`);
}
const report={
  checked_at:new Date().toISOString(),type:'actual local integration check',
  limitations:['Two authored TTS demos, not independent real-call evaluation.','No claim of real-time throughput or voice authenticity.','The intent check uses explicit text rules, not the unavailable scikit-learn model.'],
  records
};
const directory=path.resolve(root,'..','..','work');
await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,'local_asr_validation.json'),JSON.stringify(report,null,2));
console.log('Saved work\\local_asr_validation.json. No model or dataset was downloaded.');
