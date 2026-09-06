import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app=new URL('../',import.meta.url);
const read=name=>readFile(new URL(name,app),'utf8');

test('setup scripts reuse the existing runtime and never create another environment',async()=>{
  for(const name of ['Setup speech.ps1','Setup datasets.ps1']){
    const source=await read(name);
    assert.match(source,/work\\asr-runtime/);
    assert.doesNotMatch(source,/work\\model-runtime/);
    assert.doesNotMatch(source,/python -m venv/);
    assert.match(source,/will not create a second virtual environment/);
  }
});

test('modern dependency pins keep Torch and torchaudio compatible',async()=>{
  const source=await read('ml/requirements-modern.txt');
  const torch=source.match(/^torch==([^\r\n]+)/m)?.[1];
  const audio=source.match(/^torchaudio==([^\r\n]+)/m)?.[1];
  assert.equal(torch,audio);
  assert.equal(torch,'2.10.0');
  assert.match(source,/^huggingface-hub==/m);
  assert.match(source,/^av==16\.1\.0$/m);
});

test('model installer retries downloads, verifies complete assets, and preserves the selected backend',async()=>{
  const source=await read('ml/install_modern_models.py');
  assert.match(source,/def retry\(/);
  assert.match(source,/def require_file\(/);
  assert.match(source,/runtime\.setdefault\("asrBackend", "faster-whisper"\)/);
  assert.match(source,/work\\\\asr-runtime/);
  assert.ok(source.indexOf('require(MODELS / "faster-whisper-tiny.en"')<source.indexOf('runtime_path.write_text'));
});