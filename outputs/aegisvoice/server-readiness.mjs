import { spawn } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const capabilities = ['asr', 'intent', 'replay', 'deepfake', 'speaker'];
export function validateAsrBackend(backend = 'faster-whisper') {
  if (!['faster-whisper', 'openai-whisper'].includes(backend)) {
    throw new Error('AEGIS_ASR_BACKEND must be "faster-whisper" or "openai-whisper".');
  }
  return backend;
}

export function pythonEnvironment(asrBackend, env = process.env) {
  return {
    ...env, AEGIS_ASR_BACKEND: validateAsrBackend(asrBackend),
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_DATASETS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1', AEGIS_CPU_THREADS: '2',
    OMP_NUM_THREADS: '2', OMP_THREAD_LIMIT: '2', OPENBLAS_NUM_THREADS: '2',
    MKL_NUM_THREADS: '2', NUMEXPR_NUM_THREADS: '2'
  };
}

function capabilityGroups(asrBackend) {
  const shared = ['numpy', 'joblib', 'soundfile', 'scipy.fft', 'scipy.signal', 'sklearn.metrics'];
  return {
    asr: asrBackend === 'openai-whisper' ? ['numpy', 'av', 'torch', 'whisper'] : ['numpy', 'av', 'faster_whisper', 'onnxruntime'],
    intent: [...shared, 'sklearn.feature_extraction.text', 'sklearn.linear_model'],
    replay: [...shared, 'sklearn.pipeline', 'sklearn.preprocessing', 'sklearn.svm', 'sklearn.linear_model', 'av'],
    deepfake: ['numpy', 'av', 'torch', 'transformers'],
    speaker: ['numpy', 'av', 'torch', 'speechbrain']
  };
}

function probeScript(asrBackend, capability) {
  const modules = capabilityGroups(asrBackend)[capability];
  return `
import importlib, json, sys
if sys.version_info.major != 3:
    sys.exit(1)
print(json.dumps({"runtime": True, "version": sys.version.split()[0]}), flush=True)
capability = ${JSON.stringify(capability)}
modules = ${JSON.stringify(modules)}
failures = []
for module in modules:
    try:
        if module == "speechbrain":
            import torchaudio
            if not hasattr(torchaudio, "list_audio_backends"):
                torchaudio.list_audio_backends = lambda: ["soundfile"]
        importlib.import_module(module)
    except Exception as error:
        message = str(error)[:300] or type(error).__name__
        if message not in failures:
            failures.append(message)
if not failures and capability == "asr":
    try:
        ${asrBackend === 'openai-whisper'
          ? 'from whisper import load_model\n        import torch\n        torch.set_num_threads(2)\n        torch.set_num_interop_threads(2)'
          : 'from faster_whisper import WhisperModel'}
    except Exception as error:
        failures.append(str(error)[:300] or type(error).__name__)
print(json.dumps({"capability": capability, "ok": not failures, "reason": "; ".join(failures)[:2000]}), flush=True)
`;
}

// Only import dependencies: never load models, download assets, or run evaluation.
export function probePython(python, { asrBackend = 'faster-whisper', timeoutMs = 120000, spawnProcess = spawn, env = process.env } = {}) {
  validateAsrBackend(asrBackend);
  const probeCapability = capability => new Promise(resolve => {
    const result = { capability, runtime: false, version: '', ok: false, reason: '' };
    let child, timer, finished = false, output = '', bytes = 0;
    const finish = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (reason) result.reason = reason;
      resolve(result);
    };
    try {
      child = spawnProcess(python, ['-B', '-u', '-c', probeScript(asrBackend, capability)], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: pythonEnvironment(asrBackend, env)
      });
    } catch {
      finish('Configured Python interpreter could not be started.');
      return;
    }
    timer = setTimeout(() => {
      child.kill();
      finish(`Local dependency probe timed out after ${timeoutMs} ms.`);
    }, timeoutMs);
    const countOutput = chunk => {
      bytes += chunk.length;
      if (bytes > 65536) {
        child.kill();
        finish('Local dependency probe exceeded its output limit.');
      }
    };
    child.stdout.on('data', chunk => {
      countOutput(chunk);
      if (finished) return;
      output += chunk.toString();
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.runtime === true) {
            result.runtime = true;
            result.version = String(message.version || '');
          } else if (message.capability === capability) {
            result.ok = message.ok === true;
            result.reason = message.ok === true ? '' : `Required imports failed: ${message.reason || 'unknown error'}`;
          }
        } catch { /* Other interpreter output is not a readiness signal. */ }
      }
    });
    child.stderr.on('data', countOutput);
    child.once('error', () => finish('Configured Python interpreter could not be started.'));
    child.once('close', code => finish(code ? 'Local dependency probe exited unsuccessfully.' : undefined));
  });
  return (async()=>{
    const probes=[];
    for(const capability of capabilities)probes.push(await probeCapability(capability));
    const result = { runtime: probes.some(probe => probe.runtime), imports: {}, reasons: {} };
    const runtimeProbe = probes.find(probe => probe.runtime);
    result.reasons.runtime = runtimeProbe
      ? `Python ${runtimeProbe.version} executed locally.`
      : probes.find(probe => probe.reason)?.reason || 'Python did not confirm a working interpreter.';
    for (const probe of probes) {
      result.imports[probe.capability] = probe.ok;
      result.reasons[probe.capability] = probe.ok
        ? 'Required imports succeeded.'
        : probe.reason || 'Required imports were not confirmed.';
    }
    return result;
  })();
}

