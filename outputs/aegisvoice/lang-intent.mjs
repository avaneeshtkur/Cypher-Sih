// Hindi, Hinglish and Marathi manipulation patterns.
//
// Written as explicit, inspectable phrase rules in the same spirit as the English
// engine. These are NOT trained models and carry no measured accuracy: the public
// corpora behind the scam classifier are English-only, so nothing here is
// supervised or benchmarked. They extend rule coverage to the languages named in
// the problem statement and must be reported as rule evidence, never as model
// evidence.
//
// Devanagari and romanized (Latin-script) spellings are handled separately because
// vishing calls in India routinely mix both. Romanized spelling is highly variable,
// so patterns allow common alternates (jaldi/jaldee, turant/turent, paisa/paise).

export const SCRIPTS = { devanagari: /[\u0900-\u097F]/, latin: /[A-Za-z]/ };

// Words that mark the language when scripts alone are ambiguous.
const MARATHI_MARKERS = /(?:\u0906\u0939\u0947|\u0928\u093E\u0939\u0940|\u0924\u0941\u092E\u094D\u0939\u0940|\u0906\u092A\u0932\u094D\u092F\u093E|\u0915\u0930\u093E|\u092A\u093E\u0920\u0935\u093E|\u0928\u0915\u094B|\u0932\u0917\u0947\u091A|\u092C\u0901\u0915\u0947\u0924\u0942\u0928|\bahe\b|\bnako\b|\btumhi\b|\blagech\b|\bkara\b|\bpathva\b)/i;
const HINDI_MARKERS = /(?:\u0939\u0948|\u0939\u094B|\u0906\u092A|\u0915\u0930\u094B|\u092D\u0947\u091C|\u0928\u0939\u0940\u0902|\u092E\u0924|\u0924\u0941\u0930\u0902\u0924|\bhai\b|\bkaro\b|\bbhejo\b|\bnahi+n?\b|\bmat\b|\bturant\b|\baap\b|\bkijiye\b|\bbatao\b)/i;

/** Identify script and likely language. Returns evidence, never a hard claim. */
export function detectLanguage(text = '') {
  const devanagari = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const total = devanagari + latin;
  if (!total) return { language: 'unknown', script: 'none', confidence: 0, mixed: false };
  const script = devanagari && latin ? (devanagari / total > 0.15 ? 'mixed' : 'latin')
    : devanagari ? 'devanagari' : 'latin';
  const marathi = MARATHI_MARKERS.test(text), hindi = HINDI_MARKERS.test(text);
  let language = 'en', confidence = 0.3;
  if (script === 'devanagari' || script === 'mixed') {
    language = marathi && !hindi ? 'mr' : marathi && hindi ? 'hi-or-mr' : 'hi';
    confidence = marathi && hindi ? 0.4 : 0.7;
  } else if (hindi || marathi) {
    language = marathi && !hindi ? 'mr-romanized' : 'hi-romanized';
    confidence = 0.5;
  }
  return { language, script, confidence, mixed: script === 'mixed',
    devanagariChars: devanagari, latinChars: latin,
    note: 'Script and keyword heuristic, not a trained language identifier.' };
}

// Negation particles. Hindi and Marathi are verb-final, so the particle usually
// sits immediately BEFORE the verb rather than before the whole clause.
const NEGATORS = /(?:\u092E\u0924|\u0928\u0939\u0940\u0902|\u0928\u093E|\u0928\u0915\u094B|\bmat\b|\bnahi+n?\b|\bnako\b|\bna\b)/i;

/**
 * Hindi/Marathi negation check.
 * `intrinsic` patterns already contain their own negation (for example
 * "kisi ko mat batao" — do not tell anyone), which IS the manipulation, so they
 * must not be excluded for containing a negator.
 */
export function negatedIndic(clause, match, intrinsic) {
  if (intrinsic) return null;
  const index = clause.indexOf(match);
  if (index < 0) return null;
  const inside = NEGATORS.test(match);
  const before = clause.slice(Math.max(0, index - 14), index);
  return inside || NEGATORS.test(before) ? 'Negated instruction' : null;
}

const p = (lang, re, intrinsic = false) => ({ lang, re, intrinsic });

