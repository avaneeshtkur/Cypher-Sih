import { createDemoCues, DemoSession, nextAction } from './demo-session.mjs';
import { decisionTone, displayRuleState } from './decision.mjs';

const $ = id => document.getElementById(id);
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const time = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function renderCall(snapshot) {
  const assessment = snapshot?.assessment;
  const decision = snapshot?.decision;
  const host = $('live-risk');
  const cls = decisionTone(decision,assessment);
  host.className = `assessment ${cls}`;
  host.replaceChildren(el('div', decision?.rank?`CALL-CONTENT RISK · LEVEL ${decision.rank}/4 · ${decision.levelName}`:'RULE-BASED REQUEST ASSESSMENT / NOT VOICE AUTHENTICATION', 'eyebrow'),
    el('h3', decision?.label ?? displayRuleState(assessment?.state)),
    el('p', decision?.reason ?? assessment?.reason ?? 'Only words already received are analysed.'));
  $('live-next').textContent = nextAction(assessment);
  if(snapshot?.peak?.state==='Strongly suspicious' && assessment?.state!=='Strongly suspicious') {
    $('live-next').textContent = `Earlier strong warning retained. ${nextAction(snapshot.peak)}`;
  }
  $('live-transcript').replaceChildren(...(snapshot?.entries ?? []).map(row => {
    const article = el('article', undefined, 'turn');
    article.append(el('div', `${time(row.end)} / ${row.kind === 'gap' ? 'UNPROCESSED AUDIO' : row.transcriptSource === 'authored-script' ? 'SUPPLIED SCRIPT / APPROX. CUE' : 'LOCAL ASR / REVIEW TRANSCRIPT'}`, 'turn-meta'), el('p', row.text));
    return article;
  }));
  if (!snapshot?.entries.length) $('live-transcript').append(el('p', 'Waiting for the first phrase.', 'empty-state'));
  $('live-stats').textContent = `${snapshot?.entries.filter(e => e.kind !== 'gap').length ?? 0} phrases${snapshot?.gaps ? ` / ${snapshot.gaps} gaps` : ''}`;
  $('live-events').replaceChildren(...[...(snapshot?.events ?? [])].reverse().map(event => {
    const row = el('li', undefined, 'event-row');
    row.append(el('time', time(event.at), 'event-time'));
    const body = el('div', undefined, 'event-body');
    body.append(el('h3', event.modelDecision ?? displayRuleState(event.state ?? 'Processing gap')), el('p', event.reason));
    const list = el('ul');
    for (const hit of event.evidence ?? []) list.append(el('li', `${hit.name}: "${hit.phrase}"`));
    for (const hit of event.actions ?? []) list.append(el('li', `${hit.name} requested: "${hit.phrase}"`));
    for (const hit of event.safeguards ?? []) list.append(el('li', `Supports verification: "${hit.phrase}"`));
    for (const hit of event.excluded ?? []) list.append(el('li', `Not counted: "${hit.phrase}" (${hit.reason})`));
    if (list.children.length) body.append(list);
    if (event.state !== event.previousState) body.append(el('span', `${displayRuleState(event.previousState ?? 'Waiting')} → ${displayRuleState(event.state ?? 'Incomplete coverage')}`, `decision-change ${event.state === 'Strongly suspicious' ? 'high' : event.state === 'Needs verification' ? 'suspicious' : ''}`));
    row.append(body);
    return row;
  }));
  if (!snapshot?.events.length) $('live-events').append(el('li', 'No input has been analysed yet.', 'empty-state'));
}

export function initDemos({onPlay,onSelect}={}) {
  const player = $('demo-player');
  let scripts = null, session = null, selected = null, lastCount = -1;
  let enabled = true;
  function sync() {
    $('demo-start').textContent = player.paused ? 'Play audio' : 'Pause';
    if (!enabled || !session) return;
    const snapshot = session.at(player.currentTime);
    if (snapshot.entries.length !== lastCount) {
      renderCall(snapshot);
      lastCount = snapshot.entries.length;
    }
    $('pipeline-input').textContent = player.ended ? 'Finished' : player.paused ? 'Paused' : 'Playing audio';
    $('pipeline-text').textContent = 'Supplied script';
    $('pipeline-analysis').textContent = `${snapshot.entries.length} phrases analysed`;
    $('demo-status').textContent = `${time(player.currentTime)} / ${time(player.duration)} · ${snapshot.entries.length} of ${session.cues.length} approximate phrase cues`;
  }
  function select() {
    player.pause();
    session = null; lastCount = -1;
    selected = $('demo-select').value;
    $('demo-start').disabled = true; $('demo-restart').disabled = true;
    if (enabled) renderCall(null);
    $('demo-status').textContent = 'Loading local audio...';
    player.src = `/demo-audio/${selected}.wav`;
    player.load();
    onSelect?.();
  }
  player.addEventListener('loadedmetadata', () => {
    if (!scripts) return;
    try {
      session = new DemoSession(selected, createDemoCues(scripts[selected], player.duration));
      $('demo-start').disabled = false; $('demo-restart').disabled = false;
      sync();
    } catch (error) { $('demo-status').textContent = error.message; }
  });
  player.addEventListener('error', () => {
    session = null;
    $('demo-start').disabled = true; $('demo-restart').disabled = true;
    $('demo-status').textContent = 'This local demo audio could not be loaded. Choose another scenario.';
  });
  for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'ended']) player.addEventListener(event, sync);
  player.addEventListener('play',()=>onPlay?.());
  async function play() {
    try { await player.play(); }
    catch (error) { $('demo-status').textContent = `Playback failed: ${error.message}`; }
  }
  $('demo-start').onclick = () => player.paused ? play() : player.pause();
  $('demo-restart').onclick = () => { player.currentTime = 0; sync(); play(); };
  $('demo-select').onchange = select;
  fetch('/api/demos').then(async response => {
    if (!response.ok) throw new Error('The local demo catalogue is unavailable.');
    const manifest = await response.json();
    scripts = manifest.scripts;
    if (!scripts || !Object.values(scripts).every(value => typeof value === 'string')) throw new Error('Invalid local demo catalogue.');
    select();
  }).catch(error => { $('demo-status').textContent = error.message; });
  return {
    pause: () => player.pause(),
    setEnabled(value) { enabled = value; if (!value) player.pause(); else { lastCount = -1; sync(); } },
    reset() { player.pause(); player.currentTime = 0; lastCount = -1; sync(); },
    snapshot: () => session?.snapshot() ?? null
  };
}
