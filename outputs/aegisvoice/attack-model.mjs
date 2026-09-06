// Rolling, bounded DSP support for attack-path hypotheses.
//
// This module deliberately produces relative display support, not a claim that
// any class has been identified. The cues overlap across rooms, microphones,
// codecs, speakers and voice-processing systems, so ambiguous evidence is
// surfaced as uncertainty instead of being forced into a class.
import { channelProfile } from './liveness-core.mjs';

export const ATTACK_CLASSES = Object.freeze([
  'live-human',
  'live-voice-conversion',
  'direct-injection',
  'speaker-replay'
]);

export const ATTACK_MODEL_LIMITS = Object.freeze({
  maxWindowSeconds: 4,
  maxSampleRate: 16000,
  minSampleRate: 8000,
  maxRollingWindows: 12,
  minimumWindowSeconds: 0.75,
  minimumWindows: 3,
  minimumSummedAudioSeconds: 2.4,
  minimumSummedSpeechSeconds: 1.0,
  minimumTransitions: 2,
  minimumTopSupport: 0.40,
  minimumDecisionMargin: 0.08,
  maximumDecisionUncertainty: 0.55
});

const EPSILON = 1e-12;
const PROFILE_SCALES = Object.freeze({
  reverbProxySeconds: 0.16,
  highBandRatio: 0.07,
  clippingRatio: 0.025,
  spectralFlatness: 0.16,
  spectralCentroidHz: 1600,
  spectralTiltDb: 10,
  zeroCrossingRate: 0.08,
  snrDb: 20,
  silenceRatio: 0.45
});

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rounded = value => Math.round(value * 1e6) / 1e6;

function valueOf(object, key, fallback = null) {
  const value = object?.[key];
  return finite(value) ? value : fallback;
}

