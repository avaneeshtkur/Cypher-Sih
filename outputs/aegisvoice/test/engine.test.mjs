import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, fuseAssessment, checkPhrase, normalizePhrase, createChallenge, assessLiveness, categories } from '../engine.mjs';
import { detectLanguage } from '../lang-intent.mjs';
const caller=text=>({role:'caller',text});
test('links sensitive request and independent categories across caller turns',()=>{
  const r=analyze([caller('Transfer 20 lakh immediately.'),{role:'employee',text:'Should I call back?'},caller("Use the new account. Skip approval. Don't call me back.")]);
  assert.equal(r.state,'Strongly suspicious');assert.deepEqual(new Set(r.detected),new Set(['urgency','novelty','bypass','isolation']));assert.equal(r.evidence.find(e=>e.category==='bypass').turn,3);
});
test('urgency alone never yields an alert',()=>assert.equal(analyze([caller('This is urgent. Urgent!')]).state,'No concerning combination'));
test('repetition does not increase distinct category count',()=>assert.equal(analyze([caller('Urgent. Immediately. Right now.')]).detected.length,1));
test('employee quotations do not become caller intent',()=>assert.equal(analyze([{role:'employee',text:'Transfer money immediately. Skip approval.'}]).evidence.length,0));
test('negated payment and bypass do not become active requests',()=>{const r=analyze([caller('Do not transfer the money. Never skip approval.')]);assert.equal(r.state,'No concerning combination');assert.equal(r.actions.length,0);assert.equal(r.detected.length,0);assert.equal(r.excludedEvidence.length,1);});
test('quoted and training examples excluded',()=>{const r=analyze([caller('The example says "skip approval". For training: transfer money immediately.')]);assert.equal(r.detected.length,0);assert.equal(r.actions.length,0);});
test('legitimate urgency with normal verification does not escalate',()=>{const r=analyze([caller('This payment is urgent. Please complete the usual approval. Call the vendor on our saved number.')]);assert.equal(r.state,'No concerning combination');assert.ok(r.safeguards.length>=2);});
test('safe language does not clear bypass evidence',()=>assert.equal(analyze([caller('Transfer money immediately. Complete the usual approval. Skip approval.')]).state,'Strongly suspicious'));
test('sensitive OTP request warns even without pressure',()=>assert.equal(analyze([caller('Please send me your OTP.')]).state,'Needs verification'));
test('OTP plus secrecy strongly suspicious',()=>assert.equal(analyze([caller("Send me your login OTP and don't tell your manager.")]).state,'Strongly suspicious'));
test('isolation and secrecy are distinct',()=>{const r=analyze([caller("Don't call me back.")]);assert.deepEqual(r.detected,['isolation']);});
test('phrase checks normalize number words but reject extra tokens',()=>{
  assert.equal(checkPhrase('ORANGE 52 RIVER','Orange fifty-two river'),'Completed');
  assert.equal(checkPhrase('ORANGE 52 RIVER','orange fifty three river'),'Incorrect');
  assert.equal(checkPhrase('ORANGE 52 RIVER','orange 52 river extra'),'Incorrect');
  assert.equal(checkPhrase('ORANGE 52 RIVER',''),'Inconclusive');
  assert.equal(normalizePhrase('Silver nineteen tiger'),'silver 19 tiger');
});
test('challenge contains fresh id, two words and a two-digit number',()=>{const a=createChallenge(),b=createChallenge();assert.match(a.phrase,/^[A-Z]+ [1-9][0-9] [A-Z]+$/);assert.notEqual(a.id,b.id);assert.ok(a.expiresAt-a.issuedAt>=120000);});
test('learned model can raise verification without fabricating intent categories',()=>{const r=fuseAssessment(analyze([caller('We have an offer for your attention.')]),{usable:true,score:.98,threshold:.5});assert.equal(r.state,'Needs verification');assert.equal(r.detected.length,0);});
test('model cannot clear strong explicit evidence',()=>{const r=fuseAssessment(analyze([caller('Transfer money immediately. Skip approval.')]),{usable:true,score:.01,threshold:.5});assert.equal(r.state,'Strongly suspicious');});
test('out-of-vocabulary or short-input model result cannot trigger escalation',()=>{assert.equal(fuseAssessment(analyze([caller('Urgent.')]),{usable:false,score:.99,threshold:.5}).state,'No concerning combination');});
test('legitimate verification instructions constrain a topic-based model false alarm',()=>{assert.equal(fuseAssessment(analyze([caller('This payment is urgent. Please complete the usual approval.')]),{usable:true,score:.98,threshold:.5}).state,'No concerning combination');});
test('approved account changes constrain a model-only false alarm',()=>{
  const rules=analyze([caller('Your updated account details must be submitted through the authenticated HR portal.'),caller('Complete the standard approval and wait for payroll confirmation before any payment.')]);
  assert.ok(rules.detected.includes('novelty'));
  assert.ok(rules.safeguards.length>=1);
  assert.equal(fuseAssessment(rules,{usable:true,score:.98,threshold:.5}).state,'No concerning combination');
});

