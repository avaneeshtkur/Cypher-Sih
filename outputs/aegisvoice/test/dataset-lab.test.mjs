import test from 'node:test';
import assert from 'node:assert/strict';
import { initDatasetLab, savedTextDecision, speakerOverlapClaim } from '../dataset-lab.js';

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.value = ''; this.checked = false; this.text = ''; this.disabled = false; }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; if (this.tag === 'select') this.value = children[0]?.value || ''; }
  removeAttribute(name) { delete this[name]; }
  pause() {}
  load() {}
}
function fixture(t, { status, reports = {}, textRows, audioRows, failReports = false, failAudio = false } = {}) {
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, new Element(id.endsWith('-sample') ? 'select' : 'div'));
      return elements.get(id);
    },
    createElement: tag => new Element(tag)
  };
  const calls = [];
  const rows = {
    text: textRows || Array.from({ length: 14 }, (_, i) => ({ id: `text-${i}`, label: i % 2, prediction: 0, evaluation_split: 'source split', type: 'sample', turns: [{ role: 'caller', text: 'Saved caller text.' }] })),
    audio: audioRows || [{ id: 'audio-1', label: 1, prediction: 0, speaker: 'reported-1', audioAvailable: false }]
  };
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/status') {
      if (status instanceof Error) throw status;
      return { ok: true, json: async () => status };
    }
    if (url === '/api/reports') {
      if (failReports) throw new Error('Reports offline');
      return { ok: true, json: async () => reports };
    }
    if (url.startsWith('/api/dataset/audio/')) return {
      ok: !failAudio, json: async () => ({ error: 'Recording disappeared' }), blob: async () => new Blob(['waveform'])
    };
    if (url === '/api/replay') return { ok: true, json: async () => ({ status: 'Uncertain', score: 0.5, reason: 'Fresh test result', inference_ms: 2 }) };
    const parsed = new URL(url, 'http://localhost');
    const kind = parsed.pathname.endsWith('text') ? 'text' : 'audio';
    let filtered = rows[kind];
    const label = parsed.searchParams.get('label');
    if (['0', '1'].includes(label)) filtered = filtered.filter(row => row.label === +label);
    if (parsed.searchParams.get('errors') === '1') filtered = filtered.filter(row => row.label !== row.prediction);
    const offset = Number(parsed.searchParams.get('offset'));
    return { ok: true, json: async () => ({ rows: filtered.slice(offset, offset + 12), total: filtered.length, offset }) };
  };
  t.mock.method(globalThis, 'fetch', fetch);
  const oldDocument = globalThis.document;
  globalThis.document = document;
  t.after(() => { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; });
  return { get: id => document.getElementById(id), calls };
}
const unavailable = { runtime: false, asr: false, intent: false, replay: false, datasetAudio: false, reasons: {} };
const ready = { runtime: true, asr: true, intent: true, replay: true, datasetAudio: true, reasons: {} };
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('saved imported records expose the same four-level snapshot without claiming fresh inference',()=>{
  const report={low_risk_threshold:.25,high_risk_threshold:.9};
  const low=savedTextDecision({model_score:.1,turns:[{role:'caller',text:'Please use the normal approval and call our saved number before making any change.'}]},report);
  const high=savedTextDecision({model_score:.99,turns:[{role:'caller',text:'Transfer money now, skip approval, and do not tell anyone about this urgent request.'}]},report);
  assert.equal(low.level,'low');assert.equal(low.rank,1);
  assert.equal(high.level,'high');assert.equal(high.rank,4);
});

test('missing or incomplete speaker maps never imply zero overlap', () => {
  for (const map of [undefined, {}, { train_dev: [] }, { train_dev: [], train_eval: [], dev_eval: null }]) {
    assert.match(speakerOverlapClaim(map), /not fully reported/);
    assert.doesNotMatch(speakerOverlapClaim(map), /zero/);
  }
  assert.match(speakerOverlapClaim({ train_dev: [], train_eval: [], dev_eval: [] }), /saved report claims zero.*has not verified/);
});

