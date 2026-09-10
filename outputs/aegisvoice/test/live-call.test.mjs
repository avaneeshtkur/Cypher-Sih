import test from 'node:test';
import assert from 'node:assert/strict';
import { initLiveCall } from '../live-call.js';
import { analyze } from '../engine.mjs';

// These fixtures test browser/API wiring with synthetic PCM and mocked responses.
// No microphone, recognizer, trained classifier, or real audio service runs here.
const RATE = 16000;
const TRANSCRIPT = 'This is the chief financial officer. Transfer the money immediately. Skip the usual approval. Do not call me back. Keep this between us.';
const capabilities = { runtime: true, asr: true, intent: false, replay: false };
const reply = (text = TRANSCRIPT) => ({ ok: true, json: async () => ({ text, segments: [{ start: 0, end: 4, text }], model: 'mock-asr-fixture' }) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate, description) {
  for (let i = 0; i < 30; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`Fixture did not settle: ${description}`);
}

function fixture(t, respond = async () => reply()) {
  const elements = new Map([
    'live-share', 'live-mic', 'live-stop', 'live-clear', 'live-status',
    'live-latency', 'live-level', 'live-capability',
    'pipeline-analysis', 'pipeline-input', 'pipeline-text'
  ].map(id => [id, { textContent: '', disabled: false, value: 0 }]));
  const calls = [], frames = [], contexts = [], worklets = [], streams = [];
  const permissions = { microphone: [], display: [] };
  class Track {
    stopped = false;
    listeners = new Map();
    stop() { this.stopped = true; }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
  }
  class Stream {
    constructor(tracks = [new Track()]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  }
  class AudioNode {
    connections = [];
    disconnected = false;
    connect(destination) { this.connections.push(destination); }
    disconnect() { this.disconnected = true; }
  }
  class Context {
    sampleRate = RATE;
    state = 'suspended';
    destination = new AudioNode();
    modules = [];
    audioWorklet = { addModule: async url => { this.modules.push(url); } };
    constructor() { contexts.push(this); }
    createMediaStreamSource(stream) { const node = new AudioNode(); node.stream = stream; return node; }
    createGain() { const node = new AudioNode(); node.gain = { value: 1 }; return node; }
    async resume() { this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  class Worklet extends AudioNode {
    constructor(context, name) {
      super();
      this.context = context;
      this.name = name;
      this.port = {
        onmessage: null,
        postMessage: message => {
          if (message === 'flush') queueMicrotask(() => this.port.onmessage?.({ data: { flushed: true } }));
        }
      };
      worklets.push(this);
    }
  }
  const replacements = {
    document: { getElementById: id => {
      assert.ok(elements.has(id), `Unstubbed live-call element: ${id}`);
      return elements.get(id);
    } },
    window: { addEventListener() {} },
    navigator: { mediaDevices: {
      getUserMedia: async options => {
        permissions.microphone.push(options);
        const stream = new Stream(); streams.push(stream); return stream;
      },
      getDisplayMedia: async options => {
        permissions.display.push(options);
        const stream = new Stream(); streams.push(stream); return stream;
      }
    } },
    AudioContext: Context,
    AudioWorkletNode: Worklet,
    MediaStream: Stream,
    fetch: async (url, options) => {
      const call = { url, ...options };
      calls.push(call);
      return respond(call, calls.length);
    }
  };
  const original = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  let live;
  t.after(async () => {
    try { await live?.reset(); }
    finally {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    }
  });
  live = initLiveCall((assessment, context, snapshot) => {
    frames.push(structuredClone({ assessment, context, snapshot }));
  });
  const get = id => elements.get(id);
  function pcm(samples) {
    const onmessage = worklets.at(-1)?.port.onmessage;
    assert.equal(typeof onmessage, 'function', 'capture worklet must be connected');
    onmessage({ data: { pcm: samples } });
  }
  function segment() {
    const speech = new Float32Array(RATE * 4).fill(0.25);
    speech[0] = -0.5;
    pcm(speech);
    pcm(new Float32Array(RATE / 2));
  }
  return { live, get, calls, frames, contexts, worklets, streams, permissions, pcm, segment };
}

test('mocked ASR path encodes captured PCM and evaluates the returned transcript with the actual rules', async t => {
  const f = fixture(t);
  f.live.setCapabilities(capabilities);
  await f.get('live-mic').onclick();
  assert.equal(f.permissions.microphone.length, 1);
  assert.deepEqual(f.permissions.microphone[0], { audio: { echoCancellation: false, noiseSuppression: false }, video: false });
  assert.deepEqual(f.contexts[0].modules, ['/pcm-worklet.js']);
  assert.equal(f.worklets[0].name, 'capture-pcm');
  assert.equal(f.get('pipeline-text').textContent, 'Optional local ASR');
  f.segment();
  await until(() => f.live.snapshot()?.events.length === 1, 'ASR transcript analysis and evidence event');

  assert.equal(f.calls.length, 1);
  const request = f.calls[0];
  assert.equal(request.url, '/api/transcribe');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Type'], 'audio/wav');
  assert.ok(request.signal instanceof AbortSignal);
  assert.ok(request.body instanceof ArrayBuffer);
  const bytes = new DataView(request.body);
  assert.equal(new TextDecoder().decode(new Uint8Array(request.body, 0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(new Uint8Array(request.body, 8, 4)), 'WAVE');
  assert.equal(bytes.getUint16(20, true), 1, 'uncompressed PCM format');
  assert.equal(bytes.getUint16(22, true), 1, 'mono audio');
  assert.equal(bytes.getUint32(24, true), RATE);
  assert.equal(bytes.getUint16(34, true), 16);
  assert.equal(bytes.getUint32(40, true), RATE * 4.5 * 2);
  assert.equal(request.body.byteLength, 44 + RATE * 4.5 * 2);
  assert.equal(bytes.getInt16(44, true), -16384);
  assert.equal(bytes.getInt16(46, true), 8191);
  assert.equal(bytes.getInt16(44 + RATE * 4 * 2, true), 0, 'captured silence is encoded, not replaced with a demo script');

  const snapshot = f.live.snapshot();
  const expected = analyze([{ role: 'caller', text: TRANSCRIPT }]);
  assert.notEqual(expected.state, 'No concerning combination', 'fixture must exercise an actual warning');
  assert.deepEqual(snapshot.assessment, expected);
  assert.equal(snapshot.mode, 'live-asr');
  assert.equal(snapshot.gaps, 0);
  assert.equal(snapshot.entries[0].transcriptSource, 'local-asr');
  assert.equal(snapshot.entries[0].asr.model, 'mock-asr-fixture');
  assert.equal(snapshot.entries[0].start, 0);
  assert.equal(snapshot.entries[0].end, 4.5);
  assert.equal(snapshot.events[0].transcriptSource, 'local-asr');
  assert.equal(snapshot.events[0].text, TRANSCRIPT);
  assert.deepEqual(snapshot.events[0].assessment, expected);
  assert.ok(snapshot.events[0].evidence.length > 0);
  const callback = f.frames.findLast(frame => frame.snapshot?.events.length);
  assert.equal(callback.snapshot.entries[0].transcriptSource, 'local-asr', 'onReason third argument carries provenance');
  assert.deepEqual(callback.snapshot.events, snapshot.events, 'onReason third argument carries evidence events');
  assert.ok(f.frames.some(frame => frame.context.transcript === TRANSCRIPT));
  assert.equal(f.get('pipeline-analysis').textContent, 'Text rules evaluated');
});

test('unavailable ASR does not prevent anti-spoof microphone capture when deepfake models are ready', async t => {
  const f = fixture(t);
  for (const readiness of [null, { runtime: true, asr: false, deepfake: true, intent: true, reasons: { asr: 'ASR dependencies unavailable in fixture' } }]) {
    f.live.setCapabilities(readiness);
    if (!readiness) {
      assert.equal(f.get('live-mic').disabled, true);
      assert.equal(f.get('live-share').disabled, true);
      await f.get('live-mic').onclick();
      assert.equal(f.live.snapshot(), null);
    } else {
      assert.equal(f.get('live-mic').disabled, false);
      assert.equal(f.get('live-share').disabled, false);
    }
  }
  assert.equal(f.permissions.microphone.length, 0);
  assert.equal(f.permissions.display.length, 0);
  assert.match(f.get('live-status').textContent, /Pella\/AASIST|ASR dependencies unavailable/);
});

test('slow OpenAI batch backend is not exposed as continuous live capture', async t => {
  const f=fixture(t);
  f.live.setCapabilities({runtime:true,asr:true,asrBackend:'openai-whisper',model:'medium.pt'});
  assert.equal(f.get('live-mic').disabled,true);
  assert.equal(f.get('live-share').disabled,true);
  assert.match(f.get('live-capability').textContent,/batch ASR|continuous capture is disabled|Pella\/AASIST unavailable/i);
  await f.get('live-mic').onclick();
  assert.equal(f.permissions.microphone.length,0);
  assert.equal(f.calls.length,0);
  assert.match(f.get('live-status').textContent,/batch-only/i);
});

test('reset aborts the request and ignores late ASR and worklet callbacks, including after restart', async t => {
  const pending = deferred();
  const currentText = 'Please follow the normal procedure and verify the invoice with the finance team.';
  const f = fixture(t, async (_call, index) => index === 1 ? pending.promise : reply(currentText));
  f.live.setCapabilities(capabilities);
  await f.get('live-mic').onclick();
  const oldWorkletCallback = f.worklets[0].port.onmessage;
  f.segment();
  assert.equal(f.calls.length, 1);
  const oldSignal = f.calls[0].signal;
  assert.equal(oldSignal.aborted, false);
  await f.live.reset();
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.live.snapshot(), null);
  assert.equal(f.contexts[0].state, 'closed');
  assert.ok(f.streams[0].getTracks().every(track => track.stopped));
  assert.equal(f.worklets[0].port.onmessage, null);

  await f.get('live-mic').onclick();
  oldWorkletCallback({ data: { pcm: new Float32Array(RATE * 8).fill(0.25) } });
  pending.resolve(reply(TRANSCRIPT)); // Deliberately ignore abort in the mocked transport.
  await tick();
  assert.equal(f.calls.length, 1, 'stale worklet samples must not create another request');
  assert.deepEqual(f.live.snapshot().entries, []);
  assert.deepEqual(f.live.snapshot().events, []);
  assert.equal(f.live.snapshot().gaps, 0);
  assert.equal(f.get('pipeline-analysis').textContent, 'Waiting for waveform');

  f.segment();
  await until(() => f.live.snapshot()?.events.length === 1, 'new generation transcript');
  const snapshot = f.live.snapshot();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].text, currentText);
  assert.deepEqual(snapshot.assessment, analyze([{ role: 'caller', text: currentText }]));
  assert.equal(snapshot.events.some(event => event.text === TRANSCRIPT), false);
});

for (const failure of ['http', 'network']) {
  test(`mocked ${failure} ASR failure becomes a coverage gap, not a safe rule result`, async t => {
    const f = fixture(t, async () => {
      if (failure === 'network') throw new Error('Fixture connection failed');
      return { ok: false, status: 503, json: async () => ({ error: 'Fixture ASR unavailable' }) };
    });
    f.live.setCapabilities(capabilities);
    await f.get('live-mic').onclick();
    f.segment();
    await until(() => f.live.snapshot()?.gaps === 1, 'coverage-gap reporting');
    const snapshot = f.live.snapshot();
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].kind, 'gap');
    assert.equal(snapshot.entries[0].start, 0);
    assert.equal(snapshot.entries[0].end, 4.5);
    assert.match(snapshot.entries[0].text, /Speech not analyzed: Fixture/);
    assert.equal(snapshot.events[0].stage, 'gap');
    assert.equal(snapshot.assessment, undefined, 'no transcript means no rule verdict');
    assert.equal(snapshot.peak, null);
    assert.equal(f.frames.some(frame => frame.assessment?.state === 'No concerning combination'), false);
    assert.ok(f.frames.some(frame => frame.snapshot?.gaps === 1));
    assert.match(f.get('live-status').textContent, /coverage gap/);
  });
}

test('stop flushes buffered PCM through the mocked ASR path and releases capture resources', async t => {
  const f = fixture(t);
  f.live.setCapabilities(capabilities);
  await f.get('live-share').onclick();
  assert.equal(f.permissions.display.length, 1);
  assert.equal(f.permissions.microphone.length, 0);
  f.pcm(new Float32Array(RATE * 4).fill(0.25));
  assert.equal(f.calls.length, 0, 'speech awaits a silence boundary or explicit flush');
  await f.get('live-stop').onclick();
  await until(() => f.live.snapshot()?.events.length === 1, 'flushed PCM analysis');
  assert.equal(f.calls[0].url, '/api/transcribe');
  assert.equal(new DataView(f.calls[0].body).getUint32(40, true), RATE * 4 * 2);
  assert.equal(f.live.snapshot().entries[0].end, 4);
  assert.equal(f.live.snapshot().active, false);
  assert.equal(f.contexts[0].state, 'closed');
  assert.ok(f.streams[0].getTracks().every(track => track.stopped));
  assert.equal(f.worklets[0].disconnected, true);
  assert.equal(f.get('live-level').value, 0);
});

test('optional mocked classifier receives recognized caller turns without clearing explicit rule warnings', async t => {
  const f = fixture(t, async call => call.url === '/api/transcribe' ? reply() : ({
    ok: true,
    json: async () => ({ usable: true, score: 0.01, threshold: 0.5, prediction: 'non-scam', status: 'mock-classifier-fixture' })
  }));
  f.live.setCapabilities({ ...capabilities, intent: true });
  await f.get('live-mic').onclick();
  f.segment();
  await until(() => f.live.snapshot()?.events.some(event => event.stage === 'model'), 'classifier evidence event');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].url, '/api/intent');
  assert.equal(f.calls[1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(f.calls[1].body), { turns: [{ role: 'caller', text: TRANSCRIPT }] });
  const expected = analyze([{ role: 'caller', text: TRANSCRIPT }]);
  assert.equal(f.live.snapshot().assessment.state, expected.state);
  const event = f.live.snapshot().events.find(entry => entry.stage === 'model');
  assert.equal(event.transcriptSource, 'local-asr');
  assert.equal(event.text, TRANSCRIPT);
});