function mean(values) {
  const usable = values.filter(finite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function range(values) {
  const usable = values.filter(finite);
  return usable.length ? Math.max(...usable) - Math.min(...usable) : 0;
}

function quantile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
}

function normalizeSupports(raw) {
  const values = ATTACK_CLASSES.map(label => Math.max(0.001, raw[label] || 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const output = {};
  let assigned = 0;
  ATTACK_CLASSES.forEach((label, index) => {
    const value = index === ATTACK_CLASSES.length - 1
      ? rounded(1 - assigned)
      : rounded(values[index] / total);
    output[label] = clamp(value);
    assigned += output[label];
  });
  return output;
}

function preparePcm(pcm, suppliedRate) {
  const sourceRate = Number(suppliedRate);
  const sourceLength = Number.isSafeInteger(pcm?.length) ? pcm.length : 0;
  if (!sourceLength || !finite(sourceRate) || sourceRate < ATTACK_MODEL_LIMITS.minSampleRate) {
    return {
      samples: new Float32Array(0),
      sourceRate: finite(sourceRate) ? sourceRate : null,
      analysisRate: Math.min(ATTACK_MODEL_LIMITS.maxSampleRate, Math.max(0, sourceRate || 0)),
      sourceDurationSeconds: 0,
      truncated: false,
      resampled: false,
      reason: !sourceLength ? 'No PCM samples' : 'Sample rate below the supported 8 kHz minimum'
    };
  }

  const maxSourceSamples = Math.max(1, Math.floor(sourceRate * ATTACK_MODEL_LIMITS.maxWindowSeconds));
  const usedSourceSamples = Math.min(sourceLength, maxSourceSamples);
  const sourceStart = sourceLength - usedSourceSamples;
  const sourceDurationSeconds = usedSourceSamples / sourceRate;
  const analysisRate = Math.min(sourceRate, ATTACK_MODEL_LIMITS.maxSampleRate);
  const targetLength = Math.min(
    ATTACK_MODEL_LIMITS.maxWindowSeconds * ATTACK_MODEL_LIMITS.maxSampleRate,
    Math.max(1, Math.floor(sourceDurationSeconds * analysisRate))
  );
  const samples = new Float32Array(targetLength);

  if (analysisRate === sourceRate && targetLength === usedSourceSamples) {
    for (let i = 0; i < targetLength; i++) {
      const value = Number(pcm[sourceStart + i]);
      samples[i] = finite(value) ? clamp(value, -1, 1) : 0;
    }
  } else {
    // Bounded linear resampling. At most 64,000 output points are inspected.
    const scale = sourceRate / analysisRate;
    for (let i = 0; i < targetLength; i++) {
      const position = sourceStart + Math.min(usedSourceSamples - 1, (i + 0.5) * scale - 0.5);
      const left = Math.max(sourceStart, Math.floor(position));
      const right = Math.min(sourceStart + usedSourceSamples - 1, left + 1);
      const fraction = position - left;
      const a = finite(Number(pcm[left])) ? Number(pcm[left]) : 0;
      const b = finite(Number(pcm[right])) ? Number(pcm[right]) : 0;
      samples[i] = clamp(a + (b - a) * fraction, -1, 1);
    }
  }

  return {
    samples,
    sourceRate,
    analysisRate,
    sourceDurationSeconds,
    truncated: usedSourceSamples < sourceLength,
    resampled: analysisRate !== sourceRate,
    reason: null
  };
}

/** Crest factor over at most the latest 64,000 normalized PCM samples. */
export function computeCrestFactor(pcm) {
  const length = Math.min(Number.isSafeInteger(pcm?.length) ? pcm.length : 0, 64000);
  if (!length) return 0;
  const start = pcm.length - length;
  let peak = 0;
  let energy = 0;
  for (let i = start; i < pcm.length; i++) {
    const value = finite(Number(pcm[i])) ? Number(pcm[i]) : 0;
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
  }
  const rms = Math.sqrt(energy / length);
  return rms > EPSILON ? peak / rms : 0;
}

function strongestFrame(samples, frameLength) {
  if (samples.length <= frameLength) return samples;
  let bestStart = 0;
  let bestEnergy = -1;
  const hop = Math.max(64, frameLength >> 2);
  for (let start = 0; start + frameLength <= samples.length; start += hop) {
    let energy = 0;
    for (let i = start; i < start + frameLength; i++) energy += samples[i] * samples[i];
    if (energy > bestEnergy) {
      bestEnergy = energy;
      bestStart = start;
    }
  }
  return samples.slice(bestStart, bestStart + frameLength);
}

/**
 * Peak normalized autocorrelation in the 70-400 Hz range.
 * The result is a periodicity/harmonicity descriptor, not a human-voice test.
 */
function harmonicityOfPreparedPcm(pcm, rate) {
  if (!pcm?.length || !finite(rate) || rate <= 0) return { harmonicity: 0, lagMs: null };
  const frame = strongestFrame(pcm, Math.min(2048, pcm.length));
  if (frame.length < 128) return { harmonicity: 0, lagMs: null };
  let average = 0;
  for (const value of frame) average += value;
  average /= frame.length;

  const minLag = Math.max(2, Math.floor(rate / 400));
  const maxLag = Math.min(Math.floor(rate / 70), Math.floor(frame.length / 2));
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let i = 0; i + lag < frame.length; i++) {
      const left = frame[i] - average;
      const right = frame[i + lag] - average;
      cross += left * right;
      leftEnergy += left * left;
      rightEnergy += right * right;
    }
    const correlation = cross / Math.sqrt(Math.max(EPSILON, leftEnergy * rightEnergy));
    if (correlation > best) {
      best = correlation;
      bestLag = lag;
    }
  }
  return {
    harmonicity: clamp(best),
    lagMs: bestLag ? bestLag * 1000 / rate : null
  };
}

export function computeHarmonicity(pcm, rate = 16000) {
  const prepared = preparePcm(pcm, rate);
  return harmonicityOfPreparedPcm(prepared.samples, prepared.analysisRate);
}

function frameStatistics(samples, rate) {
  const frameSize = Math.max(64, Math.round(rate * 0.02));
  const hop = Math.max(32, frameSize >> 1);
  const frames = [];
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    let energy = 0;
    let crossings = 0;
    for (let i = start; i < start + frameSize; i++) {
      const value = samples[i];
      energy += value * value;
      if (i > start && ((samples[i - 1] < 0 && value >= 0) || (samples[i - 1] >= 0 && value < 0))) crossings++;
    }
    frames.push({ rms: Math.sqrt(energy / frameSize), zcr: crossings / frameSize });
  }
  if (!frames.length) return { noiseFloorRms: 0, noiseZeroCrossingRate: 0, envelopeVariation: 0 };
  const byEnergy = [...frames].sort((a, b) => a.rms - b.rms);
  const noiseCount = Math.max(1, Math.floor(byEnergy.length * 0.2));
  const noiseFrames = byEnergy.slice(0, noiseCount);
  const rmsValues = frames.map(frame => frame.rms);
  const envelopeMean = mean(rmsValues) || 0;
  const envelopeVariance = mean(rmsValues.map(value => (value - envelopeMean) ** 2)) || 0;
  return {
    noiseFloorRms: quantile(rmsValues, 0.1),
    noiseZeroCrossingRate: mean(noiseFrames.map(frame => frame.zcr)) || 0,
    envelopeVariation: envelopeMean > EPSILON ? Math.sqrt(envelopeVariance) / envelopeMean : 0
  };
}

function profileFrom(observation) {
  if (!observation || typeof observation !== 'object') return null;
  if (observation.profile && typeof observation.profile === 'object') return observation.profile;
  if (observation.channelProfile && typeof observation.channelProfile === 'object') return observation.channelProfile;
  if ('usable' in observation && ('spectralCentroidHz' in observation || 'durationSeconds' in observation)) return observation;
  return null;
}

function dspFrom(observation) {
  if (observation?.metrics && typeof observation.metrics === 'object') return observation.metrics;
  return observation?.dsp && typeof observation.dsp === 'object' ? observation.dsp : {};
}

