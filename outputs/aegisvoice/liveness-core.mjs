// Channel profiling and liveness fusion. Pure DSP: no model weights, no network.
//
// The profiler measures the conditions a decision is being made under. Channel
// features are never treated as evidence that speech is synthetic or replayed on
// their own; they bound how far the other evidence can be trusted, and they let
// us ask whether a challenge reply arrived over the same acoustic path as the
// rest of the call.

// Minimal in-place radix-2 FFT. Used only for spectral summary statistics.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const xr = re[i + k + half], xi = im[i + k + half];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        const ur = re[i + k], ui = im[i + k];
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const FRAME = 512, HOP = 256;

function spectra(pcm) {
  const window = new Float64Array(FRAME);
  for (let i = 0; i < FRAME; i++) window[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FRAME - 1));
  const out = [];
  for (let start = 0; start + FRAME <= pcm.length; start += HOP) {
    const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    for (let i = 0; i < FRAME; i++) re[i] = pcm[start + i] * window[i];
    fft(re, im);
    const bins = new Float64Array(FRAME / 2 + 1);
    for (let i = 0; i < bins.length; i++) bins[i] = re[i] * re[i] + im[i] * im[i];
    out.push(bins);
  }
  return out;
}

/** Measure the acoustic conditions of a PCM buffer. Never a synthesis verdict. */
export function channelProfile(pcm, rate = 16000) {
  const n = pcm.length;
  if (!n) return { usable: false, reason: 'No audio', speechSeconds: 0 };
  let peak = 0, energy = 0, clipped = 0, crossings = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm[i], a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.985) clipped++;
    energy += v * v;
    if (i && ((pcm[i - 1] < 0 && v >= 0) || (pcm[i - 1] >= 0 && v < 0))) crossings++;
  }
  const rms = Math.sqrt(energy / n);
  const frames = spectra(pcm);
  if (frames.length < 3 || rms < 1e-5) {
    return { usable: false, reason: 'Insufficient audible speech', rms, peak, speechSeconds: 0,
             clippingRatio: clipped / n, durationSeconds: n / rate };
  }
  const frameEnergy = frames.map(f => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i]; return s; });
  const sorted = [...frameEnergy].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] || 1e-12;
  const loud = sorted[Math.floor(sorted.length * 0.95)] || 1e-12;
  const gate = Math.max(loud * 0.02, noiseFloor * 2);
  const speech = frames.filter((_, i) => frameEnergy[i] > gate);
  const speechSeconds = speech.length * HOP / rate;
  const snrDb = 10 * Math.log10(Math.max(loud, 1e-12) / Math.max(noiseFloor, 1e-12));

  const bins = frames[0].length;
  const mean = new Float64Array(bins);
  for (const f of (speech.length ? speech : frames)) for (let i = 0; i < bins; i++) mean[i] += f[i];
  const count = (speech.length ? speech : frames).length;
  for (let i = 0; i < bins; i++) mean[i] /= count;

  let total = 0, weighted = 0, logSum = 0;
  for (let i = 0; i < bins; i++) { total += mean[i]; weighted += mean[i] * i; logSum += Math.log(Math.max(mean[i], 1e-20)); }
  total = total || 1e-12;
  const nyquist = rate / 2;
  const centroid = (weighted / total) * nyquist / (bins - 1);
  const flatness = Math.exp(logSum / bins) / (total / bins);
  // Upper band edge: highest smoothed bin still within 35 dB of the spectral peak.
  // Cumulative rolloff is skewed by broadband noise tails and cannot see band-limiting.
  let peakBin = 0;
  for (let i = 0; i < bins; i++) if (mean[i] > peakBin) peakBin = mean[i];
  const edgeFloor = peakBin * 3.162e-4;
  let edge = 0;
  for (let i = 1; i < bins - 1; i++) {
    if ((mean[i - 1] + mean[i] + mean[i + 1]) / 3 > edgeFloor) edge = i;
  }
  const bandwidth = edge * nyquist / (bins - 1);
  // Share of energy above 4 kHz. This separates telephone-band or decimated audio
  // from wideband capture far more reliably than any single band-edge estimate.
  const cutBin = Math.min(bins - 1, Math.round(4000 * (bins - 1) / nyquist));
  let highBand = 0;
  for (let i = cutBin; i < bins; i++) highBand += mean[i];
  const highBandRatio = highBand / total;

  // Low-band vs high-band tilt separates wideband microphone audio from
  // telephone-band or loudspeaker-reproduced audio.
  let low = 0, high = 0;
  const split = Math.floor(bins * 0.25);
  for (let i = 0; i < bins; i++) (i < split ? (low += mean[i]) : (high += mean[i]));
  const tilt = 10 * Math.log10(Math.max(low, 1e-20) / Math.max(high, 1e-20));

  // Energy decay after speech offsets is a coarse reverberation proxy.
  let decays = 0, decaySum = 0;
  for (let i = 1; i < frameEnergy.length; i++) {
    if (frameEnergy[i - 1] > gate && frameEnergy[i] <= gate) {
      let j = i, floorHit = 0;
      while (j < frameEnergy.length && j - i < 40 && frameEnergy[j] > noiseFloor * 2) { floorHit = j - i; j++; }
      decaySum += floorHit * HOP / rate; decays++;
    }
  }
  return {
    usable: true, durationSeconds: n / rate, rms, peak,
    clippingRatio: clipped / n,
    zeroCrossingRate: crossings / n,
    snrDb, speechSeconds,
    silenceRatio: 1 - speech.length / frames.length,
    spectralCentroidHz: centroid, spectralFlatness: flatness,
    effectiveBandwidthHz: bandwidth, spectralTiltDb: tilt, highBandRatio,
    reverbProxySeconds: decays ? decaySum / decays : 0,
    narrowband: highBandRatio < 0.01,
    sampleRate: rate
  };
}

