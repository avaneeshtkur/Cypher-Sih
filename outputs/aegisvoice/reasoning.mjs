// Turns an assessment into an ordered, human-readable chain of reasoning steps.
//
// Every step states what was observed, what was concluded, and how much it
// mattered. Steps that argue AGAINST an alert are kept, because a trace that only
// shows incriminating evidence is not an explanation. Nothing here re-decides
// anything: the trace explains the decision the engine already made.

import { categories } from './engine.mjs';
import { displayRuleState } from './decision.mjs';

export const STAGES = {
  capture:   { label: 'CAPTURE',   tone: 'neutral' },
  transcribe:{ label: 'TRANSCRIBE',tone: 'neutral' },
  language:  { label: 'LANGUAGE',  tone: 'neutral' },
  rule:      { label: 'RULE',      tone: 'alert'   },
  action:    { label: 'REQUEST',   tone: 'alert'   },
  safeguard: { label: 'SAFEGUARD', tone: 'safe'    },
  exclusion: { label: 'EXCLUDED',  tone: 'muted'   },
  dynamics:  { label: 'DYNAMICS',  tone: 'alert'   },
  model:     { label: 'MODEL',     tone: 'model'   },
  channel:   { label: 'CHANNEL',   tone: 'neutral' },
  liveness:  { label: 'LIVENESS',  tone: 'neutral' },
  fusion:    { label: 'FUSION',    tone: 'model'   },
  decision:  { label: 'DECISION',  tone: 'decision'}
};

const CATEGORY_MEANING = {
  authority: 'This phrase claims authority; the claim is not independently verified.',
  urgency: 'Time pressure can discourage verification, but urgency alone is not fraud.',
  secrecy: 'Requesting silence isolates the employee from colleagues who would catch this.',
  isolation: 'Blocking callback or verification removes the main defence.',
  novelty: 'A changed payee deserves an independent check before payment.',
  bypass: 'Skipping approval defeats the existing control.',
  threat: 'Fear of arrest, penalty or account loss suppresses careful thinking.',
  reward: 'A prize or refund lure creates a reason to share credentials.'
};

let counter = 0;
const step = (stage, title, detail, extra = {}) => ({
  seq: ++counter, stage, title, detail,
  tone: STAGES[stage].tone, label: STAGES[stage].label, ...extra
});

/** Reset sequence numbering, used when a session is cleared. */
export function resetTrace() { counter = 0; }

/**
 * Build the reasoning chain for a completed assessment.
 * `context` may carry transcript, model, channel, liveness and timing evidence.
 */
