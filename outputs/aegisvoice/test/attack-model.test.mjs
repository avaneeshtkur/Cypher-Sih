import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ATTACK_CLASSES,
  ATTACK_MODEL_LIMITS,
  classifyAttackPath,
  computeCrestFactor,
  computeHarmonicity,
  extractAttackObservation
} from '../attack-model.mjs';

const RATE = 16000;

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function speechLike(seconds = 1.1, seed = 1) {
  const random = rng(seed);
  const output = new Float32Array(Math.floor(seconds * RATE));
  let phase = seed * 0.1;
  for (let i = 0; i < output.length; i++) {
    const time = i / RATE;
    const f0 = 118 + 15 * Math.sin(2 * Math.PI * 0.7 * time + seed);
    phase += 2 * Math.PI * f0 / RATE;
    const active = Math.sin(2 * Math.PI * 2.1 * time + seed * 0.2) > -0.3;
    let voiced = 0;
    for (let harmonic = 1; harmonic <= 45; harmonic++) {
      if (f0 * harmonic >= 7800) break;
      voiced += Math.sin(harmonic * phase + harmonic * 0.05) / Math.pow(harmonic, 0.9);
    }
    const fricative = Math.sin(2 * Math.PI * 1.4 * time + seed) > 0.8
      ? (random() * 2 - 1) * 0.16
      : 0;
    output[i] = (active ? 0.17 : 0.003) * voiced + (active ? fricative : 0);
  }
  return normalize(output);
}

function normalize(samples, peak = 0.7) {
  let maximum = 0;
  for (const value of samples) maximum = Math.max(maximum, Math.abs(value));
  const output = new Float32Array(samples.length);
  const scale = maximum ? peak / maximum : 1;
  for (let i = 0; i < samples.length; i++) output[i] = samples[i] * scale;
  return output;
}

function addNoise(samples, amount, seed) {
  const random = rng(seed);
  const output = new Float32Array(samples.length);
  let colored = 0;
  for (let i = 0; i < samples.length; i++) {
    colored = 0.91 * colored + 0.09 * (random() * 2 - 1);
    output[i] = samples[i] + colored * amount;
  }
  return output;
}

function lowPass(samples, cutoff) {
  const alpha = 1 - Math.exp(-2 * Math.PI * cutoff / RATE);
  const output = new Float32Array(samples.length);
  let state = 0;
  for (let i = 0; i < samples.length; i++) {
    state += alpha * (samples[i] - state);
    output[i] = state;
  }
  return output;
}

function sparseFir(samples, taps) {
  const output = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    for (const [delay, gain] of taps) {
      if (i >= delay) output[i] += samples[i - delay] * gain;
    }
  }
  return output;
}

function liveLike(samples, seed) {
  const room = sparseFir(samples, [
    [0, 1],
    [Math.round(RATE * 0.01), 0.08],
    [Math.round(RATE * 0.023), -0.05]
  ]);
  return normalize(addNoise(room, 0.006, seed));
}

function replayLike(samples, seed) {
  const colored = lowPass(samples, 1650);
  const echoes = sparseFir(colored, [
    [0, 0.78],
    [Math.round(RATE * 0.005), -0.15],
    [Math.round(RATE * 0.028), 0.29],
    [Math.round(RATE * 0.055), 0.20],
    [Math.round(RATE * 0.09), 0.13]
  ]);
  return normalize(lowPass(addNoise(echoes, 0.003, seed), 3000), 0.66);
}

function vcProxy(samples) {
  const phaseChanged = new Float32Array(samples.length);
  let previousInput = 0;
  let previousOutput = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = -0.65 * samples[i] + previousInput + 0.65 * previousOutput;
    phaseChanged[i] = value;
    previousInput = samples[i];
    previousOutput = value;
  }
  const smoothed = sparseFir(phaseChanged, [
    [0, 0.52],
    [1, 0.22],
    [2, 0.14],
    [3, 0.08],
    [4, 0.04]
  ]);
  for (let i = 0; i < smoothed.length; i++) smoothed[i] = Math.round(smoothed[i] * 192) / 192;
  return normalize(smoothed);
}

function rolling(transform, windows = 4, seedBase = 20) {
  const observations = [];
  let previous = null;
  for (let index = 0; index < windows; index++) {
    const seed = seedBase + index * 19;
    const observation = extractAttackObservation(transform(speechLike(1.1, seed), seed), RATE, previous);
    observations.push(observation);
    previous = observation;
  }
  return observations;
}