const AXES = [
  ['spectralCentroidHz', 1200], ['highBandRatio', 0.08], ['spectralTiltDb', 8],
  ['spectralFlatness', 0.18], ['snrDb', 14], ['reverbProxySeconds', 0.25], ['zeroCrossingRate', 0.05]
];

/** Normalized distance between two channel profiles. 0 is identical, 1+ is very different. */
export function profileDistance(a, b) {
  if (!a?.usable || !b?.usable) return null;
  let sum = 0, used = 0;
  const axes = {};
  for (const [key, scale] of AXES) {
    if (typeof a[key] !== 'number' || typeof b[key] !== 'number') continue;
    const d = Math.abs(a[key] - b[key]) / scale;
    axes[key] = d; sum += d * d; used++;
  }
  if (!used) return null;
  return { distance: Math.sqrt(sum / used), axes };
}

export const LIVENESS_THRESHOLDS = {
  // Chosen from tools/calibrate-channel.mjs, recorded in models/channel_calibration.json.
  // channelMismatch sits above the worst measured same-path distance so an unchanged
  // path is not falsely reported as mismatched. Measured overlap between mild replay
  // and a noisy same path means this is NOT a replay detector.
  channelMatch: 0.35, channelMismatch: 0.60, minReliability: 0.5, minSpeechSeconds: 0.6
};

/**
 * Fuse challenge-response, replay evidence and acoustic continuity into one
 * liveness judgement.
 *
 * Invariants:
 *  - Replay evidence is counter-evidence and is never cleared by a correct phrase.
 *  - Operator-marked timing is recorded but never decides the outcome.
 *  - No combination establishes identity.
 *  - Weak or missing evidence lowers reliability and withholds a confident claim
 *    rather than defaulting to "live".
 */