/** Additional category patterns keyed to the English engine's category ids. */
export const MULTILINGUAL_CATEGORIES = {
  authority: [
    p('hi', /(?:\u092E\u0948\u0902|\u092E\u0947\u0902)\s*(?:\u092C\u0948\u0902\u0915|\u092A\u0941\u0932\u093F\u0938|\u0938\u0940\u092C\u0940\u0906\u0908|\u0906\u092F\u0915\u0930|\u0905\u0927\u093F\u0915\u093E\u0930\u0940)[^\u0964.!?]{0,12}(?:\u0938\u0947\s*)?(?:\u092C\u094B\u0932|\u0939\u0942\u0901|\u0939\u0942\u0902)/),
    p('hi-romanized', /\b(?:main|mai|me)\b[^.!?]{0,18}\b(?:bank|police|cbi|inspector|officer|adhikari|income tax|custom)\b[^.!?]{0,14}\b(?:se|bol|baat|hoon|hun|raha|rahi)\b/i),
    p('mr', /\u092E\u0940\s*(?:\u092C\u0901\u0915|\u092A\u094B\u0932\u0940\u0938|\u0905\u0927\u093F\u0915\u093E\u0930\u0940)[^\u0964.!?]{0,12}(?:\u092C\u094B\u0932\u0924\u094B|\u092C\u094B\u0932\u0924\u0947)/)
  ],
  urgency: [
    p('hi', /(?:\u0924\u0941\u0930\u0902\u0924|\u0905\u092D\u0940\s*\u0915\u0947\s*\u0905\u092D\u0940|\u091C\u0932\u094D\u0926\u0940\s*\u0915\u0930|\u0926\u0938\s*\u092E\u093F\u0928\u091F|\u092A\u093E\u0902\u091A\s*\u092E\u093F\u0928\u091F)/),
    p('hi-romanized', /\b(?:turant|turent|abhi\s*ke\s*abhi|jaldi\s*karo|jaldee|foran|fauran|(?:das|paanch|panch|dus)\s*minute\s*(?:me|mein))\b/i),
    p('mr', /(?:\u0932\u0917\u0947\u091A|\u0906\u0924\u094D\u0924\u093E\u091A|\u0932\u0935\u0915\u0930)/)
  ],
  secrecy: [
    p('hi', /(?:\u0915\u093F\u0938\u0940\s*\u0915\u094B\s*(?:\u092E\u0924|\u0928\u0939\u0940\u0902)\s*\u092C\u0924\u093E|\u0917\u0941\u092A\u094D\u0924\s*\u0930\u0916|\u0930\u093E\u091C\u093C\s*\u0930\u0916|\u0915\u093F\u0938\u0940\s*\u0938\u0947\s*\u092E\u0924\s*\u0915\u0939)/, true),
    p('hi-romanized', /\b(?:kisi\s*ko\s*(?:mat|nahi+n?)\s*(?:batao|bataiye|bolna|bolo)|gupt\s*rakho|raaz\s*rakho|secret\s*rakho|kisi\s*se\s*mat\s*kaho)\b/i, true),
    p('mr', /(?:\u0915\u094B\u0923\u093E\u0932\u093E\u0939\u0940\s*\u0938\u093E\u0902\u0917\u0942\s*\u0928\u0915\u093E|\u0917\u0941\u092A\u094D\u0924\s*\u0920\u0947\u0935\u093E)/, true)
  ],
  isolation: [
    p('hi', /(?:\u092B\u094B\u0928\s*\u092E\u0924\s*\u0915\u093E\u091F|\u0915\u0949\u0932\s*\u092E\u0924\s*\u0915\u093E\u091F|\u0932\u093E\u0907\u0928\s*\u092A\u0930\s*\u0930\u0939|\u0915\u093F\u0938\u0940\s*\u0938\u0947\s*\u092E\u0924\s*\u092A\u0942\u091B|\u0935\u093E\u092A\u0938\s*\u092B\u094B\u0928\s*\u092E\u0924)/, true),
    p('hi-romanized', /\b(?:phone\s*(?:mat|nahi+n?)\s*(?:kaato|katna|karo)|call\s*(?:mat|nahi+n?)\s*(?:kaato|cut\s*karo|disconnect\s*karo)|line\s*pe\s*(?:raho|rahiye)|kisi\s*se\s*(?:mat|nahi+n?)\s*pucho|wapas\s*(?:call|phone)\s*mat)\b/i, true),
    p('mr', /(?:\u092B\u094B\u0928\s*\u0915\u093E\u092A\u0942\s*\u0928\u0915\u093E|\u0932\u093E\u0907\u0928\u0935\u0930\s*\u0930\u093E\u0939\u093E)/, true)
  ],
  novelty: [
    p('hi', /(?:\u0928\u092F\u093E\s*(?:\u0916\u093E\u0924\u093E|\u0905\u0915\u093E\u0909\u0902\u091F)|\u0928\u090F\s*(?:\u0916\u093E\u0924\u0947|\u0905\u0915\u093E\u0909\u0902\u091F)\s*\u092E\u0947\u0902|\u0916\u093E\u0924\u093E\s*\u092C\u0926\u0932)/),
    p('hi-romanized', /\b(?:na(?:y|i)a\s*(?:khata|account)|naye\s*(?:khate|account)\s*(?:me|mein)|account\s*(?:number\s*)?badal|khata\s*badal)\b/i),
    p('mr', /(?:\u0928\u0935\u0940\u0928\s*(?:\u0916\u093E\u0924\u0947|\u0905\u0915\u093E\u0909\u0902\u091F))/)
  ],
  bypass: [
    p('hi', /(?:\u092A\u094D\u0930\u0915\u094D\u0930\u093F\u092F\u093E\s*\u091B\u094B\u0921|\u092E\u0902\u091C\u0942\u0930\u0940\s*(?:\u0915\u0940\s*)?\u091C\u093C\u0930\u0942\u0930\u0924\s*\u0928\u0939\u0940\u0902|\u092C\u093F\u0928\u093E\s*\u092E\u0902\u091C\u0942\u0930\u0940|\u091A\u0947\u0915\u093F\u0902\u0917\s*\u091B\u094B\u0921)/, true),
    p('hi-romanized', /\b(?:process\s*(?:chhodo|chodo|skip\s*karo)|approval\s*(?:ki\s*)?(?:zaroorat|zarurat)\s*nahi+n?|bina\s*(?:approval|manjoori|manjuri)|verification\s*(?:chhodo|skip\s*karo))\b/i, true),
    p('mr', /(?:\u092A\u094D\u0930\u0915\u094D\u0930\u093F\u092F\u093E\s*\u0938\u094B\u0921|\u092A\u0930\u0935\u093E\u0928\u0917\u0940\u091A\u0940\s*\u0917\u0930\u091C\s*\u0928\u093E\u0939\u0940)/, true)
  ],
  threat: [
    p('hi', /(?:\u0917\u093F\u0930\u092B\u093C\u094D\u0924\u093E\u0930|\u0917\u093F\u0930\u092B\u094D\u0924\u093E\u0930|\u0935\u093E\u0930\u0902\u091F|\u0916\u093E\u0924\u093E\s*(?:\u092C\u0902\u0926|\u092C\u094D\u0932\u0949\u0915)|\u0905\u0915\u093E\u0909\u0902\u091F\s*\u092C\u094D\u0932\u0949\u0915|\u090F\u092B\u0906\u0908\u0906\u0930|\u092E\u0941\u0915\u0926\u092E\u093E|\u0915\u093E\u0928\u0942\u0928\u0940\s*\u0915\u093E\u0930\u094D\u0930\u0935\u093E\u0908|\u091C\u0947\u0932)/),
    p('hi-romanized', /\b(?:giraftaar|giraftar|arrest\s*(?:ho|kar)|warrant|(?:khata|account)\s*(?:band|block)\s*ho|fir\s*(?:darj|dard)|mukadma|kanooni\s*karrwai|kanuni\s*karyawahi|jail\s*(?:ho|jayenge)|digital\s*arrest)\b/i),
    p('mr', /(?:\u0905\u091F\u0915|\u0916\u093E\u0924\u0947\s*\u092C\u0902\u0926|\u0917\u0941\u0928\u094D\u0939\u093E\s*\u0926\u093E\u0916\u0932|\u0915\u093E\u092F\u0926\u0947\u0936\u0940\u0930\s*\u0915\u093E\u0930\u0935\u093E\u0908)/)
  ],
  reward: [
    p('hi', /(?:\u0932\u0949\u091F\u0930\u0940|\u0907\u0928\u093E\u092E|\u092A\u0941\u0930\u0938\u094D\u0915\u093E\u0930|\u0906\u092A\u0928\u0947\s*\u091C\u0940\u0924|\u0915\u0948\u0936\u092C\u0948\u0915|\u0930\u093F\u092B\u0902\u0921\s*\u092E\u093F\u0932)/),
    p('hi-romanized', /\b(?:lottery\s*(?:lagi|laga)|inaam|inam\s*jeeta|puraskar|aap(?:ne)?\s*jeet|cashback\s*mil|refund\s*(?:mil|aaya|pending)|lucky\s*draw)\b/i),
    p('mr', /(?:\u0932\u0949\u091F\u0930\u0940|\u092C\u0915\u094D\u0937\u0940\u0938|\u091C\u093F\u0902\u0915\u0932)/)
  ]
};

