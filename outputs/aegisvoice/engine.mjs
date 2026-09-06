import { MULTILINGUAL_CATEGORIES, MULTILINGUAL_ACTIONS, MULTILINGUAL_SAFEGUARDS, negatedIndic, protectiveIndic, detectLanguage, hasIndicContent } from './lang-intent.mjs';

export const categories = {
  authority: { name: 'Authority', re: /\b(?:(?:i am|i'm|this is) (?:the |your )?(?:cfo|ceo|director|manager|bank officer|police officer)|(?:this is|my name is|i'?m) [A-Z]?[a-z]*\s*(?:and )?(?:i'?m )?(?:calling )?from (?:the )?[^.!?,]{0,40}?(?:department|bank|police|irs|federal|government|social security|customer (?:service|support)|technical support|security team|fraud team))\b/gi },
  urgency: { name: 'Urgency', re: /\b(?:urgent|immediately|right now|asap|as soon as possible|limited time offer|final attempt|imperative that we speak|within (?:the next )?(?:\d+|twenty|ten|five) minutes?|before (?:noon|close of business|the end of the day))\b/gi },
  secrecy: { name: 'Secrecy', re: /\b(?:keep (?:this|it) (?:between us|secret)|(?:do not|don't|dont) (?:tell|inform|mention (?:this|it) to) (?:anyone|your manager|the team)|between you and me)\b/gi },
  isolation: { name: 'Preventing verification', re: /\b(?:(?:do not|don't|dont) (?:call (?:me |us )?back|verify|check with (?:anyone|the vendor|your manager))|no need to (?:verify|call back|check))\b/gi },
  novelty: { name: 'New beneficiary', re: /\b(?:(?:new|updated|different) (?:bank )?(?:account(?: details)?|beneficiary|payee)|changed (?:bank |account )?details)\b/gi },
  bypass: { name: 'Approval bypass', re: /\b(?:(?:skip|bypass|ignore) (?:the |our |your )?(?:usual |normal |standard )?(?:approval|procedure|process|checks)|without (?:the |manager |usual )?approval)\b/gi },
  threat: { name: 'Threat or coercion', re: /\b(?:(?:your )?account (?:will be|is going to be|may be|would be|has been|was) (?:blocked|suspended|frozen|deactivated|closed)|(?:an? )?order (?:has been |was |is )?placed[^.!?]{0,55}\busing your (?:amazon )?account|(?:we (?:just )?)?suspend(?:ed)? your (?:social security number|ssn|account)|legal (?:action|enforcement action)|arrest warrant|federal criminal offense|appearance before (?:a )?(?:magistrate|judge|grand jury)|you will be (?:arrested|prosecuted|fined)|(?:police|cyber ?crime) (?:case|complaint|inquiry)|(?:case|fir) (?:has been |is )?(?:registered|filed)|penalty will be (?:imposed|charged)|(?:your )?(?:computer|device|system|pc|laptop) (?:has been |is |was )?(?:infected|compromised|hacked|at risk)|(?:virus|malware|trojan|spyware) (?:on|in|detected on) your (?:computer|device|system|pc)|(?:detected|found) (?:a )?(?:virus|malware|suspicious activity) on your)\b/gi },
  reward: { name: 'Reward or lure', re: /\b(?:you have won|lucky (?:winner|draw)|prize money|claim your (?:prize|reward|refund)|cashback of|refund (?:is|has been) (?:pending|approved|initiated)|you (?:now |also )?qualify for (?:a |the |our |new )?(?:0% interest rate|debt relief|relief payment|loan forgiveness)|eligible for (?:the )?(?:federal )?(?:student loan forgiveness|debt relief))\b/gi }
};
const actionRules = [
  ['Payment', /\b(?:transfer|send|wire|pay|release|process|make)\b[^.!?]{0,55}\b(?:money|funds|payment|rupees|lakh|lakhs|crore|invoice|\d+)\b|\b(?:payment|transfer) (?:is|must|needs|has to|should)\b/gi],
  ['Credentials / OTP', /\b(?:send|share|tell|give|read)\b[^.!?]{0,45}\b(?:otp|password|pin|verification code|login code)\b/gi],
  ['Remote access', /\b(?:install|open|download|enable|give|grant)\b[^.!?]{0,45}\b(?:anydesk|teamviewer|remote access|screen sharing)\b/gi],
  ['Confidential information', /\b(?:send|share|give|email)\b[^.!?]{0,45}\b(?:confidential (?:file|data|information)|customer (?:list|data)|employee (?:list|data))\b/gi],
  ['KYC / account action', /\b(?:(?:update|complete|verify|reactivate|re-activate|resubmit) (?:your |the )?(?:kyc|account details)|kyc (?:update|verification) (?:is |has )?(?:pending|expired|required))\b/gi],
  ['Identity / account details', /\b(?:(?:confirm|verify|provide|give|read out|tell me) (?:me )?(?:your |the )?(?:social security(?: number)?|ssn|date of birth|account number|card number|full card|bank details|aadhaar|pan (?:card|number))|last four digits)\b/gi],
  ['Prepaid value transfer', /\b(?:(?:buy|purchase|get|load) (?:a |some |the )?(?:gift ?cards?|google play|itunes|steam|amazon cards?|prepaid cards?|vouchers?)|(?:pay|settle)[^.!?]{0,30}\b(?:gift ?cards?|bitcoin|crypto(?:currency)?|usdt)\b)/gi]
  ,['Call routing / callback', /\b(?:(?:please |just )?press (?:one|two|1|2)(?: now)?|(?:call|reach) (?:me|us) (?:back )?(?:directly )?(?:at|on)\b|give (?:me|us) a call|call (?:the )?(?:number|phone number)\b)/gi]
];

// Conservative, inspectable prototype rules; not a learned intent model.
function quoted(text, index) {
  const before = text.slice(0, index);
  return (before.match(/"/g) || []).length % 2 === 1 || ((before.match(/“/g) || []).length > (before.match(/”/g) || []).length);
}
function excluded(text, index, match) {
  const prefix = text.slice(0, index);
  if (quoted(text, index)) return 'Quoted text';
  if (/\b(?:said|reported|example|training|hypothetical|scammer|fraud awareness)\b/i.test(text)) return 'Reported or example context';
  if (/\b(?:not|never|don't|dont|do not|should not|shouldn't|isn't|is not)\s+(?:\w+\s+){0,2}$/i.test(prefix)) return 'Negated instruction';
  if (/^(?:urgent|immediately)$/i.test(match) && /\b(?:not|isn't|is not)\s+(?:\w+\s+){0,2}$/i.test(prefix)) return 'Negated urgency';
  return null;
}
// Employee turns that ask for verification, approval or a callback.
const RESISTANCE = /\b(?:let me (?:check|confirm|verify)|should i (?:confirm|check|verify)|i(?:'ll| will)? (?:need|have) to (?:check|confirm|verify|ask)|need (?:manager |the )?approval|call (?:you )?back|verify (?:this|it|with)|speak to my (?:manager|supervisor)|is this (?:legitimate|genuine|real)|our policy|not sure about)\b/i;

/**
 * Pressure dynamics: did the caller introduce new control tactics only AFTER the
 * employee asked to verify? Escalation in response to resistance is a stronger
 * signal than the same tactics appearing up front.
 */
function pressureDynamics(turns, evidence) {
  const resistance = turns.map((t, i) => (t.role === 'employee' && RESISTANCE.test(t.text) ? i + 1 : 0)).filter(Boolean);
  if (!resistance.length) return { resistanceTurns: [], escalated: false, addedAfterResistance: [] };
  const first = resistance[0];
  const before = new Set(evidence.filter(e => e.turn < first).map(e => e.category));
  const added = [...new Set(evidence.filter(e => e.turn > first).map(e => e.category))].filter(c => !before.has(c));
  return { resistanceTurns: resistance, firstResistanceTurn: first, addedAfterResistance: added,
    escalated: added.some(c => ['bypass', 'isolation', 'secrecy', 'threat'].includes(c)) };
}

export function analyze(turns) {
  const evidence = [], excludedEvidence = [], safeguards = [], actions = [];
  const callerText = turns.filter(t => t.role === 'caller').map(t => t.text).join('\n');
  for (const [i, turn] of turns.entries()) {
    if (turn.role !== 'caller') continue;
    // Devanagari danda characters terminate sentences alongside Latin punctuation.
    const clauses = turn.text.match(/[^.!?;\n\u0964\u0965]+[.!?;\u0964\u0965]?/g) || [];
    for (const clause of clauses) {
      const text = clause.trim();
      if (!text) continue;
      const safe = text.match(/\b(?:complete|follow|use|obtain|wait for) (?:the |our |your )?(?:usual |normal |standard )?(?:approval|procedure|process)|\b(?:call|contact|verify with)\b[^.!?]{0,65}\b(?:saved|registered|known|official) (?:number|contact)|\b(?:do not|don't|never) (?:skip|bypass|share (?:your |the )?(?:otp|password))/i);
      if (safe && !excluded(text, safe.index, safe[0])) safeguards.push({ turn: i + 1, text, phrase: safe[0] });
      for (const [key, rule] of Object.entries(categories)) {
        for (const m of text.matchAll(new RegExp(rule.re.source, 'gi'))) {
          const why = excluded(text, m.index, m[0]);
          const item = { category: key, name: rule.name, phrase: m[0], text, turn: i + 1 };
          if (why) excludedEvidence.push({ ...item, reason: why }); else evidence.push(item);
        }
      }
      for (const [name, re] of actionRules) {
        for (const m of text.matchAll(new RegExp(re.source, 'gi'))) {
          if (!excluded(text, m.index, m[0])) actions.push({ name, phrase: m[0], text, turn: i + 1 });
        }
      }
      // Indic-language rules. Verb-final negation is handled separately, and
      // patterns whose negation is part of the manipulation are marked intrinsic.
      if (hasIndicContent(text)) {
        for (const { lang, re } of MULTILINGUAL_SAFEGUARDS) {
          const m = text.match(new RegExp(re.source, re.flags.includes('i') ? 'i' : ''));
          if (m && !quoted(text, m.index)) safeguards.push({ turn: i + 1, text, phrase: m[0], language: lang });
        }
        for (const [key, patterns] of Object.entries(MULTILINGUAL_CATEGORIES)) {
          for (const { lang, re, intrinsic } of patterns) {
            for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g'))) {
              const why = negatedIndic(text, m[0], intrinsic)
                || (['secrecy', 'isolation'].includes(key) ? protectiveIndic(text, m[0]) : null)
                || (quoted(text, m.index) ? 'Quoted text' : null);
              const item = { category: key, name: categories[key].name, phrase: m[0], text, turn: i + 1, language: lang };
              if (why) excludedEvidence.push({ ...item, reason: why }); else evidence.push(item);
            }
          }
        }
        for (const [name, patterns] of Object.entries(MULTILINGUAL_ACTIONS)) {
          for (const { lang, re, intrinsic } of patterns) {
            for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g'))) {
              if (!negatedIndic(text, m[0], intrinsic) && !quoted(text, m.index)) actions.push({ name, phrase: m[0], text, turn: i + 1, language: lang });
            }
          }
        }
      }
    }
  }
  const detected = [...new Set(evidence.map(e => e.category))];
  const actionNames = [...new Set(actions.map(a => a.name))];
  const control = detected.some(k => ['bypass', 'isolation', 'secrecy'].includes(k));
  const routing = actionNames.includes('Call routing / callback');
  const sensitive = actionNames.some(name=>name!=='Call routing / callback');
  const credential = actionNames.includes('Credentials / OTP');
  let state = 'No concerning combination';
  let reason = 'No supported combination met the prototype rules. This does not establish that the call is safe.';
  if (sensitive || detected.length >= 2 || control || (routing && detected.length)) {
    state = 'Needs verification';
    reason = routing&&!sensitive?'Suspicious call-routing behavior detected: an unsolicited concern or lure directs the recipient into call routing or a callback. Use an official number instead.':'Suspicious request detected: the caller combines a sensitive action with pressure cues.';
  }
  if (sensitive && control && detected.length >= 2) {
    state = 'Strongly suspicious';
    reason = 'A sensitive request is combined with pressure and an attempt to bypass or restrict verification.';
  }
  if (credential) { state = 'Needs verification'; reason = 'Credential-extraction behavior detected: the caller requests an OTP, password, PIN, or other authentication secret.';
    if (control) { state = 'Strongly suspicious'; reason = 'A credential request is combined with an attempt to restrict verification or disclosure.'; }
  }
  if (state === 'Needs verification' && sensitive && safeguards.length && !control && !detected.includes('novelty') && !credential && detected.length <= 1) {
    state = 'No concerning combination'; reason = 'The request includes verification-supporting instructions without a strong manipulation combination. Follow normal approval procedures.';
  }
  const dynamics = pressureDynamics(turns, evidence);
  // Introducing control tactics only after the employee asked to verify is a
  // stronger pattern than the same tactics appearing without that trigger.
  if (dynamics.escalated && sensitive && state !== 'Strongly suspicious') {
    state = 'Strongly suspicious';
    reason = 'The caller introduced new pressure or verification-blocking tactics only after the employee asked to verify.';
  }
  const languages = [...new Set(evidence.concat(actions).map(e => e.language).filter(Boolean))];
  const language = detectLanguage(callerText);
  return { state, reason, detected, evidence, excludedEvidence, safeguards, actions, actionNames,
    dynamics, language, ruleLanguages: languages,
    engine: languages.length ? 'Phrase-and-context rules v0.2 · English + Hindi/Hinglish/Marathi' : 'Phrase-and-context rules v0.2 · English' };
}

export const wordPool = ['orange', 'river', 'silver', 'garden', 'mango', 'window', 'purple', 'forest', 'lemon', 'pencil', 'planet', 'yellow', 'copper', 'basket', 'tiger', 'cotton'];
export function fuseAssessment(rules, model) {
  if (!model?.usable || rules.state !== 'No concerning combination') return rules;
  if (rules.safeguards.length && !rules.detected.some(k => ['bypass','isolation','secrecy'].includes(k))) return rules;
  if (model.score >= Math.max(model.threshold, .75)) return {...rules,state:'Needs verification',reason:'Scam-like language detected by the trained classifier. Category matches remain separate supporting evidence.'};
  return rules;
}
export function createChallenge(random = globalThis.crypto) {
  const draw = n => { const a = new Uint32Array(1); const limit = Math.floor(4294967296 / n) * n; do { random.getRandomValues(a); } while (a[0] >= limit); return a[0] % n; };
  const first = draw(wordPool.length); let second; do { second = draw(wordPool.length); } while (second === first);
  const number = 10 + draw(90);
  return { id: random.randomUUID(), phrase: `${wordPool[first]} ${number} ${wordPool[second]}`.toUpperCase(), issuedAt: Date.now(), expiresAt: Date.now() + 120000 };
}
export function normalizePhrase(value) {
  const ones = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
  const tens = { twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
  const words = value.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/-/g, ' ').trim().split(/\s+/);
  const out = [];
  for (let i=0;i<words.length;i++) {
    const w=words[i];
    if (w in tens) { let n=tens[w]; if (words[i+1] in ones && ones[words[i+1]] < 10) n+=ones[words[++i]]; out.push(String(n)); }
    else if (w in ones) out.push(String(ones[w])); else out.push(w);
  }
  return out.join(' ');
}
export function checkPhrase(expected, response) {
  if (!response.trim()) return 'Inconclusive';
  return normalizePhrase(expected) === normalizePhrase(response) ? 'Completed' : 'Incorrect';
}

// Liveness fusion lives in liveness-core.mjs, which also carries the channel
// profiler. Re-exported here so existing imports keep working.
export { assessLiveness, channelProfile, profileDistance, LIVENESS_THRESHOLDS } from './liveness-core.mjs';
