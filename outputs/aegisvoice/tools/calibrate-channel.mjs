// Reproducible calibration for the channel-continuity thresholds used by
// liveness-core.mjs. Run with: node tools/calibrate-channel.mjs
//
// Signals are synthetic and deterministic. This measures how far apart channel
// profiles sit under known transformations; it does not establish performance on
// real calls, and it is not a replay benchmark.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { channelProfile, profileDistance, LIVENESS_THRESHOLDS } from '../liveness-core.mjs';

const RATE = 16000, TRIALS = 24, SECONDS = 3;
const rng = seed => () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function utterance(seconds, seed) {
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
const room = (a, g) => { const n = a.length, out = new Float32Array(n), d = Math.floor(RATE * 0.035); for (let i = 0; i < n; i++) out[i] = a[i] + (i >= d ? g * out[i - d] : 0); return out; };
const gain = (a, g) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = Math.max(-1, Math.min(1, a[i] * g)); return o; };
const noisy = (a, amt, seed) => { const random = rng(seed), o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] + (random() * 2 - 1) * amt; return o; };

// "same" conditions must not be flagged as a mismatch. "changed" conditions are
// genuine acoustic path changes we would like to notice.
const CONDITIONS = [
  ['same path, different utterance', 'same', s => utterance(SECONDS, s + 500)],
  ['same path, gain change', 'same', s => gain(utterance(SECONDS, s + 500), 1.8)],
  ['same path, mild added noise', 'same', s => noisy(utterance(SECONDS, s + 500), 0.004, s)],
  ['replay through room speaker (mild)', 'changed', s => room(utterance(SECONDS, s + 500), 0.55)],
  ['replay through room speaker (strong)', 'changed', s => room(utterance(SECONDS, s + 500), 0.75)],
  ['telephone / decimated codec path', 'changed', s => telephone(utterance(SECONDS, s + 500))]
];

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const results = [];
for (const [name, group, transform] of CONDITIONS) {
  const distances = [];
  for (let s = 1; s <= TRIALS; s++) {
    const reference = channelProfile(utterance(SECONDS, s), RATE);
    const compared = channelProfile(transform(s), RATE);
    const d = profileDistance(reference, compared);
    if (d) distances.push(d.distance);
  }
  distances.sort((a, b) => a - b);
  results.push({ condition: name, group, trials: distances.length,
    min: +distances[0].toFixed(4), p50: +quantile(distances, 0.5).toFixed(4),
    p95: +quantile(distances, 0.95).toFixed(4), max: +distances[distances.length - 1].toFixed(4) });
}

// Repeat the key comparison on the real demo recordings. Their high-band content
// differs from the synthetic signals, which changes how far a channel change moves
// the distance. This is measured rather than assumed.
function readWav(file) {
  const buffer = readFileSync(file);
  let pos = 12, rate = 0, channels = 0, bits = 0, dataStart = 0, dataLength = 0;
  while (pos < buffer.length - 8) {
    const id = buffer.toString('ascii', pos, pos + 4), size = buffer.readUInt32LE(pos + 4);
    if (id === 'fmt ') { channels = buffer.readUInt16LE(pos + 10); rate = buffer.readUInt32LE(pos + 12); bits = buffer.readUInt16LE(pos + 22); }
    if (id === 'data') { dataStart = pos + 8; dataLength = size; break; }
    pos += 8 + size + (size % 2);
  }
  if (bits !== 16 || !rate) return null;
  const samples = Math.floor(dataLength / 2 / channels), mono = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buffer.readInt16LE(dataStart + (i * channels + c) * 2) / 32768;
    mono[i] = sum / channels;
  }
  return { mono, rate };
}
const demoDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo-audio');
const realAudio = [];
try {
  const a = readWav(path.join(demoDir, 'payment-pressure.wav'));
  const b = readWav(path.join(demoDir, 'legitimate-payment.wav'));
  if (a && b) {
    const reference = channelProfile(a.mono, a.rate);
    const sameSource = channelProfile(b.mono, b.rate);
    // Telephone path applied to the second clip.
    const n = b.mono.length, alpha = 1 - Math.exp(-2 * Math.PI * 3400 / b.rate), filtered = new Float32Array(n);
    let lp = 0;
    for (let i = 0; i < n; i++) { lp += alpha * (b.mono[i] - lp); filtered[i] = lp; }
    const half = new Float32Array(Math.floor(n / 2));
    for (let i = 0; i < half.length; i++) half[i] = filtered[i * 2];
    const decimated = new Float32Array(n);
    for (let i = 0; i < n; i++) { const s = i / 2, j = Math.floor(s), f = s - j; decimated[i] = (half[j] || 0) * (1 - f) + (half[j + 1] || 0) * f; }
    const injected = channelProfile(decimated, b.rate);
    realAudio.push(
      { comparison: 'demo clip vs demo clip (same recording path)', distance: +profileDistance(reference, sameSource).distance.toFixed(4), reference_high_band_ratio: +reference.highBandRatio.toFixed(4) },
      { comparison: 'demo clip vs telephone-decimated demo clip', distance: +profileDistance(reference, injected).distance.toFixed(4), reference_high_band_ratio: +reference.highBandRatio.toFixed(4) }
    );
  }
} catch { /* demo audio is optional */ }