function compareObservations(current, previous) {
  const currentProfile = profileFrom(current);
  const previousProfile = profileFrom(previous);
  if (!currentProfile?.usable || !previousProfile?.usable) {
    return {
      available: false,
      featureDrift: null,
      noiseContinuity: null,
      noiseFloorChangeDb: null
    };
  }

  const distances = [];
  for (const [key, scale] of Object.entries(PROFILE_SCALES)) {
    const a = valueOf(currentProfile, key);
    const b = valueOf(previousProfile, key);
    if (a !== null && b !== null) distances.push(Math.abs(a - b) / scale);
  }
  const currentDsp = dspFrom(current);
  const previousDsp = dspFrom(previous);
  for (const [key, scale] of [['harmonicity', 0.35], ['crestFactor', 4], ['envelopeVariation', 0.8]]) {
    const a = valueOf(currentDsp, key);
    const b = valueOf(previousDsp, key);
    if (a !== null && b !== null) distances.push(Math.abs(a - b) / scale);
  }
  const featureDrift = distances.length
    ? Math.sqrt(distances.reduce((sum, value) => sum + value * value, 0) / distances.length)
    : null;

  const currentNoise = valueOf(currentDsp, 'noiseFloorRms');
  const previousNoise = valueOf(previousDsp, 'noiseFloorRms');
  const currentNoiseZcr = valueOf(currentDsp, 'noiseZeroCrossingRate');
  const previousNoiseZcr = valueOf(previousDsp, 'noiseZeroCrossingRate');
  const noiseFloorChangeDb = currentNoise !== null && previousNoise !== null
    ? Math.abs(20 * Math.log10((currentNoise + 1e-7) / (previousNoise + 1e-7)))
    : null;
  const zcrChange = currentNoiseZcr !== null && previousNoiseZcr !== null
    ? Math.abs(currentNoiseZcr - previousNoiseZcr)
    : 0;
  const noiseContinuity = noiseFloorChangeDb === null
    ? null
    : Math.exp(-noiseFloorChangeDb / 9) * Math.exp(-zcrChange / 0.08);

  return {
    available: featureDrift !== null,
    featureDrift,
    noiseContinuity: noiseContinuity === null ? null : clamp(noiseContinuity),
    noiseFloorChangeDb
  };
}

/**
 * Extract one bounded rolling observation.
 *
 * Stable observation shape:
 * `{ schemaVersion, sequence, usable, reason, profile, metrics, pcmSummary,
 *    temporal, start, end }`.
 *
 * `start` and `end` are null because raw PCM has no timeline metadata; callers
 * may replace them with finite seconds before classification. `previous` is
 * optional and is used only for a backward-looking comparison. The previous
 * object is never mutated. PCM longer than four seconds is trimmed to its latest
 * four seconds; rates above 16 kHz are reduced for analysis.
 */
export function extractAttackObservation(pcm, rate = 16000, previous = null) {
  const prepared = preparePcm(pcm, rate);
  const profile = channelProfile(prepared.samples, prepared.analysisRate || ATTACK_MODEL_LIMITS.maxSampleRate);
  const crestFactor = computeCrestFactor(prepared.samples);
  const periodicity = harmonicityOfPreparedPcm(prepared.samples, prepared.analysisRate);
  const frames = frameStatistics(prepared.samples, prepared.analysisRate || ATTACK_MODEL_LIMITS.maxSampleRate);
  const acousticSpace = profile.usable
    ? clamp(
      clamp(valueOf(profile, 'reverbProxySeconds', 0) / 0.14) * 0.65 +
      clamp(frames.noiseFloorRms / 0.012) * 0.35
    )
    : 0;

  const sequence = Number.isSafeInteger(previous?.sequence) ? previous.sequence + 1 : 0;
  const observation = {
    schemaVersion: 1,
    sequence,
    usable: Boolean(profile.usable),
    reason: prepared.reason || profile.reason || null,
    profile,
    metrics: {
      crestFactor,
      harmonicity: periodicity.harmonicity,
      harmonicLagMs: periodicity.lagMs,
      noiseFloorRms: frames.noiseFloorRms,
      noiseZeroCrossingRate: frames.noiseZeroCrossingRate,
      envelopeVariation: frames.envelopeVariation,
      acousticSpace
    },
    pcmSummary: {
      sourceSampleRate: prepared.sourceRate,
      sampleRate: prepared.analysisRate,
      sampleCount: prepared.samples.length,
      durationSeconds: prepared.samples.length / Math.max(1, prepared.analysisRate),
      sourceDurationSeconds: prepared.sourceDurationSeconds,
      truncated: prepared.truncated,
      resampled: prepared.resampled
    },
    temporal: null,
    start: null,
    end: null
  };
  const comparison = compareObservations(observation, previous);
  observation.temporal = {
    ...comparison,
    comparedToSequence: comparison.available && Number.isSafeInteger(previous?.sequence)
      ? previous.sequence
      : null
  };
  return observation;
}

function normalizeLabCondition(value) {
  if (typeof value === 'string' && value.trim()) return { label: value.trim() };
  if (!value || typeof value !== 'object') return null;
  const output = {};
  for (const key of ['id', 'label', 'expectedClass', 'notes']) {
    if (typeof value[key] === 'string' && value[key].trim()) output[key] = value[key].trim();
  }
  if (typeof value.simulated === 'boolean') output.simulated = value.simulated;
  return Object.keys(output).length ? output : null;
}

