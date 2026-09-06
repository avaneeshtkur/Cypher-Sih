const copy = value => value == null ? null : structuredClone(value);

export function referenceEvidence(source, kind = 'unlabelled-input') {
  if (!source) return { kind, referenceLabelUsedForInference: false };
  return {
    kind,
    id: source.id ?? null,
    title: source.title ?? null,
    source: source.source ?? null,
    referenceLabel: source.reference ?? source.label ?? null,
    evaluationSplit: source.evaluation_split ?? source.split ?? null,
    provenance: source.provenance ?? null,
    voiceOrigin: source.voiceOrigin ?? null,
    fraudContext: source.fraudContext ?? null,
    referenceLabelUsedForInference: false
  };
}

export function contentRiskEvidence({ turns = [], assessment = null, learnedModel = null, decision = null, transcriptSource = null } = {}) {
  return {
    scope: 'call-content',
    transcriptSource,
    turns: copy(turns) ?? [],
    assessment: copy(assessment),
    learnedModel: copy(learnedModel),
    decision: copy(decision),
    referenceLabelUsedForInference: false
  };
}

export function replayEvidence({ caller = null, reply = null, callerProfile = null, replyProfile = null, liveness = null } = {}) {
  return {
    scope: 'replay-and-channel',
    caller: copy(caller), reply: copy(reply),
    channelProfiles: { caller: copy(callerProfile), reply: copy(replyProfile) },
    liveness: copy(liveness),
    warning: 'Replay and channel evidence does not determine fraud intent, identity, or synthetic-voice origin.'
  };
}

export function voiceOriginEvidence({ caller = null, reply = null, speakerComparison = null } = {}) {
  return {
    scope: 'voice-origin-and-similarity',
    caller: copy(caller), reply: copy(reply), speakerComparison: copy(speakerComparison),
    warning: 'Synthetic-voice and speaker-similarity evidence does not determine whether call content is fraudulent or establish identity.'
  };
}

export function hasSyntheticVoiceEvidence(result) {
  return Object.values(result?.detectors ?? {}).some(value =>
    value?.available === true && ['synthetic-like', 'spoof-like'].includes(value.label));
}

export function buildEvidenceReport(options = {}) {
  const source = options.authoredCase ?? options.datasetRecord ?? options.recordedSession ?? null;
  const sourceKind = options.authoredCase ? 'authored-case' : options.datasetRecord ? 'dataset-record' : options.recordedSession ? 'recorded-audio' : 'unlabelled-input';
  return {
    application: 'AegisVoice prototype', version: options.version ?? '0.3.0', exportedAt: new Date().toISOString(),
    reference: referenceEvidence(source, sourceKind),
    callContent: contentRiskEvidence({
      turns: options.turns, assessment: options.assessment, learnedModel: options.learnedModel,
      decision: options.decision, transcriptSource: options.transcriptSource
    }),
    replayAndChannel: replayEvidence({
      caller: options.callerReplay, reply: options.replyReplay,
      callerProfile: options.callerProfile, replyProfile: options.replyProfile,
      liveness: options.challengeResult?.liveness
    }),
    voiceOrigin: voiceOriginEvidence({ caller: options.callerDeepfake, reply: options.replyDeepfake, speakerComparison: options.speakerComparison }),
    challenge: copy(options.challenge), recordedAudioRecognition: copy(options.recordedSession),
    guidedDemo: copy(options.guidedDemo), liveSession: copy(options.liveSession), attackLab: copy(options.attackLab),
    explanation: copy(options.explanation) ?? [], capabilities: copy(options.capabilities), limitations: copy(options.limitations) ?? []
  };
}