export function assessLiveness({
  outcome = null, expired = false, replay = null, intervalMs = null,
  replyProfile = null, callProfile = null
} = {}) {
  const replayStatus = replay?.status || null;
  const reasonCodes = [];
  if (outcome) reasonCodes.push(`phrase_${outcome.toLowerCase()}`);
  if (expired) reasonCodes.push('challenge_expired');
  if (!replayStatus) reasonCodes.push('no_replay_evidence');
  else reasonCodes.push(`replay_${replayStatus.toLowerCase().replace(/[^a-z]+/g, '_')}`);

  let reliability = 1;
  if (!replayStatus) reliability -= 0.15;
  if (replyProfile && !replyProfile.usable) { reliability -= 0.45; reasonCodes.push('reply_audio_unusable'); }
  if (replyProfile?.usable) {
    if (replyProfile.speechSeconds < LIVENESS_THRESHOLDS.minSpeechSeconds) { reliability -= 0.3; reasonCodes.push('short_reply'); }
    if (replyProfile.snrDb < 10) { reliability -= 0.2; reasonCodes.push('low_snr'); }
    if (replyProfile.clippingRatio > 0.01) { reliability -= 0.15; reasonCodes.push('clipping'); }
  } else if (!replyProfile) {
    reliability -= 0.1; reasonCodes.push('no_reply_audio');
  }

  // Acoustic continuity: did the reply arrive over the same path as the call?
  const continuity = profileDistance(replyProfile, callProfile);
  let channelState = 'not compared';
  if (continuity) {
    if (continuity.distance <= LIVENESS_THRESHOLDS.channelMatch) { channelState = 'consistent'; reasonCodes.push('channel_consistent'); }
    else if (continuity.distance >= LIVENESS_THRESHOLDS.channelMismatch) { channelState = 'mismatched'; reasonCodes.push('channel_mismatch'); reliability -= 0.2; }
    else { channelState = 'partial'; reasonCodes.push('channel_partial'); reliability -= 0.1; }
  }
  reliability = Math.max(0, Math.min(1, reliability));

  let state = 'Not established', support = 'none';
  let reason = 'No response has been checked against a fresh phrase, so liveness cannot be assessed.';

  if (replayStatus === 'Replay-like') {
    state = 'Replay-suspected'; support = 'counter-evidence';
    reason = 'The trained replay classifier found replay-like evidence in the reply. A correct phrase does not clear this.';
  } else if (expired) {
    reason = 'The challenge expired before a response was checked. Issue a fresh phrase and retry.';
  } else if (outcome === 'Incorrect') {
    support = 'failed-phrase';
    reason = 'The response did not match the fresh phrase. This can also be a misheard phrase or a transcription error, so it is not proof of synthetic or replayed speech.';
  } else if (outcome === 'Completed') {
    if (!replyProfile) {
      support = 'phrase-only';
      reason = 'The entered words match. No recorded reply was assessed, so voice liveness is not established.';
    } else if (!replyProfile.usable) {
      support = 'insufficient-reliability';
      reason = 'The words match, but the recorded reply is not usable audio evidence. Liveness is not established.';
    } else if (channelState === 'mismatched') {
      state = 'Not established'; support = 'channel-mismatch';
      reason = 'The words match, but the channel statistics differ. A codec, microphone or room change can also cause this; verify independently.';
    } else if (reliability < LIVENESS_THRESHOLDS.minReliability) {
      state = 'Not established'; support = 'insufficient-reliability';
      reasonCodes.push('insufficient_reliability');
      reason = 'The phrase was returned correctly, but the supporting audio evidence is too weak to claim a live response under these conditions.';
    } else {
      state = 'Live-consistent';
      support = replayStatus === 'Genuine-like'
        ? (channelState === 'consistent' ? 'phrase-audio-and-channel' : 'phrase-and-audio')
        : (channelState === 'consistent' ? 'phrase-and-channel' : 'phrase-only');
      reason = support === 'phrase-only'
        ? 'A phrase issued during this call was returned correctly, but no supporting replay evidence is available.'
        : 'A phrase issued during this call was returned correctly, with supporting acoustic evidence.';
    }
  }

  return {
    state, support, reason, reasonCodes, replayStatus, intervalMs,
    reliability,
    channel: { state: channelState, distance: continuity?.distance ?? null, axes: continuity?.axes ?? null },
    replyProfile, callProfile,
    timingUsed: false,
    identity: 'Not established',
    covers: 'Phrase comparison and limited replay/channel evidence only; no measured liveness guarantee.',
    doesNotCover: 'Real-time voice conversion or live synthesis, caller identity, and authority to make the request.',
    thresholds: LIVENESS_THRESHOLDS,
    calibrated: false,
    engine: 'Challenge-response, replay and channel-continuity fusion v0.2'
  };
}
