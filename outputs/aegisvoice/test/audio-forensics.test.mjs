import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createAegisServer } from '../server.mjs';

const readiness = {python: 'mock-python', root: process.cwd(), speechModel: 'mock-model', audioDirectory: 'missing-audio', checkFile: async () => true, checkAudio: async () => false, probe: async () => ({runtime: true, imports: {asr: false, intent: true, replay: true, deepfake: true, speaker: true}, reasons: {}})};
const result = (pella, aasist) => ({detectors: {pella, aasist}, disagreement: false, status: 'No synthetic/spoof agreement'});
function child(output) {
  const process = new EventEmitter(); process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.kill = () => {};
  process.stdin.on('finish', () => { process.stdout.write(JSON.stringify(output)); process.emit('close', 0); }); return process;
}
async function serverFor(t, output) {
  const server = createAegisServer({configPath: null, env: {}, readiness, verifyModels: async () => ({verified: true, errors: [], results: {deepfake: {ok: true, capability: 'deepfake'}}}), spawnProcess: () => child(output)});
  t.after(() => new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); })); server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`;
}

test('same waveform keeps anti-spoof evidence unchanged while transcript context changes', async t => {
  const base = await serverFor(t, result({available: true, score: 0.8, label: 'synthetic-like'}, {available: true, score: 0.2, label: 'spoof-like'}));
  const audio = Buffer.alloc(16000, 7); const request = transcript => fetch(`${base}/api/diagnostic`, {method: 'POST', headers: {'X-Context-Transcript': transcript}, body: audio});
  const first = await (await request('Please verify the account through the usual process.')).json(); const second = await (await request('Transfer the money now and read out the OTP.')).json();
  assert.deepEqual(first.detectors, second.detectors); assert.notDeepEqual(first.contextRisk, second.contextRisk); assert.equal(first.transcriptUsedByDetectors, false);
});

test('ASR unavailable does not block diagnostic Pella/AASIST processing', async t => {
  const base = await serverFor(t, result({available: true, score: 0.1}, {available: true, score: 0.1})); const status = await (await fetch(`${base}/api/status`)).json();
  assert.equal(status.asr, false); const response = await fetch(`${base}/api/diagnostic`, {method: 'POST', body: Buffer.alloc(16000)}); assert.equal(response.status, 200); assert.equal((await response.json()).detectors.pella.available, true);
});

test('failed detectors are explicitly unavailable and carry no fabricated score', async t => {
  const base = await serverFor(t, result({available: false, status: 'UNAVAILABLE', error: 'Pella failed'}, {available: false, status: 'UNAVAILABLE', error: 'AASIST failed'})); const response = await fetch(`${base}/api/diagnostic`, {method: 'POST', body: Buffer.alloc(16000)}); const body = await response.json();
  assert.equal(response.status, 200); for (const detector of Object.values(body.detectors)) { assert.equal(detector.status, 'UNAVAILABLE'); assert.equal('score' in detector, false); }
});