export async function readableFile(filename) {
  try {
    const info = await stat(filename);
    if (!info.isFile() || info.size === 0) return false;
    await access(filename, constants.R_OK);
    return true;
  } catch { return false; }
}

export async function datasetAudioAvailable(directory, metadataPath) {
  try {
    const [entries, metadata] = await Promise.all([
      readdir(directory, { withFileTypes: true }),
      readFile(metadataPath, 'utf8').then(JSON.parse)
    ]);
    const names = new Set(entries.filter(entry => entry.isFile()).map(entry => entry.name));
    for (const record of metadata) {
      if (names.has(record.filename) && await readableFile(path.join(directory, record.filename))) return true;
    }
  } catch { /* Saved metadata can be browsed without the original recordings. */ }
  return false;
}

export function createReadiness({ python, root, speechModel, audioDirectory, asrBackend = 'faster-whisper', env = process.env, probe = probePython, checkFile = readableFile, checkAudio = datasetAudioAvailable, cacheMs = 15000 }) {
  validateAsrBackend(asrBackend);
  let cached, expires = 0, pending;
  async function inspect() {
    const openai = asrBackend === 'openai-whisper';
    const checkpoint = typeof speechModel === 'string' && path.extname(speechModel).toLowerCase() === '.pt';
    const modelRoot = path.resolve(root, '..', '..', 'work', 'models');
    const aasistRoot = path.resolve(root, '..', '..', 'work', 'quarantine', 'aasist');
    const required = {
      asr: [path.join(root, 'transcribe.py'), path.join(root, 'ml', 'audio_io.py'), ...(openai
        ? (checkpoint ? [speechModel] : [])
        : ['model.bin', 'config.json', 'tokenizer.json'].map(name => path.join(speechModel, name)))],
      intent: [path.join(root, 'ml', 'infer.py'), path.join(root, 'ml', 'common.py'), path.join(root, 'models', 'intent.joblib')],
      replay: [path.join(root, 'ml', 'infer.py'), path.join(root, 'ml', 'common.py'), path.join(root, 'ml', 'audio_io.py'), path.join(root, 'models', 'replay.joblib')],
      deepfake: [path.join(root, 'ml', 'audio_models.py'), path.join(root, 'ml', 'audio_io.py'),
        path.join(modelRoot, 'pella-v2', 'pellav2_detector.pt'), path.join(modelRoot, 'wav2vec2-xls-r-300m', 'pytorch_model.bin'),
        path.join(modelRoot, 'wav2vec2-xls-r-300m', 'config.json'), path.join(aasistRoot, 'models', 'AASIST.py'),
        path.join(aasistRoot, 'models', 'weights', 'AASIST.pth')],
      speaker: [path.join(root, 'ml', 'audio_models.py'), path.join(root, 'ml', 'audio_io.py'),
        path.join(modelRoot, 'ecapa-tdnn', 'hyperparams.yaml'), path.join(modelRoot, 'ecapa-tdnn', 'embedding_model.ckpt'),
        path.join(modelRoot, 'ecapa-tdnn', 'mean_var_norm_emb.ckpt')]
    };
    const [runtime, assets, datasetAudio] = await Promise.all([
      probe(python, { asrBackend, env }),
      Promise.all(capabilities.map(async key => {
        const missing = (await Promise.all(required[key].map(async file => await checkFile(file) ? null : path.basename(file)))).filter(Boolean);
        if (key === 'asr' && openai && !checkpoint) missing.push('an explicit local .pt checkpoint (AEGIS_ASR_MODEL)');
        // CTranslate2 exports may use either format; Systran tiny.en ships vocabulary.txt.
        if (key === 'asr' && !openai && !await checkFile(path.join(speechModel, 'vocabulary.txt')) &&
            !await checkFile(path.join(speechModel, 'vocabulary.json'))) missing.push('vocabulary.txt or vocabulary.json');
        return { key, missing };
      })),
      checkAudio(audioDirectory, path.join(root, 'models', 'audio_examples.json'))
    ]);
    const model = `${openai ? 'OpenAI Whisper' : 'faster-whisper'} · ${speechModel ? path.basename(speechModel) : 'no checkpoint configured'} · CPU · local`;
    const status = { runtime: runtime.runtime, asr: false, intent: false, replay: false, deepfake: false, speaker: false, datasetAudio, asrBackend, model, reasons: { runtime: runtime.reasons.runtime }, evaluationVerified: false };
    for (const { key, missing } of assets) {
      status[key] = runtime.runtime && runtime.imports[key] === true && missing.length === 0;
      status.reasons[key] = [
        !runtime.runtime ? runtime.reasons.runtime : !runtime.imports[key] ? runtime.reasons[key] : '',
        missing.length ? `Missing or unreadable local assets: ${missing.join(', ')}.` : '',
        status[key] ? 'Prerequisites only: interpreter, required imports and local files checked; model loading and live evaluation are not verified. Recognition latency and real-time performance are not measured by this probe.' : ''
      ].filter(Boolean).join(' ');
    }
    status.reasons.datasetAudio = datasetAudio
      ? 'Some saved dataset recordings are readable; availability is checked per sample. Audio content is not verified.'
      : 'Original dataset recordings are unavailable locally. Saved metadata and reports remain browsable.';
    status.checkedAt = new Date().toISOString();
    return status;
  }
  return () => {
    if (cached && Date.now() < expires) return Promise.resolve(cached);
    if (!pending) pending = inspect().then(value => {
      cached = value;
      expires = Date.now() + cacheMs;
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}
