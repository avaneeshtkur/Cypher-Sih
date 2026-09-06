"""Local inference from our own trained artifacts; labels never enter prediction."""
import os
os.environ['OMP_NUM_THREADS']='1';os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['MKL_NUM_THREADS']='1'
import io, json, sys, time
import joblib, soundfile as sf, numpy as np
from common import *
sys.stdout.reconfigure(encoding='utf-8')

def intent(turns):
    artifact=joblib.load(MODELS/'intent.joblib')
    text=caller_text(turns);vectorizer=artifact['vectorizer'];model=artifact['model'];X=vectorizer.transform([text])
    p=float(model.predict_proba(X)[0,1]);sim=(X@artifact['train_X'].T).toarray()[0]
    nearest=float(sim.max()) if len(sim) else 0
    weights=X.toarray()[0]*model.coef_[0];names=vectorizer.get_feature_names_out()
    def feature_name(value):
        value=str(value)
        if value.startswith('word__'):return value[6:]
        if value.startswith('char__'):return f'character pattern {value[6:]}'
        return value
    contributions=[{'phrase':feature_name(names[i]),'weight':float(weights[i]),'direction':'scam' if weights[i]>0 else 'non-scam'} for i in np.argsort(np.abs(weights))[::-1][:12] if abs(weights[i])>.005]
    examples=[{'id':artifact['train_rows'][i]['id'],'label':artifact['train_rows'][i]['label'],'type':artifact['train_rows'][i]['type'],
       'similarity':float(sim[i]),'excerpt':artifact['train_rows'][i]['text'][:500]} for i in np.argsort(sim)[::-1][:3]]
    insufficient=len(text.split())<12 or X.nnz<4
    out_of_domain=nearest<.15
    usable=not insufficient and not out_of_domain
    low=float(artifact.get('low_risk_threshold',artifact['threshold']-.15));high=float(artifact.get('high_risk_threshold',artifact['threshold']+.15))
    risk_band='unusable' if not usable else 'high-risk' if p>=high else 'low-risk' if p<=low else 'elevated-risk'
    decision='AUDIO / TRANSCRIPT NOT ANALYSABLE' if not usable else 'HIGH-RISK SCAM-LIKE CALL' if risk_band=='high-risk' else 'LOW-RISK / LEGITIMATE-LIKE CALL' if risk_band=='low-risk' else 'ELEVATED-RISK CALL — USE CAUTION'
    return {'available':True,'score':p,'threshold':artifact['threshold'],'prediction':'scam' if p>=artifact['threshold'] else 'non-scam',
       'low_risk_threshold':low,'high_risk_threshold':high,'risk_band':risk_band,'decision':decision,
       'status':'Insufficient caller speech' if insufficient else 'Outside training vocabulary' if out_of_domain else 'Model result available',
       'usable':usable,'nearest_training_similarity':nearest,'contributions':contributions,'neighbors':examples,
    'model':'Word/character TF-IDF + logistic regression trained on BothBosu, deduplicated Fraud Call India text, and campaign-split NCSU/FTC transcripts','score_meaning':'Distribution-specific score from synthetic, publisher-labelled, and weak suspected-illegal robocall labels; not a real-world fraud probability.'}

def replay(payload):
    from audio_io import decode_audio
    audio=decode_audio(payload)
    duration=len(audio)/16000
    if duration<1 or len(audio)==0 or float(np.sqrt(np.mean(audio**2)))<.0001:
        return {'available':True,'status':'Uncertain','score':None,'reason':'Insufficient audible speech','duration':duration}
    artifact=joblib.load(MODELS/'replay.joblib')
    try:features=audio_features(audio,16000).reshape(1,-1)
    except ValueError as e:return {'available':True,'status':'Uncertain','score':None,'reason':str(e),'duration':duration}
    decision=artifact['model'].decision_function(features).reshape(-1,1);p=float(artifact['calibration'].predict_proba(decision)[0,1])
    state='Replay-like' if p>=artifact['high'] else 'Genuine-like' if p<=artifact['low'] else 'Uncertain'
    return {'available':True,'status':state,'score':p,'genuine_like_max':artifact['low'],'replay_like_min':artifact['high'],'duration':duration,
      'model':'ASVspoof 2017 V2 · LFCC/SVM','reason':'Learned replay evidence; cannot establish live human speech, claimed identity or modern TTS/VC authenticity.'}

if __name__=='__main__':
    started=time.monotonic()
    try:
        from audio_io import MAX_BYTES
        payload=sys.stdin.buffer.read(MAX_BYTES+1)
        if len(payload)>MAX_BYTES:raise ValueError('Media file exceeds 64 MB')
        command=sys.argv[1]
        if command=='intent':
            data=json.loads(payload);turns=data.get('turns',[])
            if not isinstance(turns,list) or any(not isinstance(t,dict) or t.get('role') not in ('caller','employee') or not isinstance(t.get('text'),str) for t in turns):raise ValueError('Invalid turns')
            if sum(len(t['text']) for t in turns)>100000:raise ValueError('Conversation too long')
            result=intent(turns)
        elif command=='replay':result=replay(payload)
        else:raise ValueError('Unknown inference command')
        result['inference_ms']=round((time.monotonic()-started)*1000)
        print(json.dumps(result,ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'error':str(e)}));sys.exit(1)
