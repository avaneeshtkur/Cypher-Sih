// Theme switch and the call-desk signal scope.
//
// The scope is a risk ribbon: the decoded waveform of the call, rendered at three
// time scales, tinted by the rule state that was actually in force at each moment.
// Nothing here is synthesised — amplitude comes from decoding the clip (or from a
// WebAudio analyser on live capture), and every colour change sits at the timestamp
// where the rule engine genuinely changed its assessment.
const $ = id => document.getElementById(id);
const root = document.documentElement;
const STORAGE_KEY = 'aegisvoice-theme';
const THEME_COLOR = { dark: '#06070a', light: '#eaeef4' };
const LEVELS = ['high', 'suspicious', 'caution', 'watch', 'low'];
const TONE_TOKEN = {
  neutral: '--wave-3',
  low: '--jade',
  caution: '--amber',
  watch: '--amber',
  suspicious: '--orange',
  high: '--rose'
};

function applyTheme(theme) {
  root.dataset.theme = theme;
  const label = $('theme-toggle-label');
  const toggle = $('theme-toggle');
  if (label) label.textContent = theme === 'light' ? 'Light' : 'Dark';
  if (toggle) toggle.setAttribute('aria-label', `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  window.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
}

function initTheme() {
  applyTheme(root.dataset.theme === 'light' ? 'light' : 'dark');
  $('theme-toggle')?.addEventListener('click', () => {
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
    applyTheme(next);
  });
}

function readTone() {
  const risk = $('live-risk');
  for (const level of LEVELS) if (risk?.classList.contains(level)) return level;
  return 'neutral';
}

function phraseCount() {
  return Number(($('live-stats')?.textContent ?? '').match(/\d+/)?.[0] ?? 0);
}

// Peak envelope of the decoded clip, one min/max pair per column.
function buildPeaks(buffer, columns) {
  const data = buffer.getChannelData(0);
  const peaks = new Float32Array(columns);
  const perColumn = data.length / columns;
  for (let column = 0; column < columns; column += 1) {
    const from = Math.floor(column * perColumn);
    const to = Math.min(data.length, Math.floor((column + 1) * perColumn));
    let peak = 0;
    for (let index = from; index < to; index += 1) {
      const value = Math.abs(data[index]);
      if (value > peak) peak = value;
    }
    peaks[column] = peak;
  }
  return peaks;
}

// Box-smooth an amplitude series; the window sets the time scale of the layer.
function smooth(values, window) {
  if (window <= 1) return values;
  const out = new Float32Array(values.length);
  const half = Math.floor(window / 2);
  let sum = 0;
  for (let i = 0; i < values.length + half; i += 1) {
    if (i < values.length) sum += values[i];
    if (i - window >= 0) sum -= values[i - window];
    const target = i - half;
    if (target >= 0 && target < values.length) {
      out[target] = sum / Math.min(window, i + 1);
    }
  }
  return out;
}

function buildLayers(peaks) {
  return [
    { amp: smooth(peaks, 161), alpha: 0.20, fill: true },
    { amp: smooth(peaks, 65), alpha: 0.26, fill: true },
    { amp: smooth(peaks, 21), alpha: 1, fill: false }
  ];
}

function initScope() {
  const canvas = $('scope-wave');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const arc = $('scope-arc');
  const circumference = 2 * Math.PI * 27;
  const clips = new Map();
  const marks = [];

  let audio = null;
  let analyser = null;
  let samples = null;
  let display = null;
  let liveLayers = null;
  const routed = new WeakSet();
  let width = 0;
  let height = 0;

  const token = name => getComputedStyle(canvas).getPropertyValue(name).trim();
  const colorFor = tone => token(TONE_TOKEN[tone] ?? '--wave-3') || '#39a6f5';

  const attach = element => {
    try {
      if (!audio) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audio.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.6;
        samples = new Float32Array(analyser.fftSize);
        analyser.connect(audio.destination);
      }
      if (!routed.has(element)) {
        audio.createMediaElementSource(element).connect(analyser);
        routed.add(element);
      }
      if (audio.state === 'suspended') audio.resume();
    } catch {
      // Already routed through another graph, or WebAudio is unavailable.
    }
  };

  const loadClip = async element => {
    const url = element.currentSrc;
    if (!url || clips.has(url)) return;
    clips.set(url, null);
    try {
      const response = await fetch(url);
      const bytes = await response.arrayBuffer();
      const decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 22050);
      clips.set(url, buildLayers(buildPeaks(await decoder.decodeAudioData(bytes), 800)));
      paint();
    } catch {
      clips.delete(url);
    }
  };

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const box = canvas.getBoundingClientRect();
    width = Math.max(280, Math.round(box.width));
    height = Math.max(90, Math.round(box.height));
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  // Mirrored, midpoint-smoothed closed path through an amplitude series.
  const wavePath = (amp, middle, span) => {
    const count = amp.length;
    const xAt = index => (index / (count - 1)) * width;
    ctx.beginPath();
    ctx.moveTo(0, middle - amp[0] * span);
    for (let i = 1; i < count; i += 1) {
      const x0 = xAt(i - 1);
      const x1 = xAt(i);
      const y0 = middle - amp[i - 1] * span;
      const y1 = middle - amp[i] * span;
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    for (let i = count - 1; i > 0; i -= 1) {
      const x0 = xAt(i);
      const x1 = xAt(i - 1);
      const y0 = middle + amp[i] * span;
      const y1 = middle + amp[i - 1] * span;
      ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    ctx.closePath();
  };

  const baseRamp = () => {
    const ramp = ctx.createLinearGradient(0, 0, width, 0);
    ramp.addColorStop(0, token('--wave-1') || '#2b3193');
    ramp.addColorStop(0.4, token('--wave-2') || '#4f63e8');
    ramp.addColorStop(0.75, token('--wave-3') || '#39a6f5');
    ramp.addColorStop(1, token('--wave-4') || '#4de3cf');
    return ramp;
  };

  // Colour stops sit exactly where the rule state changed during the call.
  const riskRamp = edge => {
    const ramp = ctx.createLinearGradient(0, 0, Math.max(1, edge), 0);
    let previous = 'neutral';
    ramp.addColorStop(0, colorFor(previous));
    for (const mark of marks) {
      const position = Math.min(1, Math.max(0, mark.x / Math.max(1, edge)));
      if (position >= 1) break;
      ramp.addColorStop(Math.max(0, position - 0.006), colorFor(previous));
      ramp.addColorStop(position, colorFor(mark.tone));
      previous = mark.tone;
    }
    ramp.addColorStop(1, colorFor(previous));
    return ramp;
  };

  const drawLayers = (layers, middle, span, paint2) => {
    for (const layer of layers) {
      wavePath(layer.amp, middle, span);
      if (layer.fill) {
        ctx.globalAlpha = layer.alpha * paint2.alpha;
        ctx.fillStyle = paint2.style;
        ctx.fill();
      } else {
        ctx.globalAlpha = paint2.alpha;
        ctx.strokeStyle = paint2.style;
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.shadowBlur = paint2.glow;
        ctx.shadowColor = paint2.glowColor;
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalAlpha = 1;
  };

  const drawMarks = (edge, middle) => {
    ctx.save();
    ctx.font = '600 10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'top';
    for (const mark of marks) {
      if (mark.x > edge + 1) continue;
      const colour = colorFor(mark.tone);
      const x = Math.round(mark.x) + 0.5;
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, middle - height * 0.42);
      ctx.lineTo(x, middle + height * 0.42);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colour;
      ctx.fillRect(x - 1.5, middle - height * 0.42, 3, 3);
      ctx.fillText(mark.label, x + 6, middle + height * 0.28);
    }
    ctx.restore();
  };

  const paint = () => {
    const playing = Boolean(display && !display.paused && !display.ended);
    if (playing && analyser) analyser.getFloatTimeDomainData(samples);

    ctx.clearRect(0, 0, width, height);
    const middle = height / 2;
    const span = height * 0.38;

    ctx.strokeStyle = token('--line') || '#1f2530';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, middle + 0.5);
    ctx.lineTo(width, middle + 0.5);
    ctx.stroke();

    let layers = display ? clips.get(display.currentSrc) : null;
    const duration = display?.duration;
    const scrubbable = Boolean(layers) && Number.isFinite(duration) && duration > 0;

    if (!layers && playing && samples) {
      // Live capture has no decoded clip; smooth the analyser window instead.
      const columns = 480;
      const peaks = new Float32Array(columns);
      const perColumn = samples.length / columns;
      for (let column = 0; column < columns; column += 1) {
        let peak = 0;
        const from = Math.floor(column * perColumn);
        const to = Math.floor((column + 1) * perColumn);
        for (let index = from; index < to; index += 1) {
          const value = Math.abs(samples[index]);
          if (value > peak) peak = value;
        }
        peaks[column] = peak;
      }
      liveLayers = buildLayers(peaks);
      layers = liveLayers;
    }

    let peak = 0;
    if (playing && samples) {
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.abs(samples[index]);
        if (value > peak) peak = value;
      }
    }

    if (layers) {
      const edge = scrubbable ? width * Math.min(1, (display.currentTime || 0) / duration) : width;
      const glow = token('--wave-3') || '#39a6f5';

      drawLayers(layers, middle, span, { style: baseRamp(), alpha: 0.34, glow: 0, glowColor: glow });

      if (edge > 0.5) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, edge, height);
        ctx.clip();
        const ramp = scrubbable ? riskRamp(edge) : baseRamp();
        const tone = marks.at(-1)?.tone ?? 'neutral';
        drawLayers(layers, middle, span, { style: ramp, alpha: 1, glow: 26, glowColor: scrubbable ? colorFor(tone) : glow });
        ctx.restore();
      }

      if (scrubbable) {
        drawMarks(edge, middle);
        if (edge > 0.5) {
          const colour = colorFor(marks.at(-1)?.tone ?? 'neutral');
          const x = Math.round(edge) + 0.5;
          ctx.strokeStyle = colour;
          ctx.shadowBlur = 16;
          ctx.shadowColor = colour;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, 4);
          ctx.lineTo(x, height - 4);
          ctx.stroke();
          ctx.shadowBlur = 0;
        }
      }
    }

    const level = Math.min(1, peak);
    if (arc) {
      arc.setAttribute('stroke-dashoffset', (circumference * (1 - level)).toFixed(2));
      arc.style.stroke = level > 0.92 ? 'var(--rose)' : level > 0.7 ? 'var(--amber)' : 'var(--wave-3)';
    }
    const readout = $('scope-level');
    if (readout) readout.textContent = `${Math.round(level * 100)}%`;
    const status = $('scope-status');
    if (status) status.textContent = playing ? 'LIVE' : layers ? 'PAUSED' : 'NO SIGNAL';
  };

  const recordTransition = () => {
    const tone = readTone();
    if (!display || !Number.isFinite(display.duration) || !display.duration) return;
    if (phraseCount() === 0) { marks.length = 0; return; }
    const time = display.currentTime || 0;
    const previous = marks.at(-1);
    if (previous && previous.tone === tone) return;
    if (tone === 'neutral' && !previous) return;
    marks.push({
      time,
      x: (time / display.duration) * width,
      tone,
      label: ($('live-risk')?.querySelector('h3')?.textContent ?? tone).split(' ')[0].toUpperCase()
    });
  };

  const remapMarks = () => {
    if (!display?.duration) return;
    for (const mark of marks) mark.x = (mark.time / display.duration) * width;
  };

  const frame = () => { paint(); requestAnimationFrame(frame); };

  document.addEventListener('play', event => {
    if (!(event.target instanceof HTMLAudioElement)) return;
    display = event.target;
    attach(display);
    loadClip(display);
  }, true);
  document.addEventListener('loadeddata', event => {
    if (!(event.target instanceof HTMLAudioElement)) return;
    if (!display || display === event.target) display = event.target;
    marks.length = 0;
    loadClip(event.target);
  }, true);
  document.addEventListener('seeking', event => {
    if (!(event.target instanceof HTMLAudioElement) || event.target !== display) return;
    const time = display.currentTime;
    while (marks.length && marks.at(-1).time > time) marks.pop();
  }, true);

  window.addEventListener('resize', () => { resize(); remapMarks(); paint(); });
  window.addEventListener('themechange', paint);
  window.addEventListener('rulestatechange', recordTransition);

  resize();
  paint();
  requestAnimationFrame(frame);
}

function syncScope() {
  const scope = $('scope');
  if (!scope) return;
  scope.dataset.tone = readTone();

  const verdict = $('scope-verdict');
  const heading = $('live-risk')?.querySelector('h3')?.textContent?.trim();
  if (verdict && heading) verdict.textContent = heading;

  const phrases = $('scope-phrases');
  if (phrases) phrases.textContent = String(phraseCount());

  const stage = $('scope-stage');
  if (stage) stage.textContent = $('pipeline-analysis')?.textContent ?? 'Ready';

  const source = $('scope-source');
  if (source) source.textContent = $('pipeline-input')?.textContent ?? 'No input';

  window.dispatchEvent(new Event('rulestatechange'));
}

function watchState() {
  const observer = new MutationObserver(syncScope);
  for (const id of ['live-risk', 'live-stats', 'pipeline-analysis', 'pipeline-input']) {
    const target = $(id);
    if (target) observer.observe(target, { attributes: true, childList: true, subtree: true, characterData: true });
  }
}

initTheme();
initScope();
syncScope();
watchState();
