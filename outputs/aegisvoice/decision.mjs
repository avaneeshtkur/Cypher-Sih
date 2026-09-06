export const RISK_LEVELS=Object.freeze({
  low:{rank:1,name:'LOW'},
  caution:{rank:2,name:'CAUTION'},
  suspicious:{rank:3,name:'SUSPICIOUS'},
  high:{rank:4,name:'HIGH'},
  uncertain:{rank:0,name:'UNDETERMINED'}
});

function decision(level,label,reason,confidence){
  return {level,rank:RISK_LEVELS[level].rank,levelName:RISK_LEVELS[level].name,label,reason,confidence,scope:'call-content'};
}

/** Convert independent rule and learned-model evidence into a four-level call-content result. */
export function directDecision(rules,model){
  if(rules?.state==='Strongly suspicious')return decision('high','HIGH-RISK SCAM BEHAVIOR DETECTED',rules.reason,'high');
  if(model?.usable&&model.risk_band==='high-risk'&&rules?.state!=='No concerning combination')return decision('high','HIGH-RISK SCAM-LIKE CALL',`The trained classifier is in its high-risk band and the transcript contains independent rule evidence. Model score ${model.score.toFixed(3)}; verify using an official channel before acting.`,'high');
  if(rules?.state==='Needs verification')return decision('suspicious','SUSPICIOUS REQUEST DETECTED',rules.reason,'medium');
  if(model?.usable&&model.risk_band==='high-risk')return decision('caution','SCAM-LIKE LANGUAGE WITHOUT RULE CORROBORATION',`The classifier is in its high-risk band (score ${model.score.toFixed(3)}), but no independent manipulation rule corroborated it.`,'medium');
  if(model?.usable&&model.risk_band==='low-risk')return decision('low','LOW-RISK / LEGITIMATE-LIKE',`The classifier is in its low-risk band (score ${model.score.toFixed(3)}) and no concerning rule combination matched. This is not caller authentication.`,'high');
  if(model?.usable&&['elevated-risk','inconclusive'].includes(model.risk_band))return decision('caution','ELEVATED-RISK LANGUAGE — USE CAUTION',`The classifier score ${model.score.toFixed(3)} falls between the strict high- and low-confidence bands. Treat the request cautiously and use an official channel.`,'low');
  return decision('uncertain','AUDIO / TRANSCRIPT NOT ANALYSABLE','There is not enough usable caller speech or training-vocabulary coverage for a responsible risk classification. Supply a clearer or longer recording.',null);
}

export function decisionTone(value,rules){
  if(value?.level&&RISK_LEVELS[value.level])return value.level==='uncertain'?'neutral':value.level;
  if(rules?.state==='Strongly suspicious')return 'high';
  if(rules?.state==='Needs verification')return 'suspicious';
  return 'neutral';
}

/** Keep engine state names internal; present concrete risk language in the UI. */
export function displayRuleState(state){
  if(state==='Needs verification')return 'SUSPICIOUS REQUEST DETECTED';
  if(state==='Strongly suspicious')return 'HIGH-RISK SCAM BEHAVIOR DETECTED';
  if(state==='No concerning combination')return 'NO EXPLICIT SCAM BEHAVIOR DETECTED';
  return state??'Waiting for input';
}