test('stored metrics stay compact, diagnostic, and honest about rate denominators', async t => {
  const f = fixture(t, { reports: {
    replay: { selective_test: { coverage: 0.7, attack_acceptance_rate: 0.2, genuine_rejection_rate: 0.1 } },
    sources: { files: [{ name: 'saved.zip', bytes: 100, sha256: 'abc', license: 'reported license' }] }
  } });
  const result = await initDatasetLab({ status: Promise.resolve(unavailable), loadText() {} });
  assert.equal(result.readinessAvailable, true);
  assert.equal(f.calls.filter(call => call.url === '/api/status').length, 0, 'reuse supplied readiness');
  const cards = f.get('audit-grid').children;
  assert.equal(cards.length, 4);
  assert.ok(cards.every(card => card.children.some(child => child.tag === 'details')));
  const text = f.get('audit-grid').textContent;
  assert.match(text, /reused-corpus diagnostic/);
  assert.match(text, /20.0% of all replay recordings/);
  assert.match(text, /10.0% of all genuine recordings/);
  assert.match(text, /denominators include uncertain recordings/);
  assert.match(text, /Speaker overlap was not fully reported/);
  assert.match(f.get('source-list').textContent, /saved report claims, not current verification/);
  assert.match(f.get('dataset-metrics').textContent, /BothBosu conversations \+ Fraud Call India publisher labels \+ weak-labelled NCSU transcripts \/ replay benchmark; not interactive-human-call validated/);
  const visibleLinks=f.get('dataset-metrics').children.flatMap(child=>child.children).filter(child=>child.tag==='a');
  assert.equal(visibleLinks.length,7);
  assert.deepEqual(visibleLinks.map(link=>link.href),[
    'https://huggingface.co/datasets/BothBosu/single-agent-scam-conversations',
    'https://huggingface.co/datasets/BothBosu/multi-agent-scam-conversation',
    'https://doi.org/10.7488/ds/2332',
    'https://robocall.science/',
    'https://github.com/JimmyMa99/TeleAntiFraud',
    'https://www.kaggle.com/datasets/narayanyadav/fraud-call-india-dataset/data',
    'https://data.mendeley.com/datasets/79g59sp69z/1'
  ]);
  assert.match(f.get('source-list').textContent, /meta-llama-3-70b-instruct/);
  assert.match(f.get('source-list').textContent, /AutoGen\/Together synthetic agents/);
  assert.equal(f.get('run-audio').disabled, true);
  assert.equal(f.get('use-reply').disabled, true);
  assert.equal(f.get('dataset-playback').src, undefined);
});