export function buildTrace(assessment, context = {}) {
  counter = 0;
  const trace = [];
  const { transcript = null, model = null, channel = null, liveness = null, source = null, segment = null, transcriptSource = 'local-asr' } = context;

  if (source) {
    trace.push(step('capture', source, segment
      ? `Audio segment ${segment.start.toFixed(1)}s to ${segment.end.toFixed(1)}s entered the pipeline.`
      : 'Input received for analysis.'));
  }
  if (transcript) {
    trace.push(step('transcribe', transcriptSource === 'authored-script' ? 'Supplied demo transcript' : 'Speech converted to text locally',
      `"${transcript.slice(0, 160)}${transcript.length > 160 ? '…' : ''}" — ${transcriptSource === 'authored-script' ? 'authored text, not speech recognition' : 'machine transcript; review for errors'}. Speaker identity is not established.`));
  }
  if (assessment.language && assessment.language.language !== 'unknown') {
    const l = assessment.language;
    trace.push(step('language', `Script ${l.script}, likely ${l.language}`,
      assessment.ruleLanguages?.length
        ? `Indic-language rules active for: ${assessment.ruleLanguages.join(', ')}. These are explicit rules with no measured accuracy.`
        : 'English rules applied. Language identification is a heuristic, not a trained identifier.',
      { confidence: l.confidence }));
  }

  // Caller turns only. Each rule hit is explained, not just listed.
  const byCategory = new Map();
  for (const e of assessment.evidence) {
    if (!byCategory.has(e.category)) byCategory.set(e.category, []);
    byCategory.get(e.category).push(e);
  }
  for (const [key, hits] of byCategory) {
    const name = categories[key]?.name || key;
    const phrases = [...new Set(hits.map(h => h.phrase))].slice(0, 3);
    const lang = hits.find(h => h.language)?.language;
    trace.push(step('rule', `${name} detected`,
      `${CATEGORY_MEANING[key] || 'Manipulation pattern matched.'} Matched ${phrases.map(p => `"${p}"`).join(', ')} in turn ${hits[0].turn}${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}.`,
      { category: key, turn: hits[0].turn, phrases, language: lang, weight: 'raises' }));
  }
  for (const name of assessment.actionNames) {
    const hit = assessment.actions.find(a => a.name === name);
    trace.push(step('action', `Sensitive request: ${name}`,
      `The caller asked for something that causes real loss if the request is fraudulent. Matched "${hit.phrase}" in turn ${hit.turn}.`,
      { turn: hit.turn, weight: 'raises' }));
  }
  for (const s of assessment.safeguards) {
    trace.push(step('safeguard', 'Verification-supporting language',
      `"${s.phrase}" points toward normal procedure rather than pressure. This argues against an alert.`,
      { turn: s.turn, weight: 'lowers' }));
  }
  for (const x of assessment.excludedEvidence) {
    trace.push(step('exclusion', `${x.name || x.category} not counted`,
      `"${x.phrase}" was ignored: ${x.reason.toLowerCase()}. Counting it would be a false alarm.`,
      { turn: x.turn, weight: 'neutral' }));
  }

  const d = assessment.dynamics;
  if (d?.resistanceTurns?.length) {
    trace.push(step('dynamics', d.escalated ? 'Pressure escalated after resistance' : 'Employee asked to verify',
      d.escalated
        ? `The employee asked to verify at turn ${d.firstResistanceTurn}. The caller then introduced ${d.addedAfterResistance.join(', ')} for the first time. Pushing harder after being questioned is a stronger signal than the same tactic used up front.`
        : `The employee asked to verify at turn ${d.firstResistanceTurn} and the caller did not introduce new control tactics afterwards.`,
      { weight: d.escalated ? 'raises' : 'neutral' }));
  }

  if (model) {
    if (model.usable) {
      const top = (model.contributions || []).slice(0, 4).map(c => `${c.phrase} (${c.direction})`).join(', ');
      trace.push(step('model', `Trained classifier scored ${model.score.toFixed(3)}`,
        `Threshold ${model.threshold?.toFixed?.(2) ?? model.threshold}, so this reads as ${model.prediction}. Strongest terms: ${top || 'none above weight cutoff'}. This is a dataset-specific score from synthetic, publisher-labelled, and weak real-robocall transcript data, not a real-world fraud probability.`,
        { score: model.score, weight: model.score >= (model.threshold ?? 0.5) ? 'raises' : 'neutral' }));
    } else {
      trace.push(step('model', 'Trained classifier withheld',
        `${model.status}. The model result is not used, so the assessment rests on explicit rule evidence only.`,
        { weight: 'neutral' }));
    }
  }

  if (channel?.usable) {
    trace.push(step('channel', 'Call conditions measured',
      `SNR ${channel.snrDb.toFixed(0)} dB, ${channel.speechSeconds.toFixed(1)}s of speech, ${channel.narrowband ? 'narrowband/telephone-like' : 'wideband'}${channel.clippingRatio > 0.01 ? ', clipping present' : ''}. These bound how far audio evidence can be trusted; they are never evidence of synthesis.`,
      { weight: 'neutral' }));
  }

  if (liveness) {
    trace.push(step('liveness', `Voice liveness: ${liveness.state}`,
      `${liveness.reason} Support: ${liveness.support}. Channel statistics: ${liveness.channel.state}. Heuristic signals are not calibrated confidence. Identity is not established.`,
      { weight: liveness.state === 'Replay-suspected' ? 'raises' : 'neutral' }));
  }

  // Why the rules combined the way they did.
  const detected = assessment.detected.length;
  const control = assessment.detected.some(k => ['bypass', 'isolation', 'secrecy'].includes(k));
  const sensitive = assessment.actionNames.length > 0;
  const parts = [];
  parts.push(sensitive ? `a sensitive request (${assessment.actionNames.join(', ')})` : 'no sensitive request');
  parts.push(`${detected} distinct manipulation ${detected === 1 ? 'category' : 'categories'}`);
  parts.push(control ? 'at least one attempt to block verification' : 'no verification-blocking tactic');
  if (assessment.safeguards.length) parts.push(`${assessment.safeguards.length} verification-supporting phrase${assessment.safeguards.length > 1 ? 's' : ''}`);
  trace.push(step('fusion', 'Evidence combined',
    `Available evidence: ${parts.join('; ')}. ${assessment.reason} Sensitive requests can warrant verification without other pressure; explicit suspicious instructions cannot be cleared by a low model score.`,
    { weight: 'neutral' }));

  trace.push(step('decision', displayRuleState(assessment.state), assessment.reason, {
    state: assessment.state,
    weight: assessment.state === 'No concerning combination' ? 'lowers' : 'raises',
    caveat: 'This is prototype rule and model evidence. It does not establish fraud, identity, or that the call is safe.'
  }));
  return trace;
}

/** One-line summary of what drove the outcome, for the top of the panel. */
export function traceSummary(trace) {
  const raises = trace.filter(t => t.weight === 'raises').length;
  const lowers = trace.filter(t => t.weight === 'lowers').length;
  const decision = trace.find(t => t.stage === 'decision');
  return { steps: trace.length, raises, lowers, state: decision?.state || 'Unknown' };
}
