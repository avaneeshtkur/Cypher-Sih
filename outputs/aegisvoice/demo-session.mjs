import { analyze } from './engine.mjs';

export const DEMO_SOURCE = 'authored-script';
export const DEMO_TIMING = 'estimated sentence boundaries from script length and media duration';

// No recognizer is involved. Never pass these cues off as an ASR transcript.
export function createDemoCues(script, duration) {
  if (typeof script !== 'string' || !script.trim()) throw new Error('The demo script is missing.');
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The audio duration is invalid.');
  const sentences = (script.match(/[^.!?]+[.!?]*/g) ?? []).map(s => s.trim()).filter(Boolean);
  if (!sentences.length) throw new Error('The demo script has no words.');
  const weights = sentences.map(s => s.split(/\s+/).length + 1.5);
  const total = weights.reduce((a, b) => a + b, 0);
  let end = 0;
  return sentences.map((text, index) => {
    const start = end;
    end = index === sentences.length - 1 ? duration : end + duration * weights[index] / total;
    return { start, end, text, role: 'caller', transcriptSource: DEMO_SOURCE, timing: DEMO_TIMING };
  });
}

export function nextAction(assessment) {
  if (!assessment) return 'No input analysed. Caller identity is not established.';
  if (assessment.actionNames.includes('Credentials / OTP')) return 'Do not share an OTP, PIN or password. Verify using an independently obtained contact.';
  if (assessment.state === 'Strongly suspicious') return 'Pause the requested action. Call the organisation using a saved or official number; do not use a number supplied by this caller.';
  if (assessment.state === 'Needs verification') return 'Treat this request as suspicious. Do not act through this call; use an independently obtained official channel.';
  return 'No concerning combination matched these rules. Continue normal verification; this is not a safe-call verdict.';
}

export function buildAsrTurns(entries, maxAgeSeconds = Infinity) {
  const latestEnd = entries.reduce((latest, entry) => Number.isFinite(entry.end) ? Math.max(latest, entry.end) : latest, 0);
  const turns = [];
  let parts = [];
  const flush = () => {
    if (parts.length) turns.push({ role: 'caller', text: parts.join(' ') });
    parts = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'gap') { flush(); continue; }
    if (typeof entry.text !== 'string' || !entry.text.trim()) continue;
    if (Number.isFinite(maxAgeSeconds) && Number.isFinite(entry.end) && latestEnd - entry.end > maxAgeSeconds) { flush(); continue; }
    parts.push(entry.text.trim());
  }
  flush();
  return turns;
}

function newlyObserved(current, previous, key) {
  const seen = new Map();
  for (const item of previous ?? []) {
    const value = key(item);
    seen.set(value, (seen.get(value) ?? 0) + 1);
  }
  return current.filter(item => {
    const value = key(item), count = seen.get(value) ?? 0;
    if (!count) return true;
    seen.set(value, count - 1);
    return false;
  });
}

export function evidenceUpdate(turns, entry, previousState, previousAssessment = null) {
  const assessment = analyze(turns);
  const turn = turns.length;
  const evidence = previousAssessment
    ? newlyObserved(assessment.evidence, previousAssessment.evidence, item => `${item.category}\0${item.phrase.toLowerCase()}`)
    : assessment.evidence.filter(item => item.turn === turn);
  const safeguards = previousAssessment
    ? newlyObserved(assessment.safeguards, previousAssessment.safeguards, item => item.phrase.toLowerCase())
    : assessment.safeguards.filter(item => item.turn === turn);
  const excluded = previousAssessment
    ? newlyObserved(assessment.excludedEvidence, previousAssessment.excludedEvidence, item => `${item.category}\0${item.phrase.toLowerCase()}\0${item.reason}`)
    : assessment.excludedEvidence.filter(item => item.turn === turn);
  const actions = previousAssessment
    ? newlyObserved(assessment.actions, previousAssessment.actions, item => `${item.name}\0${item.phrase.toLowerCase()}`)
    : assessment.actions.filter(item => item.turn === turn);
  return {
    at: entry.end, turn, transcriptSource: entry.transcriptSource, text: entry.text,
    state: assessment.state, previousState, reason: assessment.reason,
    evidence, safeguards, excluded, actions,
    assessment
  };
}

// Seeking rebuilds a prefix, so future words or warnings cannot survive a rewind.
export class DemoSession {
  constructor(name, cues) {
    if (!cues.length || cues.some((cue, i) => !Number.isFinite(cue.end) || cue.end <= cue.start ||
        (i > 0 && cue.start < cues[i - 1].end) || typeof cue.text !== 'string')) {
      throw new Error('Invalid demo cue sequence.');
    }
    this.name = name;
    this.cues = cues;
    this.at(0);
  }

  at(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid playback position.');
    this.position = seconds;
    this.entries = this.cues.filter(cue => cue.end <= seconds);
    const turns = [];
    this.events = this.entries.map(entry => {
      const previous = turns.length ? analyze(turns).state : null;
      turns.push({ role: entry.role, text: entry.text });
      return evidenceUpdate(turns, entry, previous);
    });
    this.assessment = this.events.at(-1)?.assessment ?? null;
    return this.snapshot();
  }

  snapshot() {
    return structuredClone({
      source: this.name, mode: 'guided-demo', transcriptSource: DEMO_SOURCE,
      timing: DEMO_TIMING, position: this.position, entries: this.entries,
      events: this.events, assessment: this.assessment, gaps: 0,
      limitations: ['Supplied text, not recognized speech.', 'Phrase timing is approximate.', 'Rule results do not establish voice authenticity or identity.']
    });
  }
}