test('external dataset cards name the source, usage, licence, revision and limitation',async t=>{
  const reports={
    intent:{train_count:1024,development_count:256,published_test:{n:320},transfer_test:{n:1600}},
    replay:{train_count:3014,development_count:1710,evaluation_count:13306,held_out_test:{n:13306}},
    sources:{files:[
      {name:'scam_single/train.csv',revision:'single-sha',license:'Apache-2.0',bytes:1,sha256:'a'},
      {name:'scam_multi/train.csv',revision:'multi-sha',license:'Apache-2.0',bytes:1,sha256:'b'},
      {name:'asvspoof2017/train.zip',revision:'ASVspoof DOI',license:'CC-BY-NC-4.0',bytes:1,sha256:'c'}
    ]}
  };
  const f=fixture(t,{reports});
  await initDatasetLab({status:Promise.resolve(unavailable)});
  const cards=f.get('external-datasets').children;
  assert.equal(cards.length,7);
  const text=f.get('external-datasets').textContent;
  for(const expected of ['BothBosu / single-agent','meta-llama-3-70b-instruct','1,600 total','single-sha','AutoGen agents','1,600 saved transfer','multi-sha','ASVspoof 2017','3,014 train','13,306 evaluation','CC BY-NC 4.0','ASVspoof DOI'])assert.match(text,new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(text,/not recordings of real callers/i);
  assert.match(text,/not independent real-call validation/i);
  assert.match(text,/not scam calls/i);
  assert.match(text,/automated or prerecorded/i);
  assert.match(text,/TTS-regenerated/i);
  assert.match(text,/5,927 records/);
  assert.match(text,/0 audio files/);
  assert.match(text,/Text-only/);
  assert.match(text,/600 installed WAVs/);
  assert.match(text,/no genuine class/i);
  const links=cards.map(card=>card.children[0].children[0]);
  assert.deepEqual(links.map(link=>link.href),[
    'https://huggingface.co/datasets/BothBosu/single-agent-scam-conversations',
    'https://huggingface.co/datasets/BothBosu/multi-agent-scam-conversation',
    'https://doi.org/10.7488/ds/2332',
    'https://robocall.science/',
    'https://github.com/JimmyMa99/TeleAntiFraud',
    'https://www.kaggle.com/datasets/narayanyadav/fraud-call-india-dataset/data',
    'https://data.mendeley.com/datasets/79g59sp69z/1'
  ]);
});

test('readiness failure does not infer availability from reports or block paging and filtering', async t => {
  const f = fixture(t, { status: new Error('Offline'), reports: { intent: {}, replay: {} } });
  let loaded;
  const result = await initDatasetLab({ loadText: row => { loaded = row; }, useReply() {} });
  assert.equal(result.status.intent, false);
  assert.equal(result.readinessAvailable, false);
  assert.equal(result.textMetadataAvailable, true);
  assert.equal(result.audioMetadataAvailable, true);
  assert.match(f.get('model-health').textContent, /unverified/);
  assert.equal(f.get('load-text').disabled, false);
  f.get('load-text').onclick();
  assert.equal(loaded.id, 'text-0');
  assert.match(f.get('text-preview').textContent, /saved label/);
  assert.match(f.get('text-preview').textContent, /saved model prediction/);
  f.get('text-next').onclick();
  await nextTurn();
  assert.equal(f.get('text-page').textContent, '13–14 of 14');
  assert.equal(f.get('text-next').disabled, true);
  f.get('text-label').value = '1';
  f.get('text-label').onchange();
  await nextTurn();
  assert.equal(f.get('text-page').textContent, '1–7 of 7');
  assert.equal(f.get('text-prev').disabled, true);
  await f.get('run-audio').onclick();
  await f.get('use-reply').onclick();
  assert.equal(f.calls.some(call => call.url.startsWith('/api/dataset/audio/')), false);
});

test('metadata browsing survives missing reports and rejected shared readiness', async t => {
  const f = fixture(t, { failReports: true });
  const result = await initDatasetLab({ status: Promise.reject(new Error('No status')) });
  assert.equal(result.reportsAvailable, false);
  assert.equal(result.readinessAvailable, false);
  assert.equal(result.textMetadataAvailable, true);
  assert.equal(f.get('load-text').disabled, true, 'callbacks are optional');
  assert.equal(f.calls.some(call => call.url === '/api/status'), false);
});

test('audio playback is lazy and sample availability overrides global readiness', async t => {
  const f = fixture(t, { audioRows: [
    { id: 'present', label: 0, prediction: 0, audioAvailable: true },
    { id: 'missing', label: 1, prediction: 0, audioAvailable: false }
  ] });
  await initDatasetLab({ status: ready, useReply() {} });
  assert.equal(f.get('dataset-playback').preload, 'none');
  assert.equal(f.get('dataset-playback').src, '/api/dataset/audio/present');
  assert.equal(f.calls.some(call => call.url.startsWith('/api/dataset/audio/')), false);
  assert.equal(f.get('run-audio').disabled, false);
  f.get('audio-sample').value = 'missing';
  f.get('audio-sample').onchange();
  assert.equal(f.get('run-audio').disabled, true);
  assert.equal(f.get('use-reply').disabled, true);
  assert.equal(f.get('dataset-playback').src, undefined);
  assert.match(f.get('audio-preview').textContent, /This recording is unavailable/);
});

test('failed waveform fetch is displayed, not submitted as JSON bytes to inference', async t => {
  const f = fixture(t, { audioRows: [{ id: 'present', label: 0, prediction: 0, audioAvailable: true }], failAudio: true });
  await initDatasetLab({ status: ready, useReply() {} });
  await f.get('run-audio').onclick();
  assert.match(f.get('dataset-audio-result').textContent, /Recording disappeared/);
  assert.equal(f.calls.some(call => call.url === '/api/replay'), false);
});
