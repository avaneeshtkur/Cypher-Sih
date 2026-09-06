"""Verify provenance, split separation and measured predictions from the saved artifacts."""
import os
os.environ['OMP_NUM_THREADS']='1';os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['MKL_NUM_THREADS']='1'
import json, hashlib, time
import joblib, numpy as np
from common import *
from train_audio import read_protocol, extract

def check(condition,message):
    if not condition:raise AssertionError(message)
    checks.append(message)

if __name__=='__main__':
    checks=[]
    sources=json.loads((MODELS/'sources.json').read_text())
    for file in sources['files']:
        p=WORK/file['path'];h=hashlib.sha256()
        with p.open('rb') as stream:
            while b:=stream.read(1024*1024):h.update(b)
        check(h.hexdigest()==file['sha256'],f"Downloaded source bytes verified: {file['name']}")
    check('Attribution-NonCommercial 4.0' in (DATA/'asvspoof2017'/'README_V2.txt').read_text(encoding='utf8'),'Official audio licence retained')
    artifact=joblib.load(MODELS/'intent.joblib');report=json.loads((MODELS/'text_report.json').read_text())
    training_hashes={r['hash'] for r in artifact['train_rows']}
    test=read_scam('scam_single','single-agent-scam-dialogue_test.csv','test')
    check(not training_hashes.intersection({r['hash'] for r in test}),'No exact caller-text overlap between intent train and published test')
    check(not set(report['training_ids']).intersection(report['development_ids']),'Intent development records excluded from model fitting')
    check(len(artifact['train_rows'])==report['train_count'],'Intent artifact row count matches its saved training report')
    check(report['training_sources'].get('bothbosu')==1024,'Intent training retains the expected 1,024 BothBosu rows')
    check(report['training_sources'].get('ncsu_ftc_weak_positive',0)>0,'Intent training includes weak-labelled NCSU/FTC transcripts')
    check(report['training_sources'].get('fraud_call_india_cc0',0)>0,'Intent training includes Fraud Call India records')
    texts=json.loads((MODELS/'text_examples.json').read_text())
    p=artifact['model'].predict_proba(artifact['vectorizer'].transform([caller_text(r['turns']) for r in texts]))[:,1]
    check(np.allclose(p,[r['model_score'] for r in texts],atol=1e-4),'All 1,920 text evaluation predictions recomputed from caller text')
    for split,key in [('published test','published_test'),('transfer test','transfer_test')]:
        idx=[i for i,r in enumerate(texts) if r['evaluation_split']==split]
        recomputed=metrics([texts[i]['label'] for i in idx],p[idx],artifact['threshold'])
        check(recomputed['confusion']==report[key]['confusion'],f'{split} confusion matrix independently recomputed')
    replay=joblib.load(MODELS/'replay.joblib');ar=json.loads((MODELS/'audio_report.json').read_text());audio=json.loads((MODELS/'audio_examples.json').read_text())
    rows=read_protocol('eval');check(len(rows)==len(audio)==13306,'All 13,306 official audio evaluation records included')
    check(all(r['filename']==a['filename'] and r['label']==a['label'] for r,a in zip(rows,audio)),'Audio labels and order match the official evaluation protocol')
    speakers={s:{r['speaker'] for r in read_protocol(s)} for s in ['train','dev','eval']}
    check(not (speakers['train']&speakers['eval'] or speakers['dev']&speakers['eval'] or speakers['train']&speakers['dev']),'Audio train/development/test speakers are disjoint')
    X=np.load(MODELS/'audio_eval_features.npy');scores=replay['calibration'].predict_proba(replay['model'].decision_function(X).reshape(-1,1))[:,1]
    check(np.allclose(scores,[a['model_score'] for a in audio]),'All held-out audio predictions recomputed from saved features')
    check(metrics([a['label'] for a in audio],scores,replay['threshold'])['confusion']==ar['held_out_test']['confusion'],'Audio confusion matrix independently recomputed')
    # Re-extract randomly selected original waveforms, including both labels and errors.
    rng=np.random.default_rng(791);indices=set(rng.choice(len(rows),16,replace=False).tolist())
    for label in [0,1]:indices.add(next(i for i,r in enumerate(rows) if r['label']==label))
    for i in sorted(indices):check(np.allclose(extract(rows[i]),X[i],atol=1e-5),f'Original waveform features reproduced: {rows[i]["filename"]}')
    for name in ['intent.joblib','replay.joblib','text_report.json','audio_report.json']:
        check((MODELS/name).stat().st_size>0,f'Artifact exists: {name}')
    result={'validated_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'passed':len(checks),'checks':checks,
      'artifact_sha256':{n:hashlib.sha256((MODELS/n).read_bytes()).hexdigest() for n in ['intent.joblib','replay.joblib','text_report.json','audio_report.json']},
      'scope':'Dataset byte provenance, split separation and model/evaluation reproducibility. Does not certify detection accuracy or live microphone behavior.'}
    (MODELS/'validation.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({'passed':len(checks),'validation':'models/validation.json'},indent=2))