test('threat and coercion are detected as a distinct category',()=>{
  const r=analyze([caller('Your account will be blocked today. A police case has been registered.')]);
  assert.ok(r.detected.includes('threat'));
});
test('reward lures are detected without matching ordinary business offers',()=>{
  assert.ok(analyze([caller('You have won a prize money draw. Claim your reward now.')]).detected.includes('reward'));
  assert.equal(analyze([caller('We have an offer for your attention.')]).detected.length,0);
});
test('KYC pressure registers as a sensitive requested action',()=>{
  const r=analyze([caller('You must update your KYC immediately or the account is closed.')]);
  assert.ok(r.actionNames.includes('KYC / account action'));
  assert.equal(r.state,'Needs verification');
});
test('digital-arrest style call is strongly suspicious',()=>{
  const r=analyze([caller('This is the police officer handling your case. An arrest warrant is ready.'),caller('Transfer the money to the account I give you. Do not tell anyone. Skip the usual approval.')]);
  assert.equal(r.state,'Strongly suspicious');
  assert.ok(r.detected.includes('threat'));
});
test('negated threat is excluded like other negated evidence',()=>{
  const r=analyze([caller('Your account will not be blocked.')]);
  assert.ok(!r.detected.includes('threat'));
});

test('replay evidence is not cleared by a correct phrase',()=>{
  const r=assessLiveness({outcome:'Completed',replay:{status:'Replay-like'}});
  assert.equal(r.state,'Replay-suspected');
  assert.equal(r.support,'counter-evidence');
});
test('correct phrase with genuine-like audio is live-consistent',()=>{
  const r=assessLiveness({outcome:'Completed',replay:{status:'Genuine-like'},replyProfile:{usable:true,speechSeconds:2,snrDb:20,clippingRatio:0}});
  assert.equal(r.state,'Live-consistent');assert.equal(r.support,'phrase-and-audio');
});
test('typed phrase alone cannot establish voice liveness',()=>{
  const r=assessLiveness({outcome:'Completed'});
  assert.equal(r.state,'Not established');assert.equal(r.support,'phrase-only');
});
test('incorrect phrase does not establish liveness and is not called proof',()=>{
  const r=assessLiveness({outcome:'Incorrect'});
  assert.equal(r.state,'Not established');assert.match(r.reason,/not proof/);
});
test('expired or unchecked challenge cannot establish liveness',()=>{
  assert.equal(assessLiveness({expired:true}).state,'Not established');
  assert.equal(assessLiveness({}).state,'Not established');
  assert.equal(assessLiveness({outcome:'Inconclusive'}).state,'Not established');
});
test('operator-marked timing never decides the liveness outcome',()=>{
  const slow=assessLiveness({outcome:'Completed',intervalMs:9000});
  const fast=assessLiveness({outcome:'Completed',intervalMs:120});
  assert.equal(slow.state,fast.state);assert.equal(slow.timingUsed,false);
});
test('no liveness outcome ever establishes identity',()=>{
  for(const input of [{outcome:'Completed',replay:{status:'Genuine-like'}},{outcome:'Incorrect'},{expired:true},{outcome:'Completed',replay:{status:'Replay-like'}}])
    assert.equal(assessLiveness(input).identity,'Not established');
});
test('category count in the UI stays derived from the engine',()=>{
  assert.equal(Object.keys(categories).length,8);
  assert.ok(Object.values(categories).every(c=>c.name&&c.re));
});

const HI_ARREST='\u092E\u0948\u0902 \u092A\u0941\u0932\u093F\u0938 \u0938\u0947 \u092C\u094B\u0932 \u0930\u0939\u093E \u0939\u0942\u0901\u0964 \u0906\u092A\u0915\u093E \u0916\u093E\u0924\u093E \u092C\u0902\u0926 \u0939\u094B \u091C\u093E\u090F\u0917\u093E\u0964 \u0924\u0941\u0930\u0902\u0924 \u092A\u0948\u0938\u0947 \u092D\u0947\u091C\u094B\u0964 \u0915\u093F\u0938\u0940 \u0915\u094B \u092E\u0924 \u092C\u0924\u093E\u0913\u0964';
const MR_ARREST='\u092E\u0940 \u092C\u0901\u0915\u0947\u0924\u0942\u0928 \u092C\u094B\u0932\u0924\u094B\u092F\u0964 \u0924\u0941\u092E\u091A\u0947 \u0916\u093E\u0924\u0947 \u092C\u0902\u0926 \u0939\u094B\u0908\u0932\u0964 \u0932\u0917\u0947\u091A \u092A\u0948\u0938\u0947 \u092A\u093E\u0920\u0935\u093E\u0964 \u0915\u094B\u0923\u093E\u0932\u093E\u0939\u0940 \u0938\u093E\u0902\u0917\u0942 \u0928\u0915\u093E\u0964';

