import test from 'node:test';
import assert from 'node:assert/strict';
import { channelProfile, profileDistance, assessLiveness, LIVENESS_THRESHOLDS } from '../liveness-core.mjs';

const RATE = 16000;
const rng = seed => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function utterance(seconds = 2, seed = 7) {
  const random = rng(seed), n = Math.floor(RATE * seconds), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE, f0 = 115 + 12 * Math.sin(2 * Math.PI * 0.6 * t + seed);
    let v = 0;
    for (let h = 1; h <= 40; h++) { const f = f0 * h; if (f > 7600) break; v += Math.sin(2 * Math.PI * f * t) / Math.pow(h, 0.85); }
    v *= 0.25;
    if (Math.sin(2 * Math.PI * 1.25 * t + seed) > 0.85) v += (random() * 2 - 1) * 0.45;
    out[i] = v * (Math.sin(2 * Math.PI * 1.6 * t + seed) > -0.35 ? 1 : 0.02) + (random() * 2 - 1) * 0.001;
  }
  return out;
}
const tone = (hz, seconds = 1) => {
  const n = Math.floor(RATE * seconds), a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = 0.3 * Math.sin(2 * Math.PI * hz * i / RATE);
  return a;
};
const telephone = a => {
  const n = a.length, alpha = 1 - Math.exp(-2 * Math.PI * 3400 / RATE), filtered = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) { lp += alpha * (a[i] - lp); filtered[i] = lp; }
  const half = new Float32Array(Math.floor(n / 2));
  for (let i = 0; i < half.length; i++) half[i] = filtered[i * 2];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = i / 2, j = Math.floor(s), f = s - j; out[i] = (half[j] || 0) * (1 - f) + (half[j + 1] || 0) * f; }
  return out;
};

test('FFT-based centroid locates a pure tone', () => {
  const p = channelProfile(tone(1000), RATE);
  assert.ok(Math.abs(p.spectralCentroidHz - 1000) < 40, `centroid ${p.spectralCentroidHz}`);
  assert.ok(p.spectralFlatness < 0.01, 'a pure tone is not spectrally flat');
});
test('silence and empty input are reported unusable rather than guessed', () => {
  assert.equal(channelProfile(new Float32Array(0), RATE).usable, false);
  assert.equal(channelProfile(new Float32Array(RATE), RATE).usable, false);
});
test('speech gating separates speech seconds from silence', () => {
  const p = channelProfile(utterance(3), RATE);
  assert.ok(p.usable);
  assert.ok(p.speechSeconds > 0.5 && p.speechSeconds < 3, `speechSeconds ${p.speechSeconds}`);
  assert.ok(p.silenceRatio > 0 && p.silenceRatio < 1);
});
test('band-limited audio is detected as narrowband by high-band energy share', () => {
  const wide = channelProfile(utterance(3), RATE);
  const narrow = channelProfile(telephone(utterance(3)), RATE);
  assert.equal(wide.narrowband, false);
  assert.equal(narrow.narrowband, true);
  assert.ok(narrow.highBandRatio < wide.highBandRatio);
});
test('clipping is measured', () => {
  const loud = utterance(2).map(v => Math.max(-1, Math.min(1, v * 12)));
  assert.ok(channelProfile(Float32Array.from(loud), RATE).clippingRatio > 0.01);
});
test('same acoustic path scores far closer than a changed path', () => {
  const a = channelProfile(utterance(3, 1), RATE);
  const same = channelProfile(utterance(3, 2), RATE);
  const changed = channelProfile(telephone(utterance(3, 2)), RATE);
  const dSame = profileDistance(a, same).distance;
  const dChanged = profileDistance(a, changed).distance;
  assert.ok(dSame < dChanged, `${dSame} !< ${dChanged}`);
  assert.ok(dSame <= LIVENESS_THRESHOLDS.channelMatch, `same-path distance ${dSame}`);
  assert.ok(dChanged >= LIVENESS_THRESHOLDS.channelMismatch, `changed-path distance ${dChanged}`);
});
test('profile distance is symmetric and zero against itself', () => {
  const a = channelProfile(utterance(2, 3), RATE), b = channelProfile(utterance(2, 4), RATE);
  assert.equal(profileDistance(a, a).distance, 0);
  assert.ok(Math.abs(profileDistance(a, b).distance - profileDistance(b, a).distance) < 1e-12);
});
test('distance is unavailable when either profile is unusable', () => {
  assert.equal(profileDistance(channelProfile(utterance(2), RATE), channelProfile(new Float32Array(RATE), RATE)), null);
});

test('a mismatched channel withholds a live-consistent claim even with a correct phrase', () => {
  const call = channelProfile(utterance(3, 1), RATE);
  const reply = channelProfile(telephone(utterance(3, 2)), RATE);
  const r = assessLiveness({ outcome: 'Completed', replyProfile: reply, callProfile: call });
  assert.equal(r.state, 'Not established');
  assert.equal(r.support, 'channel-mismatch');
  assert.equal(r.channel.state, 'mismatched');
});
test('a consistent channel strengthens support for a correct phrase', () => {
  const call = channelProfile(utterance(3, 1), RATE);
  const reply = channelProfile(utterance(3, 2), RATE);
  const r = assessLiveness({ outcome: 'Completed', replyProfile: reply, callProfile: call });
  assert.equal(r.state, 'Live-consistent');
  assert.equal(r.channel.state, 'consistent');
  assert.equal(r.support, 'phrase-and-channel');
});
test('replay evidence still overrides a consistent channel and a correct phrase', () => {
  const call = channelProfile(utterance(3, 1), RATE);
  const reply = channelProfile(utterance(3, 2), RATE);
  const r = assessLiveness({ outcome: 'Completed', replay: { status: 'Replay-like' }, replyProfile: reply, callProfile: call });
  assert.equal(r.state, 'Replay-suspected');
});
test('unusable reply audio lowers reliability and withholds a confident claim', () => {
  const r = assessLiveness({ outcome: 'Completed', replyProfile: channelProfile(new Float32Array(RATE), RATE) });
  assert.ok(r.reliability < LIVENESS_THRESHOLDS.minReliability, `reliability ${r.reliability}`);
  assert.equal(r.state, 'Not established');
  assert.equal(r.support, 'insufficient-reliability');
});
test('reliability stays within bounds and timing is never used', () => {
  for (const input of [{}, { outcome: 'Completed' }, { outcome: 'Incorrect', intervalMs: 8000 }, { expired: true }]) {
    const r = assessLiveness(input);
    assert.ok(r.reliability >= 0 && r.reliability <= 1);
    assert.equal(r.timingUsed, false);
    assert.equal(r.identity, 'Not established');
  }
});
test('channel evidence alone never produces a liveness claim', () => {
  const call = channelProfile(utterance(3, 1), RATE);
  const reply = channelProfile(utterance(3, 2), RATE);
  const r = assessLiveness({ replyProfile: reply, callProfile: call });
  assert.equal(r.state, 'Not established');
  assert.equal(r.support, 'none');
});
test('thresholds are declared and the engine reports it is uncalibrated for field use', () => {
  const r = assessLiveness({ outcome: 'Completed' });
  assert.equal(r.calibrated, false);
  assert.ok(r.thresholds.channelMismatch > r.thresholds.channelMatch);
});