function aggregateObservations(observations) {
  const list = (Array.isArray(observations) ? observations : observations ? [observations] : [])
    .slice(-ATTACK_MODEL_LIMITS.maxRollingWindows);
  const usable = list.filter(observation => profileFrom(observation)?.usable);
  const profiles = usable.map(profileFrom);
  const dsp = usable.map(dspFrom);
  const transitions = [];
  for (let i = 1; i < usable.length; i++) {
    const comparison = compareObservations(usable[i], usable[i - 1]);
    if (comparison.available) transitions.push(comparison);
  }

  const field = key => profiles.map(profile => {
    if (key === 'reverbProxySeconds') {
      return valueOf(profile, 'reverbProxySeconds', valueOf(profile, 'reverbProxy'));
    }
    return valueOf(profile, key);
  });
  const dspField = key => dsp.map(features => valueOf(features, key));
  const durations = usable.map((observation, index) => clamp(
    valueOf(observation?.pcmSummary, 'durationSeconds',
      valueOf(observation?.analysis, 'durationSeconds',
        valueOf(profiles[index], 'durationSeconds', 0))),
    0,
    ATTACK_MODEL_LIMITS.maxWindowSeconds
  ));
  const speech = profiles.map((profile, index) => clamp(
    valueOf(profile, 'speechSeconds', 0),
    0,
    durations[index] || ATTACK_MODEL_LIMITS.maxWindowSeconds
  ));

  const features = {
    reverbProxySeconds: mean(field('reverbProxySeconds')),
    highBandRatio: mean(field('highBandRatio')),
    narrowbandShare: mean(profiles.map(profile => {
      if (profile.narrowband === true) return 1;
      if (profile.narrowband === false) return 0;
      const highBand = valueOf(profile, 'highBandRatio');
      return highBand === null ? null : highBand < 0.01 ? 1 : 0;
    })),
    clippingRatio: mean(field('clippingRatio')),
    spectralFlatness: mean(field('spectralFlatness')),
    spectralCentroidHz: mean(field('spectralCentroidHz')),
    spectralTiltDb: mean(field('spectralTiltDb')),
    zeroCrossingRate: mean(field('zeroCrossingRate')),
    snrDb: mean(field('snrDb')),
    silenceRatio: mean(field('silenceRatio')),
    crestFactor: mean(dspField('crestFactor')),
    harmonicity: mean(dspField('harmonicity')),
    noiseFloorRms: mean(dspField('noiseFloorRms')),
    envelopeVariation: mean(dspField('envelopeVariation')),
    acousticSpace: mean(dsp.map((features, index) =>
      valueOf(features, 'acousticSpace', valueOf(profiles[index], 'acousticSpace'))
    )),
    featureDrift: mean(transitions.map(item => item.featureDrift)),
    maximumFeatureDrift: transitions.length ? Math.max(...transitions.map(item => item.featureDrift)) : null,
    noiseContinuity: mean(transitions.map(item => item.noiseContinuity)),
    maximumNoiseFloorChangeDb: transitions.length
      ? Math.max(...transitions.map(item => item.noiseFloorChangeDb || 0))
      : null,
    highBandRange: range(field('highBandRatio')),
    reverbRange: range(field('reverbProxySeconds')),
    snrRange: range(field('snrDb')),
    centroidRangeHz: range(field('spectralCentroidHz'))
  };

  return {
    list,
    usable,
    profiles,
    features,
    transitionCount: transitions.length,
    summedAudioSeconds: durations.reduce((sum, value) => sum + value, 0),
    summedSpeechSeconds: speech.reduce((sum, value) => sum + value, 0),
    longEnoughWindows: durations.filter(value => value >= ATTACK_MODEL_LIMITS.minimumWindowSeconds).length
  };
}

function addContradiction(list, code, detail, classes, severe = false) {
  if (!list.some(item => item.code === code)) list.push({ code, detail, classes, severe });
}

/**
 * Rank attack-path hypotheses from rolling observations and capture provenance.
 *
 * Stable primary result shape:
 * `{ classes, uncertainty, sufficientEvidence, topClass, margin, evidence,
 *    contradictions, coverageSeconds }`. Each class entry has
 * `{ support, explanation, evidence, counterEvidence }`. Supplemental diagnostic
 * fields are versioned by `schemaVersion`.
 *
 * `observations` accepts extractor results, `{ profile, metrics, pcmSummary }`
 * objects, legacy `{ channelProfile, dsp, analysis }` objects, or bare
 * `channelProfile` results. A lab label is metadata only and never changes
 * scores. Capture kinds are microphone, shared-audio, and digital-file.
 */