/** Additional sensitive-action patterns keyed to the English engine's action names. */
export const MULTILINGUAL_ACTIONS = {
  'Payment': [
    p('hi', /(?:\u092A\u0948\u0938\u0947\s*(?:\u092D\u0947\u091C|\u091F\u094D\u0930\u093E\u0902\u0938\u092B\u0930|\u0921\u093E\u0932)|\u0930\u0915\u092E\s*\u092D\u0947\u091C|\u0930\u0941\u092A\u092F\u0947\s*\u092D\u0947\u091C|\u092A\u0947\u092E\u0947\u0902\u091F\s*\u0915\u0930)/),
    p('hi-romanized', /\b(?:pais[ae]\s*(?:bhejo|bhej|transfer\s*kar|daal)|rupay[ae]\s*bhej|rakam\s*bhej|payment\s*kar(?:o|do)|transfer\s*kar(?:o|do)|(?:lakh|lakhs|crore|hazaar|hazar)\s*(?:bhejo|transfer))\b/i),
    p('mr', /(?:\u092A\u0948\u0938\u0947\s*\u092A\u093E\u0920\u0935\u093E|\u0930\u0915\u094D\u0915\u092E\s*\u092A\u093E\u0920\u0935\u093E)/)
  ],
  'Credentials / OTP': [
    p('hi', /(?:\u0913\u091F\u0940\u092A\u0940\s*(?:\u092C\u0924\u093E|\u092D\u0947\u091C|\u0936\u0947\u092F\u0930)|\u092A\u093F\u0928\s*\u092C\u0924\u093E|\u092A\u093E\u0938\u0935\u0930\u094D\u0921\s*\u092C\u0924\u093E|\u0915\u094B\u0921\s*\u092C\u0924\u093E)/),
    p('hi-romanized', /\b(?:otp\s*(?:batao|bataiye|bhejo|share\s*kar|do)|pin\s*(?:batao|bataiye)|password\s*(?:batao|bataiye)|code\s*(?:batao|bhejo)|cvv\s*batao)\b/i),
    p('mr', /(?:\u0913\u091F\u0940\u092A\u0940\s*\u0938\u093E\u0902\u0917\u093E|\u092A\u093F\u0928\s*\u0938\u093E\u0902\u0917\u093E)/)
  ],
  'Remote access': [
    p('hi-romanized', /\b(?:anydesk|teamviewer|quick\s*support|screen\s*share)\s*(?:install|download|kar(?:o|do)|karo)\b/i),
    p('hi', /(?:\u090F\u092A\s*\u0921\u093E\u0909\u0928\u0932\u094B\u0921\s*\u0915\u0930|\u0938\u094D\u0915\u094D\u0930\u0940\u0928\s*\u0936\u0947\u092F\u0930)/)
  ],
  'KYC / account action': [
    p('hi', /(?:\u0915\u0947\u0935\u093E\u0908\u0938\u0940\s*(?:\u0905\u092A\u0921\u0947\u091F|\u0915\u0930|\u092A\u0942\u0930\u093E)|\u0916\u093E\u0924\u093E\s*\u091A\u093E\u0932\u0942\s*\u0915\u0930|\u0935\u0947\u0930\u093F\u092B\u093F\u0915\u0947\u0936\u0928\s*\u0915\u0930)/),
    p('hi-romanized', /\b(?:kyc\s*(?:update|karo|kar\s*lo|pura\s*kar|pending|expire)|khata\s*chalu\s*kar|account\s*(?:verify|reactivate)\s*kar)\b/i),
    p('mr', /(?:\u0915\u0947\u0935\u093E\u092F\u0938\u0940\s*\u0915\u0930\u093E|\u0916\u093E\u0924\u0947\s*\u0938\u0941\u0930\u0942\s*\u0915\u0930\u093E)/)
  ]
};