test('extractor is deterministic, bounded, and adds useful DSP descriptors', () => {
  const sourceRate = 32000;
  const samples = new Float32Array(sourceRate * 5);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.35 * Math.sin(2 * Math.PI * 180 * i / sourceRate);
  const first = extractAttackObservation(samples, sourceRate);
  const second = extractAttackObservation(samples, sourceRate);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), [
    'end', 'metrics', 'pcmSummary', 'profile', 'reason', 'schemaVersion',
    'sequence', 'start', 'temporal', 'usable'
  ]);
  assert.equal(first.start, null);
  assert.equal(first.end, null);
  assert.equal(first.pcmSummary.sampleRate, ATTACK_MODEL_LIMITS.maxSampleRate);
  assert.equal(first.pcmSummary.sampleCount, ATTACK_MODEL_LIMITS.maxSampleRate * ATTACK_MODEL_LIMITS.maxWindowSeconds);
  assert.equal(first.pcmSummary.truncated, true);
  assert.equal(first.pcmSummary.resampled, true);
  assert.ok(first.metrics.crestFactor > 1);
  assert.ok(first.metrics.harmonicity > 0.8);
  assert.ok(computeCrestFactor(samples) > 1);
  assert.ok(computeHarmonicity(first.profile.usable ? samples.subarray(0, 4096) : [], sourceRate).harmonicity > 0.8);
});

test('rolling extraction is backward-looking and never mutates a previous observation', () => {
  const previous = extractAttackObservation(speechLike(1.1, 4), RATE);
  const snapshot = structuredClone(previous);
  const currentA = extractAttackObservation(speechLike(1.1, 5), RATE, previous);
  const currentB = extractAttackObservation(speechLike(1.1, 5), RATE, snapshot);
  assert.deepEqual(previous, snapshot);
  assert.deepEqual(currentA, currentB);
  assert.equal(currentA.temporal.comparedToSequence, previous.sequence);
});

test('insufficient rolling audio is uncertain and reports exact shortfalls', () => {
  const observation = extractAttackObservation(speechLike(0.35, 8), RATE);
  const result = classifyAttackPath([observation], { captureKind: 'microphone', knownSource: false });
  assert.equal(result.topClass, 'uncertain');
  assert.equal(result.sufficientEvidence, false);
  assert.equal(result.evidenceSummary.minimumRequirements.windows, 3);
  assert.ok(result.evidenceSummary.observed.summedAudioSeconds < result.evidenceSummary.minimumRequirements.summedAudioSeconds);
  assert.ok(result.uncertainty >= 0.66);
});

test('known digital-file provenance dominates signal resemblance', () => {
  const acoustic = rolling(liveLike);
  const result = classifyAttackPath(acoustic, { captureKind: 'digital-file', knownSource: true });
  assert.equal(result.topClass, 'direct-injection');
  assert.equal(result.sufficientEvidence, true);
  assert.equal(result.evidenceSummary.provenanceOverride, true);
  assert.ok(result.supportScores['direct-injection'] > 0.7);
  assert.match(result.explanations['direct-injection'].supports.join(' '), /known digital-file route/i);
});

test('microphone speech supports live human while retaining uncertainty', () => {
  const result = classifyAttackPath(rolling(samples => samples), { captureKind: 'microphone', knownSource: false });
  assert.equal(result.sufficientEvidence, true);
  assert.ok(result.supportScores['live-human'] > result.supportScores['direct-injection']);
  assert.ok(result.supportScores['live-human'] > result.supportScores['live-voice-conversion']);
  assert.ok(['live-human', 'uncertain'].includes(result.topClass));
  assert.ok(result.supportScores['live-human'] < 0.8);
  assert.ok(result.uncertainty > 0.1);
});

test('FIR echo and speaker coloration raise replay support without claiming universal detection', () => {
  const result = classifyAttackPath(rolling(replayLike), { captureKind: 'microphone', knownSource: false });
  assert.equal(result.sufficientEvidence, true);
  assert.ok(result.supportScores['speaker-replay'] > result.supportScores['direct-injection']);
  assert.ok(result.supportScores['speaker-replay'] >= result.supportScores['live-human']);
  assert.ok(['speaker-replay', 'uncertain'].includes(result.topClass));
  assert.match(result.explanations['speaker-replay'].supports.join(' '), /coloration/i);
  assert.match(result.limitations.join(' '), /overlap/i);
});

test('VC-like quantization, phase, and smoothing proxy remains uncertain by design', () => {
  const result = classifyAttackPath(
    rolling((samples) => vcProxy(samples), 4, 60),
    { captureKind: 'shared-audio', knownSource: false }
  );
  assert.equal(result.sufficientEvidence, true);
  assert.equal(result.topClass, 'uncertain');
  assert.ok(result.uncertainty >= 0.45);
  assert.ok(result.contradictions.some(item => item.code === 'shared-route-ambiguity'));
  assert.match(result.limitations.join(' '), /Voice-conversion artifacts are not treated as decisive/);
});