test('Hinglish digital-arrest call is strongly suspicious',()=>{
  const r=analyze([caller('Main CBI officer bol raha hoon. Aapke naam par FIR darj ho gaya hai. Turant paise bhejo. Kisi ko mat batao. Phone mat kaato.')]);
  assert.equal(r.state,'Strongly suspicious');
  for(const key of ['threat','urgency','secrecy','isolation']) assert.ok(r.detected.includes(key),`missing ${key}`);
  assert.ok(r.actionNames.includes('Payment'));
  assert.ok(r.ruleLanguages.includes('hi-romanized'));
});
test('Hindi Devanagari call is detected with the correct script',()=>{
  const r=analyze([caller(HI_ARREST)]);
  assert.equal(r.state,'Strongly suspicious');
  assert.equal(r.language.script,'devanagari');
  assert.ok(r.detected.includes('threat')&&r.detected.includes('authority'));
  assert.ok(r.actionNames.includes('Payment'));
});
test('Marathi call is detected by Marathi rules',()=>{
  const r=analyze([caller(MR_ARREST)]);
  assert.equal(r.state,'Strongly suspicious');
  assert.ok(r.ruleLanguages.includes('mr'));
  assert.ok(r.detected.includes('threat'));
});
test('Hinglish reward lure raises OTP and KYC actions',()=>{
  const r=analyze([caller('Aapki lottery lagi hai aur refund pending hai. KYC update karo aur OTP batao jaldi.')]);
  assert.ok(r.detected.includes('reward'));
  assert.ok(r.actionNames.includes('Credentials / OTP'));
  assert.ok(r.actionNames.includes('KYC / account action'));
  assert.equal(r.state,'Needs verification');
});
test('verb-final Hindi negation suppresses a payment request',()=>{
  const r=analyze([caller('Paise mat bhejo. Transfer mat karo.')]);
  assert.ok(!r.actionNames.includes('Payment'));
});
test('protective OTP advice is not secrecy manipulation',()=>{
  const r=analyze([caller('OTP kisi ko mat batao. Bank kabhi OTP nahi maangta.')]);
  assert.equal(r.state,'No concerning combination');
  assert.ok(!r.detected.includes('secrecy'));
  assert.ok(r.excludedEvidence.some(e=>e.reason==='Protective credential advice'));
});
test('English-only text does not activate Indic rules',()=>{
  const r=analyze([caller('Transfer 20 lakh immediately. Skip the usual approval.')]);
  assert.equal(r.ruleLanguages.length,0);
  assert.equal(r.language.script,'latin');
});
test('language detection separates script from a hard language claim',()=>{
  const hi=detectLanguage(HI_ARREST);
  assert.equal(hi.script,'devanagari');
  assert.ok(hi.confidence<1,'detection must not claim certainty');
  assert.equal(detectLanguage('').language,'unknown');
});

test('new tactics after employee resistance escalate the assessment',()=>{
  const r=analyze([
    caller('This is the CFO, please release the vendor payment today.'),
    {role:'employee',text:'Let me confirm this with my manager first.'},
    caller('Do not call me back. Keep this between us.')
  ]);
  assert.equal(r.dynamics.escalated,true);
  assert.equal(r.dynamics.firstResistanceTurn,2);
  assert.equal(r.state,'Strongly suspicious');
});
test('the same tactics stated up front do not count as escalation',()=>{
  const r=analyze([caller('Transfer the payment. Do not call me back. Keep this between us.')]);
  assert.equal(r.dynamics.escalated,false);
  assert.deepEqual(r.dynamics.resistanceTurns,[]);
});
test('employee resistance without any new caller tactic is not escalation',()=>{
  const r=analyze([
    caller('Please process the supplier invoice.'),
    {role:'employee',text:'Let me verify this with the finance team.'},
    caller('Yes, please follow the normal procedure.')
  ]);
  assert.equal(r.dynamics.escalated,false);
});