/**
 * Distinguish protective credential advice from secrecy manipulation.
 * "OTP kisi ko mat batao" (do not tell anyone your OTP) is what a real bank says;
 * "kisi ko mat batao" about the call itself is manipulation.
 */
const CREDENTIAL_TOKEN = /(?:otp|pin|password|cvv|\u0913\u091F\u0940\u092A\u0940|\u092A\u093F\u0928|\u092A\u093E\u0938\u0935\u0930\u094D\u0921|\u0917\u0941\u092A\u094D\u0924\u0936\u092C\u094D\u0926)\s*(?:\w+\s*)?$/i;
export function protectiveIndic(clause, match) {
  const index = clause.indexOf(match);
  if (index < 0) return null;
  const before = clause.slice(Math.max(0, index - 24), index).trim();
  if (CREDENTIAL_TOKEN.test(before)) return 'Protective credential advice';
  // "bank kabhi OTP nahi maangta" / "बैंक कभी ओटीपी नहीं मांगता"
  if (/(?:\bbank\b|\u092C\u0948\u0902\u0915)[^.!?\u0964]{0,28}(?:\bkabhi\b|\u0915\u092D\u0940)/i.test(clause)) return 'Protective credential advice';
  return null;
}

/** Indic phrases that support normal verification rather than pressure. */
export const MULTILINGUAL_SAFEGUARDS = [
  p('hi-romanized', /\b(?:(?:otp|pin|password|cvv)\s*kisi\s*ko\s*(?:mat|nahi+n?)\s*(?:batao|bataiye|bolo|dena)|bank\s*kabhi\s*(?:otp|pin|password)[^.!?]{0,12}(?:nahi+n?)\s*(?:maangta|mangta|puchta|poochta)|(?:manjoori|manjuri|approval)\s*(?:ke\s*baad|lekar|lo)|process\s*follow\s*kar|registered\s*number\s*par\s*call)\b/i),
  p('hi', /(?:\u0913\u091F\u0940\u092A\u0940\s*\u0915\u093F\u0938\u0940\s*\u0915\u094B\s*\u092E\u0924\s*\u092C\u0924\u093E|\u092C\u0948\u0902\u0915\s*\u0915\u092D\u0940[^\u0964.!?]{0,14}\u0928\u0939\u0940\u0902\s*\u092E\u093E\u0902\u0917|\u092E\u0902\u091C\u0942\u0930\u0940\s*\u0915\u0947\s*\u092C\u093E\u0926|\u092A\u094D\u0930\u0915\u094D\u0930\u093F\u092F\u093E\s*\u0915\u093E\s*\u092A\u093E\u0932\u0928)/),
  p('mr', /(?:\u0915\u094B\u0923\u093E\u0932\u093E\u0939\u0940\s*\u0913\u091F\u0940\u092A\u0940\s*\u0938\u093E\u0902\u0917\u0942\s*\u0928\u0915\u093E|\u092C\u0901\u0915\s*\u0915\u0927\u0940\u0939\u0940[^\u0964.!?]{0,14}\u0928\u093E\u0939\u0940)/)
];

/** True when any Indic-language rule could apply to this text. */
export function hasIndicContent(text = '') {
  return SCRIPTS.devanagari.test(text) || HINDI_MARKERS.test(text) || MARATHI_MARKERS.test(text);
}