test('support is normalized display support with per-class explanations', () => {
  const result = classifyAttackPath(rolling(liveLike), { captureKind: 'microphone', knownSource: false });
  const sum = ATTACK_CLASSES.reduce((total, label) => total + result.classes[label].support, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum ${sum}`);
  assert.deepEqual(Object.keys(result.classes), ATTACK_CLASSES);
  assert.ok(Array.isArray(result.evidence));
  assert.ok(Array.isArray(result.contradictions));
  assert.equal(result.coverageSeconds, result.evidenceSummary.observed.summedAudioSeconds);
  for (const label of ATTACK_CLASSES) {
    const entry = result.classes[label];
    assert.equal(entry.support, result.supportScores[label]);
    assert.ok(entry.support >= 0 && entry.support <= 1);
    assert.equal(typeof entry.explanation, 'string');
    assert.ok(Array.isArray(entry.evidence));
    assert.ok(Array.isArray(entry.counterEvidence));
  }
  assert.ok(result.evidence.every(item =>
    ATTACK_CLASSES.includes(item.class) &&
    ['support', 'counter'].includes(item.direction) &&
    typeof item.detail === 'string'
  ));
  assert.doesNotMatch(JSON.stringify(result), /probabilit/i);
  assert.match(result.supportSemantics, /display support/i);
});

test('classification is stable for identical observations and context', () => {
  const observations = rolling(replayLike, 4, 90);
  const context = { captureKind: 'microphone', knownSource: false };
  assert.deepEqual(classifyAttackPath(observations, context), classifyAttackPath(observations, context));
});

test('contradictory rolling regimes force an uncertain result', () => {
  const observations = [];
  let previous = null;
  for (let index = 0; index < 4; index++) {
    const seed = 120 + index;
    const source = speechLike(1.1, seed);
    const transformed = index % 2 ? replayLike(source, seed) : normalize(source);
    const observation = extractAttackObservation(transformed, RATE, previous);
    observations.push(observation);
    previous = observation;
  }
  const result = classifyAttackPath(observations, { captureKind: 'microphone', knownSource: false });
  assert.equal(result.topClass, 'uncertain');
  assert.ok(result.uncertainty >= 0.74);
  assert.ok(result.contradictions.some(item => item.severe));
});

test('lab labels are preserved as metadata but cannot leak into scores', () => {
  const observations = rolling(liveLike, 4, 150);
  const humanLabel = classifyAttackPath(observations, {
    captureKind: 'microphone',
    knownSource: false,
    labCondition: { id: 'lab-a', expectedClass: 'live-human', simulated: true }
  });
  const replayLabel = classifyAttackPath(observations, {
    captureKind: 'microphone',
    knownSource: false,
    labCondition: { id: 'lab-b', expectedClass: 'speaker-replay', simulated: true }
  });
  assert.deepEqual(humanLabel.supportScores, replayLabel.supportScores);
  assert.equal(humanLabel.labCondition.id, 'lab-a');
  assert.equal(replayLabel.labCondition.expectedClass, 'speaker-replay');
});

test('bare liveness channel profiles are accepted as observations', () => {
  const extracted = rolling(liveLike);
  const profiles = extracted.map(observation => observation.profile);
  const result = classifyAttackPath(profiles, { captureKind: 'microphone', knownSource: false });
  assert.equal(Object.keys(result.supportScores).length, 4);
  assert.equal(result.evidenceSummary.observed.usableWindows, profiles.length);
});

test('calibration artifact records deterministic confusion, margins, and overlap limits', () => {
  const artifact = JSON.parse(readFileSync(new URL('../models/attack_calibration.json', import.meta.url), 'utf8'));
  assert.equal(artifact.deterministic, true);
  assert.equal(artifact.conditions.length, 4);
  assert.ok(artifact.conditions.every(condition => condition.margin && condition.support_mean));
  assert.ok(artifact.confusion_counts['direct-injection']);
  assert.equal(artifact.overlap.any_pairwise_support_overlap, true);
  assert.equal(artifact.api_contract.version, 1);
  assert.deepEqual(artifact.api_contract.classifier.class_keys, ATTACK_CLASSES);
  assert.equal(artifact.api_contract.classifier.primary_shape.coverageSeconds, 'bounded sum of usable observation durations');
  assert.equal(artifact.api_contract.observation.shape.profile, 'channelProfile object');
  assert.match(artifact.method, /not real attack classes/i);
  assert.match(artifact.limitations.join(' '), /field|deployment/i);
});