const same = results.filter(r => r.group === 'same');
const changed = results.filter(r => r.group === 'changed');
const worstSame = Math.max(...same.map(r => r.max));
const bestChanged = Math.min(...changed.map(r => r.min));
const mildReplay = results.find(r => r.condition.includes('mild'));
const noiseSame = results.find(r => r.condition.includes('noise'));
const overlap = mildReplay.min <= noiseSame.max;

const report = {
  generated_at: new Date().toISOString(),
  method: 'Synthetic deterministic signals transformed by known channel operations. Distances are normalized channel-profile distances.',
  rate: RATE, trials_per_condition: TRIALS, seconds_per_trial: SECONDS,
  results,
  real_audio: realAudio,
  separation: {
    worst_same_path_distance: +worstSame.toFixed(4),
    best_changed_path_distance: +bestChanged.toFixed(4),
    same_and_changed_overlap: overlap
  },
  thresholds_in_use: LIVENESS_THRESHOLDS,
  threshold_rationale: `channelMatch ${LIVENESS_THRESHOLDS.channelMatch} sits at or below the typical same-path distance. ` +
    `channelMismatch ${LIVENESS_THRESHOLDS.channelMismatch} sits above the worst measured same-path distance (${worstSame.toFixed(3)}), ` +
    'so a same-path reply is not expected to be reported as mismatched. The band between them is reported as partial and only lowers reliability.',
  limitations: [
    `Mild loudspeaker replay (${mildReplay.min}-${mildReplay.max}) overlaps the range of a same path with added noise (${noiseSame.min}-${noiseSame.max}). Channel continuity therefore cannot detect low-reverberation replay and must never be read as a replay detector.`,
    'Sensitivity depends on how much high-band energy the reference audio carries. On the bundled text-to-speech demo clips, whose high-band share is far lower than the synthetic calibration signals, a telephone-decimated reply moves the distance only into the partial band rather than past the mismatch threshold. Sources that are already band-limited weaken this check.',
    'Thresholds are chosen to avoid false mismatch on an unchanged path, which necessarily lets some genuine path changes through as partial or consistent.',
    'Signals are synthetic apart from the demo comparison. Real microphones, rooms, codecs and packet loss are not represented, so these distances do not establish field performance.',
    'A consistent channel does not establish that speech is live, genuine or from the claimed speaker.'
  ]
};

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'models');
mkdirSync(target, { recursive: true });
writeFileSync(path.join(target, 'channel_calibration.json'), JSON.stringify(report, null, 2), 'utf8');

console.log('condition'.padEnd(38), 'group'.padEnd(9), 'min     p50     p95     max');
for (const r of results) console.log(r.condition.padEnd(38), r.group.padEnd(9), String(r.min).padEnd(7), String(r.p50).padEnd(7), String(r.p95).padEnd(7), r.max);
console.log('\nworst same-path:', worstSame.toFixed(4), ' best changed-path:', bestChanged.toFixed(4), ' overlap:', overlap);
for (const r of realAudio) console.log('real audio:', r.comparison, '->', r.distance, '(high-band share', r.reference_high_band_ratio + ')');
console.log('thresholds:', JSON.stringify(LIVENESS_THRESHOLDS));
console.log('written: models/channel_calibration.json');