export function classifyAttackPath(observations, context = {}) {
  const aggregate = aggregateObservations(observations);
  const captureKind = ['microphone', 'shared-audio', 'digital-file'].includes(context?.captureKind)
    ? context.captureKind
    : 'unknown';
  const knownSource = context?.knownSource === true;
  const labCondition = normalizeLabCondition(context?.labCondition);
  const provenanceEstablished = captureKind === 'digital-file' && knownSource;

  const raw = Object.fromEntries(ATTACK_CLASSES.map(label => [label, 1]));
  const explanations = Object.fromEntries(ATTACK_CLASSES.map(label => [label, { supports: [], against: [] }]));
  const cueCounts = Object.fromEntries(ATTACK_CLASSES.map(label => [label, 0]));
  const contradictions = [];
  const support = (label, amount, detail) => {
    raw[label] += amount;
    cueCounts[label]++;
    explanations[label].supports.push(detail);
  };
  const oppose = (label, amount, detail) => {
    raw[label] = Math.max(0.05, raw[label] - amount);
    explanations[label].against.push(detail);
  };

  if (captureKind === 'microphone') {
    support('live-human', 1.15, 'Microphone provenance is compatible with a person speaking into the capture path.');
    support('speaker-replay', 1.05, 'Microphone provenance is also compatible with a loudspeaker being recaptured.');
    oppose('direct-injection', 0.45, 'A microphone path contradicts a purely direct digital route.');
    oppose('live-voice-conversion', 0.25, 'Microphone capture alone does not establish live conversion.');
  } else if (captureKind === 'shared-audio') {
    support('direct-injection', 0.95, 'Shared-audio provenance supports a direct software audio route.');
    support('live-voice-conversion', 0.90, 'Shared-audio provenance is compatible with live voice processing.');
    support('live-human', 0.10, 'A shared stream can still originate from live human speech.');
    support('speaker-replay', 0.05, 'A shared stream can contain a previously recaptured recording.');
  } else if (captureKind === 'digital-file') {
    support('direct-injection', knownSource ? 18 : 2.0,
      knownSource
        ? 'Capture metadata identifies a known digital-file route; this path fact outweighs acoustic resemblance.'
        : 'Digital-file capture strongly supports a direct route, although its upstream origin is not known.');
    oppose('live-human', knownSource ? 0.8 : 0.35, 'A file is not contemporaneous microphone capture.');
    oppose('speaker-replay', knownSource ? 0.7 : 0.2, 'Direct file provenance does not require loudspeaker recapture.');
  } else {
    for (const label of ATTACK_CLASSES) explanations[label].against.push('Capture provenance is unavailable.');
  }

  const f = aggregate.features;
  if (aggregate.usable.length) {
    const reverb = f.reverbProxySeconds ?? 0;
    const acoustic = f.acousticSpace ?? clamp(reverb / 0.14);
    if (reverb >= 0.055 || acoustic >= 0.58) {
      support('speaker-replay', 0.95, 'Sustained decay or background-space measurements support an acoustic recapture path.');
      support('live-human', 0.25, 'The same acoustic-space evidence is also compatible with ordinary microphone speech.');
      oppose('direct-injection', 0.25, 'Strong acoustic-space evidence weighs against a clean direct route.');
    } else if (reverb >= 0.012 || acoustic >= 0.20) {
      support('live-human', 0.48, 'Moderate room or background evidence is compatible with live microphone speech.');
      support('speaker-replay', 0.30, 'Moderate room evidence is also compatible with loudspeaker recapture.');
    } else {
      support('direct-injection', 0.42, 'Little measured decay or background space is compatible with a clean digital route.');
      support('live-voice-conversion', 0.16, 'A low-space signal is compatible with software processing, but is not specific to it.');
    }

    if ((f.narrowbandShare ?? 0) >= 0.5 || (f.highBandRatio ?? 1) < 0.009) {
      support('speaker-replay', 0.62, 'Repeated high-band loss or narrowband measurements support coloration in a replay path.');
      support('direct-injection', 0.12, 'A band-limited codec can also occur on a direct route.');
      oppose('live-human', 0.16, 'Persistent high-band loss weakens support for an uncolored live microphone path.');
    } else if ((f.highBandRatio ?? 0) > 0.025) {
      support('live-human', 0.28, 'Retained high-band energy is compatible with wideband live speech.');
      support('direct-injection', 0.30, 'Retained high-band energy is also compatible with a clean digital source.');
      oppose('speaker-replay', 0.10, 'Wideband energy provides weak counter-evidence to strongly colored replay.');
    }

    if ((f.clippingRatio ?? 0) > 0.015) {
      support('speaker-replay', 0.22, 'Clipping is compatible with loudspeaker, microphone, or gain-stage overload.');
      support('direct-injection', 0.14, 'Clipping can also be introduced in a digital gain stage.');
      support('live-voice-conversion', 0.08, 'Clipping can occur in a processing chain but is not a conversion signature.');
      addContradiction(
        contradictions,
        'clipping-obscures-features',
        'Clipping can create spectral cues used elsewhere in this ranking.',
        ['speaker-replay', 'direct-injection', 'live-voice-conversion']
      );
    } else {
      support('live-human', 0.12, 'Low clipping leaves ordinary speech dynamics intact.');
    }

    if ((f.spectralFlatness ?? 0) >= 0.12) {
      support('live-human', 0.20, 'Broadband/noise-like energy is compatible with an acoustic microphone environment.');
      support('speaker-replay', 0.20, 'Broadband/noise-like energy is also compatible with acoustic recapture.');
    } else if ((f.spectralFlatness ?? 1) < 0.018 && (f.harmonicity ?? 0) > 0.78) {
      support('live-voice-conversion', 0.25, 'Strong periodicity with a smooth spectrum is a weak processing proxy only.');
      support('direct-injection', 0.20, 'Clean generated or studio speech can share the same smooth, periodic spectrum.');
      explanations['live-voice-conversion'].against.push('This proxy is not validated as a voice-conversion detector.');
    } else {
      support('live-human', 0.16, 'Mixed harmonic and noise-like energy is compatible with ordinary voiced speech.');
    }

    if ((f.spectralTiltDb ?? 0) > 11 || (f.spectralCentroidHz ?? Infinity) < 1150) {
      support('speaker-replay', 0.50, 'Low centroid or steep spectral tilt supports loudspeaker or channel coloration.');
      oppose('live-human', 0.10, 'Strong coloration weakens support for an uncolored microphone signal.');
    } else if ((f.spectralCentroidHz ?? 0) > 2300 && (f.spectralTiltDb ?? Infinity) < 7) {
      support('direct-injection', 0.26, 'A high centroid with modest tilt is compatible with a clean wideband route.');
      support('live-human', 0.16, 'A wideband microphone can produce the same spectral balance.');
    }

    const coloredPath =
      (f.narrowbandShare ?? 0) >= 0.5 ||
      (f.spectralTiltDb ?? 0) > 11 ||
      (f.spectralCentroidHz ?? Infinity) < 1150;
    if (
      captureKind === 'microphone' &&
      coloredPath &&
      ((f.reverbProxySeconds ?? 0) >= 0.018 || (f.acousticSpace ?? 0) >= 0.16)
    ) {
      support(
        'speaker-replay',
        0.75,
        'On a microphone path, combined acoustic-space and coloration cues support the replay hypothesis more than either cue alone.'
      );
    }

    if ((f.zeroCrossingRate ?? 0) > 0.15 && (f.spectralFlatness ?? 0) > 0.08) {
      support('live-human', 0.15, 'High zero-crossing and broadband energy are compatible with fricatives or room noise.');
      support('speaker-replay', 0.12, 'Acoustic replay can preserve or add the same high-frequency crossings.');
    } else if ((f.zeroCrossingRate ?? 1) < 0.035 && (f.harmonicity ?? 0) > 0.82) {
      support('live-voice-conversion', 0.15, 'Very periodic low-crossing audio is a weak smoothing proxy, not a validated artifact.');
      support('direct-injection', 0.12, 'Clean voiced digital audio can produce the same low-crossing pattern.');
    }

    if ((f.snrDb ?? 0) > 34) {
      support('direct-injection', 0.42, 'Very high measured SNR is compatible with clean digital audio.');
      support('live-voice-conversion', 0.14, 'Software-processed audio can also have high measured SNR.');
      explanations['live-human'].against.push('Very high measured SNR supplies little evidence of an acoustic background.');
    } else if ((f.snrDb ?? 0) >= 12) {
      support('live-human', 0.25, 'Moderate measured SNR is compatible with usable microphone speech.');
      support('speaker-replay', 0.18, 'Moderate measured SNR is also compatible with replay in a quiet room.');
    } else {
      support('live-human', 0.10, 'Low measured SNR is compatible with a noisy microphone environment.');
      support('speaker-replay', 0.10, 'Low measured SNR is also compatible with noisy recapture.');
    }

    if ((f.silenceRatio ?? 0) >= 0.12 && (f.silenceRatio ?? 1) <= 0.72) {
      support('live-human', 0.25, 'Speech/silence modulation is compatible with natural turn fragments.');
      support('speaker-replay', 0.16, 'Recorded speech can preserve the same speech/silence modulation.');
    } else if ((f.silenceRatio ?? 1) < 0.06) {
      support('direct-injection', 0.16, 'Nearly continuous activity is compatible with a prepared digital stream.');
      support('live-voice-conversion', 0.08, 'Continuous activity is compatible with processing but is not specific to it.');
    }

    if ((f.crestFactor ?? 0) >= 2.1 && (f.crestFactor ?? Infinity) <= 8.5) {
      support('live-human', 0.16, 'The measured crest factor is compatible with ordinary speech dynamics.');
      support('speaker-replay', 0.10, 'Replay can preserve similar speech dynamics.');
    } else if ((f.crestFactor ?? Infinity) < 1.8) {
      support('live-voice-conversion', 0.12, 'Low crest factor is a weak limiting or smoothing cue.');
      support('direct-injection', 0.10, 'Digital limiting can produce the same low crest factor.');
    }

    if (aggregate.transitionCount) {
      if ((f.featureDrift ?? 0) >= 0.07 && (f.featureDrift ?? Infinity) <= 0.52) {
        support('live-human', 0.48, 'Moderate feature drift across earlier-to-later windows supports natural variation.');
        support('speaker-replay', 0.24, 'A replayed utterance can retain similar temporal variation.');
      } else if ((f.featureDrift ?? Infinity) < 0.045) {
        support('direct-injection', 0.36, 'Very stable features across windows support a fixed digital chain.');
        support('live-voice-conversion', 0.25, 'A fixed processing chain can also produce stable features.');
      }

      if ((f.noiseContinuity ?? 0) > 0.72 && (f.noiseFloorRms ?? 0) > 0.0014) {
        support('live-human', 0.30, 'A continuous measurable noise floor supports one persistent acoustic capture path.');
        support('speaker-replay', 0.26, 'The same continuous noise floor is compatible with persistent replay recapture.');
      } else if ((f.noiseContinuity ?? 0) > 0.78 && (f.noiseFloorRms ?? Infinity) < 0.0007) {
        support('direct-injection', 0.30, 'A stable, very low noise floor supports a clean digital path.');
      } else if ((f.noiseContinuity ?? 1) < 0.28) {
        support('live-voice-conversion', 0.14, 'Discontinuous noise statistics weakly support a changing processing path.');
        support('speaker-replay', 0.12, 'Changing room or playback noise can produce the same discontinuity.');
      }
    }
  }

  if (!aggregate.usable.length) {
    for (const label of ATTACK_CLASSES) {
      explanations[label].against.push('No usable channel profile is available for signal support.');
    }
  }

  const mixedBandwidth =
    (f.narrowbandShare ?? 0) > 0 &&
    (f.narrowbandShare ?? 0) < 1 &&
    f.highBandRange > 0.02;
  if (mixedBandwidth) {
    addContradiction(
      contradictions,
      'bandwidth-changes-across-windows',
      'High-band evidence changes substantially across rolling windows.',
      ATTACK_CLASSES,
      true
    );
  }
  if (f.reverbRange > 0.11) {
    addContradiction(
      contradictions,
      'acoustic-space-changes-across-windows',
      'Reverberation evidence changes substantially across rolling windows.',
      ['live-human', 'direct-injection', 'speaker-replay'],
      true
    );
  }
  if (f.snrRange > 34 || (f.maximumNoiseFloorChangeDb ?? 0) > 32) {
    addContradiction(
      contradictions,
      'noise-path-changes-across-windows',
      'SNR or noise-floor continuity changes too much for one stable-path interpretation.',
      ATTACK_CLASSES,
      true
    );
  }
  if ((f.maximumFeatureDrift ?? 0) > 1.8 || f.centroidRangeHz > 3200) {
    addContradiction(
      contradictions,
      'feature-regime-change',
      'At least one adjacent window belongs to a substantially different feature regime.',
      ATTACK_CLASSES,
      true
    );
  }
  if (captureKind === 'microphone' && (f.acousticSpace ?? 0) < 0.08 && (f.snrDb ?? 0) > 38) {
    addContradiction(
      contradictions,
      'microphone-with-digital-cleanliness',
      'Declared microphone provenance conflicts with very clean, low-space signal cues.',
      ['live-human', 'direct-injection']
    );
  }
  if (captureKind === 'shared-audio') {
    addContradiction(
      contradictions,
      'shared-route-ambiguity',
      'Shared audio does not by itself separate direct injection from live voice conversion.',
      ['direct-injection', 'live-voice-conversion']
    );
  }

  const observed = {
    receivedWindows: aggregate.list.length,
    usableWindows: aggregate.usable.length,
    longEnoughWindows: aggregate.longEnoughWindows,
    summedAudioSeconds: rounded(aggregate.summedAudioSeconds),
    summedSpeechSeconds: rounded(aggregate.summedSpeechSeconds),
    transitions: aggregate.transitionCount
  };
  const minimumRequirements = {
    windowSeconds: ATTACK_MODEL_LIMITS.minimumWindowSeconds,
    windows: ATTACK_MODEL_LIMITS.minimumWindows,
    summedAudioSeconds: ATTACK_MODEL_LIMITS.minimumSummedAudioSeconds,
    summedSpeechSeconds: ATTACK_MODEL_LIMITS.minimumSummedSpeechSeconds,
    transitions: ATTACK_MODEL_LIMITS.minimumTransitions
  };

  const coverageParts = [
    observed.longEnoughWindows / minimumRequirements.windows,
    observed.summedAudioSeconds / minimumRequirements.summedAudioSeconds,
    observed.summedSpeechSeconds / minimumRequirements.summedSpeechSeconds,
    observed.transitions / minimumRequirements.transitions
  ].map(value => clamp(value));
  const coverage = mean(coverageParts) || 0;
  const snrQuality = aggregate.usable.length ? clamp(((f.snrDb ?? 0) - 3) / 25) : 0;
  const clippingQuality = aggregate.usable.length ? 1 - clamp((f.clippingRatio ?? 0) / 0.06) : 0;
  const signalQuality = aggregate.usable.length ? 0.6 * snrQuality + 0.4 * clippingQuality : 0;
  const evidenceQuality = clamp(coverage * 0.72 + signalQuality * 0.28);
  const signalRequirementsMet =
    observed.longEnoughWindows >= minimumRequirements.windows &&
    observed.summedAudioSeconds >= minimumRequirements.summedAudioSeconds &&
    observed.summedSpeechSeconds >= minimumRequirements.summedSpeechSeconds &&
    observed.transitions >= minimumRequirements.transitions &&
    signalQuality >= 0.3;
  const sufficientEvidence = provenanceEstablished || signalRequirementsMet;

  const supportScores = normalizeSupports(raw);
  const ranking = ATTACK_CLASSES
    .map(label => ({ label, support: supportScores[label] }))
    .sort((a, b) => b.support - a.support || ATTACK_CLASSES.indexOf(a.label) - ATTACK_CLASSES.indexOf(b.label));
  const margin = rounded(ranking[0].support - ranking[1].support);
  const ambiguity = 1 - clamp(margin / 0.34);
  const severeContradiction = contradictions.some(item => item.severe);
  let uncertainty = clamp(
    0.52 * ambiguity +
    0.32 * (1 - evidenceQuality) +
    (captureKind === 'shared-audio' ? 0.10 : captureKind === 'unknown' ? 0.12 : 0) +
    Math.min(0.12, contradictions.length * 0.025)
  );
  if (!sufficientEvidence) uncertainty = Math.max(uncertainty, 0.66);
  if (severeContradiction) uncertainty = Math.max(uncertainty, 0.74);
  if (ranking[0].label === 'live-voice-conversion') uncertainty = Math.max(uncertainty, 0.48);
  if (provenanceEstablished) uncertainty = severeContradiction ? 0.16 : 0.08;
  uncertainty = rounded(uncertainty);

  let requiredTopSupport = ATTACK_MODEL_LIMITS.minimumTopSupport;
  let requiredMargin = ATTACK_MODEL_LIMITS.minimumDecisionMargin;
  let maximumUncertainty = ATTACK_MODEL_LIMITS.maximumDecisionUncertainty;
  if (ranking[0].label === 'speaker-replay') {
    requiredTopSupport = 0.42;
    requiredMargin = 0.09;
  } else if (ranking[0].label === 'direct-injection') {
    requiredTopSupport = 0.43;
    requiredMargin = captureKind === 'shared-audio' ? 0.16 : 0.10;
  } else if (ranking[0].label === 'live-voice-conversion') {
    requiredTopSupport = 0.52;
    requiredMargin = 0.18;
    maximumUncertainty = 0.42;
  }

  const voiceConversionEvidenceMet = ranking[0].label !== 'live-voice-conversion' ||
    (captureKind === 'shared-audio' && aggregate.usable.length >= 5 && cueCounts['live-voice-conversion'] >= 5);
  const decisionClear = provenanceEstablished || (
    sufficientEvidence &&
    captureKind !== 'unknown' &&
    !severeContradiction &&
    ranking[0].support >= requiredTopSupport &&
    margin >= requiredMargin &&
    uncertainty <= maximumUncertainty &&
    voiceConversionEvidenceMet
  );
  const topClass = decisionClear ? ranking[0].label : 'uncertain';

  if (!decisionClear) {
    const detail = captureKind === 'unknown'
      ? 'A supported capture kind is required before selecting a leading path.'
      : !sufficientEvidence
      ? 'Minimum rolling evidence is not met.'
      : severeContradiction
        ? 'Rolling windows contain contradictory feature regimes.'
        : ranking[0].label === 'live-voice-conversion' && !voiceConversionEvidenceMet
          ? 'Voice-conversion support lacks enough independent, repeated cues.'
          : 'The leading support, margin, or uncertainty threshold is not clear.';
    explanations[ranking[0].label].against.push(detail);
  }
  for (const label of ATTACK_CLASSES) {
    if (!explanations[label].supports.length) explanations[label].supports.push('No class-specific signal cue increased this hypothesis.');
  }
  const classes = Object.fromEntries(ATTACK_CLASSES.map(label => {
    const positive = explanations[label].supports;
    const counter = explanations[label].against;
    const explanation = counter.length
      ? `${positive[0]} Counter-evidence: ${counter[0]}`
      : positive[0];
    return [label, {
      support: supportScores[label],
      explanation,
      evidence: [...positive],
      counterEvidence: [...counter]
    }];
  }));
  const evidence = ATTACK_CLASSES.flatMap(label => [
    ...explanations[label].supports
      .filter(detail => detail !== 'No class-specific signal cue increased this hypothesis.')
      .map(detail => ({ class: label, direction: 'support', detail })),
    ...explanations[label].against
      .map(detail => ({ class: label, direction: 'counter', detail }))
  ]);

  return {
    schemaVersion: 2,
    model: 'rolling-dsp-attack-hypotheses-v1',
    classes,
    topClass,
    margin,
    uncertainty,
    sufficientEvidence,
    evidence,
    contradictions,
    coverageSeconds: observed.summedAudioSeconds,
    // Supplemental diagnostics retained outside the stable UI-facing fields.
    supportScores,
    minimumRequirements,
    explanations,
    evidenceSummary: {
      minimumRequirements,
      observed,
      evidenceQuality: rounded(evidenceQuality),
      provenanceOverride: provenanceEstablished
    },
    featureSummary: Object.fromEntries(
      Object.entries(f).map(([key, value]) => [key, finite(value) ? rounded(value) : null])
    ),
    context: { captureKind, knownSource },
    labCondition,
    supportSemantics: 'Relative normalized display support from overlapping heuristic cues; not a calibrated class likelihood.',
    limitations: [
      'DSP cues overlap across real rooms, devices, codecs and processing chains.',
      'Shared audio is intrinsically ambiguous between direct routing and live processing.',
      'Voice-conversion artifacts are not treated as decisive without repeated converging evidence.',
      'A lab-condition label is metadata only and never contributes to support.',
      'Summed window duration can include overlap; callers should provide genuinely sequential windows.',
      'This synthetic-calibrated hypothesis model has no measured field error rate.'
    ],
    thresholds: {
      topSupport: requiredTopSupport,
      margin: requiredMargin,
      maximumUncertainty,
      voiceConversionMinimumWindows: 5,
      voiceConversionMinimumCues: 5
    }
  };
}
