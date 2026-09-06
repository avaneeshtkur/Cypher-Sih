import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { probePython, createReadiness, readableFile } from '../server-readiness.mjs';
import { createAegisServer } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const working = () => ({
  runtime: true,
  imports: { asr: true, intent: true, replay: true },
  reasons: { runtime: 'Python test interpreter executed.', asr: 'Imports checked.', intent: 'Imports checked.', replay: 'Imports checked.' }
});
const settings = {
  python: 'test-python', root, speechModel: path.join(root, 'missing-test-model'),
  audioDirectory: path.join(root, 'missing-test-audio'),
  probe: async () => working(), checkFile: async () => true, checkAudio: async () => false
};
function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function capabilityFrom(script) {
  return JSON.parse(script.match(/^capability = (.+)$/m)[1]);
}

test('a bare missing Python command and a non-Python executable are not ready', async () => {
  for (const executable of ['aegis-python-does-not-exist-234807', process.execPath]) {
    const result = await probePython(executable, { timeoutMs: 1000 });
    assert.equal(result.runtime, false);
    assert.deepEqual(result.imports, { asr: false, intent: false, replay: false, deepfake: false, speaker: false });
    assert.ok(result.reasons.runtime);
  }
});

test('the bounded import probe distinguishes interpreter availability from missing dependencies', async () => {
  const resultPromise = probePython('python', {
    spawnProcess: (command, args, options) => {
      const child = fakeProcess();
      const capability = capabilityFrom(args.at(-1));
      assert.equal(command, 'python');
      assert.ok(!args.includes('-I'), 'probe must see the same user-installed packages as inference');
      assert.ok(args.includes('-B'));
      assert.match(args.at(-1), /import_module/);
      assert.doesNotMatch(args.at(-1), /WhisperModel\(/);
      assert.equal(options.env.HF_HUB_OFFLINE, '1');
      assert.equal(options.env.AEGIS_ASR_BACKEND, 'faster-whisper');
      assert.equal(options.env.OMP_NUM_THREADS, '2');
      queueMicrotask(() => {
        child.stdout.write('{"runtime":true,"version":"3.12"}\n');
        const failures = { intent: 'No module named joblib', replay: 'No module named av' };
        child.stdout.write(`${JSON.stringify({ capability, ok: !failures[capability], reason: failures[capability] || '' })}\n`);
        child.emit('close', 0);
      });
      return child;
    }
  });
  const result = await resultPromise;
  assert.equal(result.runtime, true);
  assert.equal(result.imports.asr, true);
  assert.equal(result.imports.intent, false);
  assert.match(result.reasons.intent, /joblib/);
  const status = await createReadiness({ ...settings, probe: async () => result })();
  assert.equal(status.intent, false, 'files alone cannot overcome a missing import');
  assert.equal(status.asr, true);
  assert.equal(status.evaluationVerified, false);
  assert.match(status.reasons.asr, /Prerequisites only/);
  assert.match(status.reasons.asr, /live evaluation are not verified/);
  assert.match(status.reasons.asr, /real-time performance are not measured/);
});

test('backend-specific probes check actual imports without loading checkpoints', async () => {
  for (const [asrBackend, modules] of [
    ['faster-whisper', ['numpy', 'av', 'faster_whisper', 'onnxruntime']],
    ['openai-whisper', ['numpy', 'av', 'torch', 'whisper']]
  ]) {
    for (const missing of modules) {
      const result = await probePython('mock-python', {
        asrBackend,
        env: { OMP_NUM_THREADS: '64', AEGIS_ASR_BACKEND: 'incorrect-inherited-backend' },
        spawnProcess: (command, args, options) => {
          const child = fakeProcess();
          const script = args.at(-1);
          const capability = capabilityFrom(script);
          const imports = JSON.parse(script.match(/^modules = (.+)$/m)[1]);
          if (capability === 'asr') assert.deepEqual(imports, modules);
          if (capability === 'replay') {
            assert.ok(imports.includes('av'));
            assert.ok(imports.includes('sklearn.svm'));
            assert.ok(!imports.some(name => ['faster_whisper', 'ctranslate2', 'torch', 'whisper', 'onnxruntime'].includes(name)));
          }
          if (['intent', 'replay'].includes(capability)) assert.ok(!imports.includes('torch'));
          assert.equal(options.env.AEGIS_ASR_BACKEND, asrBackend);
          for (const key of ['OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) assert.equal(options.env[key], '2');
          assert.equal(options.env.TRANSFORMERS_OFFLINE, '1');
          assert.doesNotMatch(script, /(?:load_model|WhisperModel)\(/);
          if (asrBackend === 'openai-whisper') {
            assert.match(script, /from whisper import load_model/);
            assert.match(script, /torch\.set_num_threads\(2\)/);
            assert.doesNotMatch(script, /faster_whisper|ctranslate2|onnxruntime/);
          } else {
            assert.match(script, /from faster_whisper import WhisperModel/);
            assert.doesNotMatch(script, /import torch(?:\r?\n|$)|from whisper import/);
          }
          queueMicrotask(() => {
            child.stdout.write('{"runtime":true,"version":"3.12"}\n');
            child.stdout.write(`${JSON.stringify({ capability, ok: !imports.includes(missing), reason: `No module named ${missing}` })}\n`);
            child.emit('close', 0);
          });
          return child;
        }
      });
      const status = await createReadiness({
        ...settings, asrBackend, speechModel: path.join(root, 'medium.pt'), probe: async () => result
      })();
      assert.equal(status.runtime, true);
      assert.equal(status.asr, false, `${asrBackend} must require ${missing}`);
      assert.ok(status.reasons.asr.includes(missing));
      assert.equal(status.replay, !['numpy', 'av'].includes(missing), 'replay does not need either ASR runtime');
    }
  }
});

test('unsupported backends fail before starting a dependency probe', () => {
  assert.throws(() => probePython('python', {
    asrBackend: 'unknown',
    spawnProcess: () => assert.fail('unsupported backend must not spawn Python')
  }), /AEGIS_ASR_BACKEND/);
  assert.throws(() => createReadiness({ ...settings, asrBackend: 'unknown' }), /AEGIS_ASR_BACKEND/);
});

test('a stalled dependency probe is killed and cannot claim unchecked capabilities', async () => {
  const children = [];
  const result = await probePython('python', {
    timeoutMs: 25,
    spawnProcess: () => {
      const child = fakeProcess();
      children.push(child);
      queueMicrotask(() => child.stdout.write('{"runtime":true,"version":"3.12"}\n'));
      return child;
    }
  });
  assert.equal(children.length, 5);
  assert.ok(children.every(child => child.killed));
  assert.equal(result.runtime, true);
  assert.equal(result.imports.asr, false);
  assert.match(result.reasons.asr, /timed out/);
});

test('the default dependency deadline allows a delayed cold Torch import', async () => {
  const children = new Map();
  const pending = probePython('mock-python', { asrBackend: 'openai-whisper', spawnProcess: (command, args) => {
    const child = fakeProcess();
    const capability = capabilityFrom(args.at(-1));
    children.set(capability, child);
    child.stdout.write('{"runtime":true,"version":"3.12"}\n');
    if (capability === 'asr') {
      setTimeout(() => {
        child.stdout.write('{"capability":"asr","ok":true}\n');
        child.emit('close', 0);
      }, 20);
    } else {
      child.stdout.write(`${JSON.stringify({ capability, ok: true })}\n`);
      queueMicrotask(() => child.emit('close', 0));
    }
    return child;
  } });
  const result = await pending;
  assert.ok([...children.values()].every(child => !child.killed));
  assert.equal(result.imports.asr, true);
});

test('probe output is bounded even when an executable emits excessive stderr', async () => {
  const children = [];
  const result = await probePython('python', {
    spawnProcess: () => {
      const child = fakeProcess();
      children.push(child);
      queueMicrotask(() => child.stderr.write('x'.repeat(65537)));
      return child;
    }
  });
  assert.ok(children.every(child => child.killed));
  assert.equal(result.runtime, false);
  assert.match(result.reasons.runtime, /output limit/);
});

test('capabilities are probed in sequential isolated processes without Torch and sklearn import crosstalk', async () => {
  const scripts = new Map();
  let active=0,maxActive=0;
  const result = await probePython('python', {
    asrBackend: 'openai-whisper',
    spawnProcess: (command, args) => {
      const child = fakeProcess();
      const script = args.at(-1), capability = capabilityFrom(script);
      scripts.set(capability, script);
      active++;maxActive=Math.max(maxActive,active);
      queueMicrotask(() => {
        child.stdout.write('{"runtime":true,"version":"3.12"}\n');
        child.stdout.write(`${JSON.stringify({ capability, ok: true })}\n`);
        active--;
        child.emit('close', 0);
      });
      return child;
    }
  });
  assert.equal(scripts.size, 5);
  assert.equal(maxActive,1,'heavy dependency probes must not compete for CPU and memory');
  for (const capability of ['intent', 'replay']) {
    assert.match(scripts.get(capability), /sklearn\.metrics/);
    assert.doesNotMatch(scripts.get(capability), /modules = .*torch/);
  }
  assert.match(scripts.get('asr'), /modules = .*torch/);
  assert.doesNotMatch(scripts.get('asr'), /sklearn\.metrics/);
  assert.ok(Object.values(result.imports).every(Boolean));
});

test('readiness requires readable assets, including offline ASR tokenizer files', async () => {
  const status = await createReadiness({
    ...settings, checkFile: async file => !['tokenizer.json', 'intent.joblib'].includes(path.basename(file))
  })();
  assert.equal(status.runtime, true);
  assert.equal(status.asr, false);
  assert.equal(status.intent, false);
  assert.equal(status.replay, true);
  assert.equal(status.datasetAudio, false);
  assert.match(status.reasons.asr, /tokenizer.json/);
  assert.match(status.reasons.intent, /intent.joblib/);
  assert.match(status.reasons.datasetAudio, /metadata and reports remain browsable/);
  assert.equal(await readableFile(root), false, 'directories are not usable model assets');
});

test('readiness accepts the actual Systran vocabulary.txt as well as JSON exports', async () => {
  for (const absent of ['vocabulary.json','vocabulary.txt']) {
    const status=await createReadiness({...settings,checkFile:async file=>path.basename(file)!==absent})();
    assert.equal(status.asr,true,`the alternative to ${absent} must be accepted`);
  }
  const missing=await createReadiness({...settings,checkFile:async file=>!path.basename(file).startsWith('vocabulary.')})();
  assert.equal(missing.asr,false);
  assert.match(missing.reasons.asr,/vocabulary\.txt or vocabulary\.json/);
});

test('both ASR backends and replay require the shared PyAV decoder', async () => {
  for (const asrBackend of ['faster-whisper', 'openai-whisper']) {
    const status = await createReadiness({
      ...settings, asrBackend, speechModel: path.join(root, asrBackend === 'openai-whisper' ? 'medium.pt' : 'asr-model'),
      checkFile: async file => path.basename(file) !== 'audio_io.py'
    })();
    assert.equal(status.asr, false);
    assert.equal(status.replay, false);
    assert.equal(status.intent, true);
    assert.match(status.reasons.asr, /audio_io\.py/);
    assert.match(status.reasons.replay, /audio_io\.py/);
  }

});

test('OpenAI readiness checks the configured checkpoint and PyAV decoder, not CTranslate2 assets', async () => {
  const checked = [];
  const speechModel = path.join(root, 'cached-models', 'medium.pt');
  const status = await createReadiness({
    ...settings, asrBackend: 'openai-whisper', speechModel,
    probe: async (python, options) => {
      assert.equal(python, settings.python);
      assert.equal(options.asrBackend, 'openai-whisper');
      return working();
    },
    checkFile: async file => { checked.push(file); return true; }
  })();
  assert.equal(status.asr, true);
  assert.equal(status.asrBackend, 'openai-whisper');
  assert.match(status.model, /medium\.pt/);
  assert.doesNotMatch(status.model, /tiny\.en/);
  assert.ok(checked.includes(speechModel));
  assert.ok(checked.includes(path.join(root, 'transcribe.py')));
  assert.ok(checked.includes(path.join(root, 'ml', 'audio_io.py')));
  assert.ok(!checked.some(file => file.startsWith(speechModel) && /model\.bin|config\.json|tokenizer\.json|vocabulary\./.test(file)));
  for (const absent of ['medium.pt', 'transcribe.py', 'audio_io.py']) {
    const missing = await createReadiness({
      ...settings, asrBackend: 'openai-whisper', speechModel,
      checkFile: async file => path.basename(file) !== absent
    })();
    assert.equal(missing.asr, false);
    assert.ok(missing.reasons.asr.includes(absent));
    assert.equal(missing.replay, absent !== 'audio_io.py');
  }
  for (const invalid of ['', undefined, 'medium', path.join(root, 'model.bin')]) {
    const missing = await createReadiness({ ...settings, asrBackend: 'openai-whisper', speechModel: invalid })();
    assert.equal(missing.asr, false, 'a model name or CTranslate2 directory cannot trigger a download');
    assert.match(missing.reasons.asr, /explicit local \.pt checkpoint/);
  }
});

test('missing scientific dependencies do not disable the independent OpenAI ASR capability', async () => {
  const runtime = working();
  runtime.imports.intent = runtime.imports.replay = false;
  runtime.reasons.intent = runtime.reasons.replay = 'Required imports failed: No module named threadpoolctl';
  const status = await createReadiness({
    ...settings, asrBackend: 'openai-whisper', speechModel: path.join(root, 'medium.pt'), probe: async () => runtime
  })();
  assert.equal(status.asr, true);
  assert.equal(status.intent, false);
  assert.equal(status.replay, false);
  assert.match(status.reasons.replay, /threadpoolctl/);
});

test('concurrent readiness calls share one probe and briefly cache the result', async () => {
  let probes = 0;
  const readiness = createReadiness({ ...settings, probe: async () => { probes++; return working(); } });
  const [first, second] = await Promise.all([readiness(), readiness()]);
  assert.equal(probes, 1);
  assert.equal(first, second);
  await readiness();
  assert.equal(probes, 1);
  const uncached = createReadiness({ ...settings, cacheMs: 0, probe: async () => { probes++; return working(); } });
  await uncached();
  await uncached();
  assert.equal(probes, 3);
});

async function withServer(t, options) {
  const server = createAegisServer({ configPath: null, env: {}, ...options });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

test('missing prerequisites return explicit 503 while reports, metadata, and demos remain usable', async t => {
  const base = await withServer(t, { readiness: { python: 'aegis-python-does-not-exist-234807' } });
  const statusResponse = await fetch(`${base}/api/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  for (const key of ['runtime', 'asr', 'intent', 'replay']) assert.equal(status[key], false);
  assert.equal(typeof status.datasetAudio, 'boolean');
  assert.equal(status.evaluationVerified, false);
  assert.equal(status.asrBackend, 'faster-whisper');
  for (const command of ['intent', 'replay', 'transcribe']) {
    const response = await fetch(`${base}/api/${command}`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
    const error = await response.json();
    assert.equal(error.available, false);
    assert.ok(error.error);
  }
  const reports = await (await fetch(`${base}/api/reports`)).json();
  assert.equal(reports.rules.evaluation_kind, 'reused-corpus diagnostic');
  const rows = await (await fetch(`${base}/api/dataset/text?limit=2&offset=1&label=1&errors=1`)).json();
  assert.equal(rows.offset, 1);
  assert.ok(rows.rows.length <= 2);
  for (const row of rows.rows) { assert.equal(row.label, 1); assert.notEqual(row.label, row.prediction); }
  const audio = await (await fetch(`${base}/api/dataset/audio?limit=1`)).json();
  assert.equal(audio.rows.length, 1);
  assert.equal(typeof audio.rows[0].audioAvailable, 'boolean');
  if (!audio.rows[0].audioAvailable) {
    const missing = await fetch(`${base}/api/dataset/audio/${encodeURIComponent(audio.rows[0].id)}`);
    assert.equal(missing.status, 503);
    assert.match((await missing.json()).error, /metadata/);
  }
  assert.equal((await fetch(`${base}/api/dataset/audio/unknown-record`)).status, 404);
  const manifest = await fetch(`${base}/api/demos`);
  assert.equal(manifest.status, 200);
  assert.deepEqual(await manifest.json(), JSON.parse((await readFile(path.join(root, 'demo-audio', 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')));
  assert.equal((await fetch(`${base}/api/demos`, { method: 'POST' })).status, 404);
  for (const name of ['workspace.js', 'demo-session.mjs', 'decision.mjs', 'demos.js']) {
    const response = await fetch(`${base}/${name}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
  }
  assert.equal((await fetch(`${base}/server-readiness.mjs`)).status, 404, 'server-only helpers stay private');
});

test('inference refuses missing model assets even with a working interpreter and imports', async t => {
  const base = await withServer(t, {
    readiness: { ...settings, checkFile: async file => !file.endsWith('intent.joblib') }
  });
  const response = await fetch(`${base}/api/intent`, { method: 'POST', body: '{"turns":[]}' });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /intent.joblib/);
});

test('existing method, origin, and empty-body errors remain intact on an ephemeral port', async t => {
  const base = await withServer(t, { readiness: settings });
  assert.equal((await fetch(`${base}/api/intent`)).status, 404);
  assert.equal((await fetch(`${base}/api/intent`, { method: 'POST', headers: { Origin: 'https://example.invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/intent`, { method: 'POST', headers: { Origin: base } })).status, 400);
  assert.equal((await fetch(`${base}/models/intent.joblib`)).status, 404);
});

for (const asrBackend of ['faster-whisper', 'openai-whisper']) {
test(`transcribe preserves raw audio and selected ${asrBackend} settings`, async t => {
  const speechModel = path.join(root, 'cached-models', asrBackend === 'openai-whisper' ? 'medium.pt' : 'asr-model');
  const python = path.join(root, 'mock-runtime', 'python.exe');
  const payload = Buffer.from([0, 255, 10, 13, 42, 80]);
  const transcript = { text: 'Local transcript.', segments: [], model: 'medium' };
  let runs = 0;
  const base = await withServer(t, {
    python, speechModel, asrBackend,
    verifyModels: async () => ({
      verified: true, errors: [],
      results: { asr: { ok: true, capability: 'asr', filename: path.basename(speechModel) } }
    }),
    env: { AEGIS_ASR_BACKEND: 'faster-whisper', HF_HUB_OFFLINE: '0', OMP_NUM_THREADS: '128' },
    readiness: {
      ...settings,
      probe: async (command, options) => {
        assert.equal(command, python);
        assert.equal(options.asrBackend, asrBackend);
        assert.equal(options.env.AEGIS_ASR_BACKEND, asrBackend);
        return working();
      }
    },
    spawnProcess: (command, args, options) => {
      runs++;
      assert.equal(command, python);
      assert.deepEqual(args, [path.join(root, 'transcribe.py'), speechModel]);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
      assert.equal(options.env.AEGIS_ASR_BACKEND, asrBackend);
      for (const key of ['HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_DATASETS_OFFLINE']) assert.equal(options.env[key], '1');
      for (const key of ['AEGIS_CPU_THREADS', 'OMP_NUM_THREADS', 'OMP_THREAD_LIMIT', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) assert.equal(options.env[key], '2');
      const child = fakeProcess();
      const chunks = [];
      child.stdin.on('data', chunk => chunks.push(chunk));
      child.stdin.on('finish', () => {
        assert.deepEqual(Buffer.concat(chunks), payload);
        child.stdout.write(JSON.stringify(transcript));
        child.emit('close', 0);
      });
      return child;
    }
  });
  const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.asrBackend, asrBackend);
  assert.ok(status.model.includes(path.basename(speechModel)));
  assert.doesNotMatch(status.model, /tiny\.en/);
  const response = await fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: payload });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), transcript);
  assert.equal(runs, 1);
});
}

test('aborting an inference request kills the child and immediately releases the command slot',async t=>{
  const children=[];
  const base=await withServer(t,{
    readiness:{...settings},
    spawnProcess:()=>{
      const child=fakeProcess();children.push(child);
      if(children.length===2)child.stdin.on('finish',()=>{
        child.stdout.write(JSON.stringify({text:'retry succeeded',segments:[]}));
        child.emit('close',0);
      });
      return child;
    }
  });
  const controller=new AbortController();
  const pending=fetch(`${base}/api/transcribe`,{method:'POST',body:Buffer.from([1,2,3]),signal:controller.signal});
  while(children.length<1)await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending,error=>error.name==='AbortError');
  while(!children[0].killed)await new Promise(resolve=>setImmediate(resolve));
  const retry=await fetch(`${base}/api/transcribe`,{method:'POST',body:Buffer.from([4,5,6])});
  assert.equal(retry.status,200);
  assert.equal((await retry.json()).text,'retry succeeded');
  assert.equal(children.length,2);
});
