import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAegisServer, resolveRuntimeSettings } from '../server.mjs';
import { createReadiness, readableFile } from '../server-readiness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t, contents) {
  const workspace = path.join(root, 'test', `.runtime-config-${randomUUID()}`);
  await mkdir(path.join(workspace, 'work'), { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  if (contents !== undefined) await writeFile(path.join(workspace, 'work', 'runtime.json'), contents);
  return workspace;
}

test('missing optional runtime configuration preserves the faster-whisper defaults', async t => {
  const workspace = await fixture(t);
  assert.deepEqual(resolveRuntimeSettings({ workspace, env: {} }), {
    workspace, asrBackend: 'faster-whisper',
    python: path.join(workspace, 'work', 'asr-runtime', 'Scripts', 'python.exe'),
    speechModel: path.join(workspace, 'work', 'asr-model')
  });
});

test('persistent settings resolve relative paths from the workspace, not the launch directory', async t => {
  const workspace = await fixture(t, `\uFEFF${JSON.stringify({
    python: path.join('work', 'asr-runtime', 'Scripts', 'python.exe'),
    asrBackend: 'openai-whisper', speechModel: path.join('cache', 'medium.pt')
  })}`);
  const settings = resolveRuntimeSettings({ workspace, env: {} });
  assert.equal(settings.asrBackend, 'openai-whisper');
  assert.equal(settings.python, path.join(workspace, 'work', 'asr-runtime', 'Scripts', 'python.exe'));
  assert.equal(settings.speechModel, path.join(workspace, 'cache', 'medium.pt'));
  await writeFile(path.join(workspace, 'work', 'runtime.json'), JSON.stringify({
    python: settings.python, asrBackend: settings.asrBackend, speechModel: settings.speechModel
  }));
  assert.deepEqual(resolveRuntimeSettings({ workspace, env: {} }), settings, 'absolute paths stay unchanged');
});

test('environment overrides persisted settings and explicit server options override both', async t => {
  const workspace = await fixture(t, JSON.stringify({
    python: 'saved-python.exe', asrBackend: 'openai-whisper', speechModel: 'medium.pt'
  }));
  const env = {
    AEGIS_ASR_PYTHON: path.join('env-runtime', 'python.exe'),
    AEGIS_ASR_BACKEND: 'faster-whisper', AEGIS_ASR_MODEL: path.join('env-models', 'tiny.en')
  };
  const selected = resolveRuntimeSettings({ workspace, env });
  assert.equal(selected.python, path.join(workspace, 'env-runtime', 'python.exe'));
  assert.equal(selected.asrBackend, 'faster-whisper');
  assert.equal(selected.speechModel, path.join(workspace, 'env-models', 'tiny.en'));
  const explicit = resolveRuntimeSettings({
    workspace, env, python: path.join('test-runtime', 'python.exe'), asrBackend: 'openai-whisper', speechModel: 'large.pt',
    readiness: { python: 'ignored-python', asrBackend: 'faster-whisper', speechModel: 'ignored-model' }
  });
  assert.equal(explicit.python, path.join(workspace, 'test-runtime', 'python.exe'));
  assert.equal(explicit.asrBackend, 'openai-whisper');
  assert.equal(explicit.speechModel, path.join(workspace, 'large.pt'));
  const legacy = resolveRuntimeSettings({
    workspace, env, readiness: { python: 'mock-python', asrBackend: 'openai-whisper', speechModel: 'test.pt' }
  });
  assert.equal(legacy.python, 'mock-python');
  assert.equal(legacy.asrBackend, 'openai-whisper');
  assert.equal(legacy.speechModel, path.join(workspace, 'test.pt'));
  assert.equal(resolveRuntimeSettings({ workspace, env: { AEGIS_ASR_PYTHON: 'python' } }).python, 'python', 'bare interpreter command overrides still use PATH');
});

test('malformed and invalid runtime configuration surfaces at server creation', async t => {
  const workspace = await fixture(t);
  for (const contents of ['', '{', 'null', '[]', '42', '{"python":""}', '{"speechModel":" "}', '{"python":2}', '{"asrBackend":null}', '{"asrBackend":"unsupported"}']) {
    await writeFile(path.join(workspace, 'work', 'runtime.json'), contents);
    assert.throws(() => createAegisServer({ workspace, env: {} }), /runtime configuration|AEGIS_ASR_BACKEND/, contents);
  }
  await rm(path.join(workspace, 'work', 'runtime.json'));
  await mkdir(path.join(workspace, 'work', 'runtime.json'));
  assert.throws(() => resolveRuntimeSettings({ workspace, env: {} }), /Cannot read local runtime configuration/);
});

test('isolated options can bypass the local file and reject unsupported environment backends', async t => {
  const workspace = await fixture(t, '{invalid local configuration');
  const settings = resolveRuntimeSettings({ workspace, configPath: null, env: {} });
  assert.equal(settings.asrBackend, 'faster-whisper');
  assert.throws(() => createAegisServer({
    workspace, configPath: null, env: { AEGIS_ASR_BACKEND: 'unsupported' }
  }), /AEGIS_ASR_BACKEND/);
  const alternate = path.join('work', 'test-runtime.json');
  await writeFile(path.join(workspace, alternate), '{"asrBackend":"openai-whisper","speechModel":"medium.pt"}');
  assert.equal(resolveRuntimeSettings({ workspace, configPath: alternate, env: {} }).asrBackend, 'openai-whisper');
});

test('OpenAI readiness rejects empty and directory checkpoints without loading a model', async t => {
  const workspace = await fixture(t);
  const speechModel = path.join(workspace, 'medium.pt');
  const inspect = () => createReadiness({
    python: 'mock-python', root, speechModel, audioDirectory: workspace, asrBackend: 'openai-whisper',
    probe: async () => ({ runtime: true, imports: { asr: true }, reasons: { runtime: 'Mocked imports only.' } }),
    checkFile: file => file === speechModel ? readableFile(file) : true,
    checkAudio: async () => false
  })();
  await writeFile(speechModel, '');
  assert.equal((await inspect()).asr, false);
  await rm(speechModel);
  await mkdir(speechModel);
  assert.equal((await inspect()).asr, false);
  await rm(speechModel, { recursive: true });
  await writeFile(speechModel, 'nonempty fixture, not an actual model');
  const status = await inspect();
  assert.equal(status.asr, true);
  assert.equal(status.evaluationVerified, false);
  assert.match(status.reasons.asr, /model loading and live evaluation are not verified/);
});
