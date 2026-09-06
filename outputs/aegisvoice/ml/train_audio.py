"""Replay classifier fitted on official ASVspoof2017 V2 train and calibrated on dev."""
import os
os.environ['OMP_NUM_THREADS']='1';os.environ['OPENBLAS_NUM_THREADS']='1';os.environ['MKL_NUM_THREADS']='1'
import concurrent.futures, json, time
import joblib, soundfile as sf
import numpy as np
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_curve
from threadpoolctl import threadpool_limits
from common import *
threadpool_limits(1)
ROOT=DATA/'asvspoof2017'/'extracted'
CACHE=WORK/'features';CACHE.mkdir(exist_ok=True)

def read_protocol(split):
    suffix='trn' if split=='train' else 'trl'
    rows=[]
    for line in (ROOT/'protocol_V2'/f'ASVspoof2017_V2_{split}.{suffix}.txt').read_text().splitlines():
        fields=line.split();name,label,speaker,phrase=fields[:4]
        path=ROOT/f'ASVspoof2017_V2_{split}'/name
        if not path.exists():raise FileNotFoundError(path)
        rows.append({'id':name[:-4],'filename':name,'path':str(path),'label':int(label=='spoof'),'speaker':speaker,'phrase':phrase,'configuration':fields[4:],'split':split})
    return rows

def extract(row):
    try:
        x,sr=sf.read(row['path']);return audio_features(x,sr)
    except Exception as e:raise RuntimeError(f"{row['filename']}: {e}") from e

def features(rows,split):
    p=CACHE/f'asv2017-v2-lfcc-v1-{split}.npy'
    if p.exists():return np.load(p)
    values=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for i,f in enumerate(pool.map(extract,rows)):
            values.append(f)
            if (i+1)%500==0:print(f'{split}: {i+1}/{len(rows)} features',flush=True)
    result=np.stack(values);np.save(p,result);return result

if __name__=='__main__':
    rows={s:read_protocol(s) for s in ['train','dev','eval']}
    # Do not substitute random file splits: official splits hold speakers apart.
    speaker_sets={s:set(r['speaker'] for r in rs) for s,rs in rows.items()}
    overlap={f'{a}_{b}':sorted(speaker_sets[a]&speaker_sets[b]) for a,b in [('train','dev'),('train','eval'),('dev','eval')]}
    X={s:features(rs,s) for s,rs in rows.items()};y={s:np.array([r['label'] for r in rs]) for s,rs in rows.items()}
    candidates=[]
    for c in [1,10]:
        m=make_pipeline(StandardScaler(),SVC(C=c,gamma='scale',class_weight='balanced')).fit(X['train'],y['train'])
        score=m.decision_function(X['dev']);auc=float(roc_auc_score(y['dev'],score));candidates.append((auc,c,m));print(f'Dev AUROC C={c}: {auc:.4f}',flush=True)
    _,c,model=max(candidates,key=lambda a:a[0])
    calibration=LogisticRegression(C=1,random_state=42).fit(model.decision_function(X['dev']).reshape(-1,1),y['dev'])
    devp=calibration.predict_proba(model.decision_function(X['dev']).reshape(-1,1))[:,1]
    threshold=max(np.arange(.05,.951,.025),key=lambda t:(metrics(y['dev'],devp,t)['balanced_accuracy'],-abs(t-.5)))
    # Thresholds separately target low errors for each confident label on development.
    low_candidates=[t for t in np.arange(.02,float(threshold),.02) if np.sum((devp<=t)&(y['dev']==1))/max(1,np.sum(y['dev']==1))<=.05]
    high_candidates=[t for t in np.arange(float(threshold),.99,.02) if np.sum((devp>=t)&(y['dev']==0))/max(1,np.sum(y['dev']==0))<=.05]
    low=max(low_candidates) if low_candidates else .02
    high=min(high_candidates) if high_candidates else .99
    testp=calibration.predict_proba(model.decision_function(X['eval']).reshape(-1,1))[:,1]
    report={'model':'LFCC/delta statistics + RBF SVM; development Platt calibration','training_source':'ASVspoof 2017 V2 official train','train_count':len(rows['train']),'development_count':len(rows['dev']),
      'evaluation_count':len(rows['eval']),'feature_dimensions':int(X['train'].shape[1]),'selected_C':c,'threshold':float(threshold),'uncertain_below':float(high),'genuine_like_max':float(low),'replay_like_min':float(high),
      'speaker_overlap':overlap,'development':metrics(y['dev'],devp,threshold),'held_out_test':metrics(y['eval'],testp,threshold),
      'limitations':['Replay evidence only: not trained to detect modern TTS, voice conversion, caller identity or live challenge timing.',
      'ASVspoof 2017 contains known recording/channel artifacts; benchmark scores do not establish deployment performance.',
      'Thresholds are selected on development; actual held-out error rates below may exceed their development targets.',
      'Audio outside these recording conditions can produce unreliable scores. A genuine-like score does not establish authenticity.']}
    confident=(testp<=low)|(testp>=high)
    report['selective_test']={'coverage':float(confident.mean()),'uncertain':int((~confident).sum()),'confident_count':int(confident.sum()),
       'confident_accuracy':float(np.mean((testp[confident]>=high)==y['eval'][confident])) if confident.any() else None,
       'attack_acceptance_rate':float(np.mean(testp[y['eval']==1]<=low)),'genuine_rejection_rate':float(np.mean(testp[y['eval']==0]>=high))}
    report['trained_at']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    MODELS.mkdir(exist_ok=True);joblib.dump({'model':model,'calibration':calibration,'threshold':float(threshold),'low':float(low),'high':float(high)},MODELS/'replay.joblib')
    (MODELS/'audio_report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    # Every evaluation record is selectable; never curate only correctly classified examples.
    records=[{**{k:v for k,v in r.items() if k!='path'},'model_score':float(p),'prediction':int(p>=threshold)} for r,p in zip(rows['eval'],testp)]
    (MODELS/'audio_examples.json').write_text(json.dumps(records),encoding='utf-8')
    np.save(MODELS/'audio_eval_features.npy',X['eval'])
    print(json.dumps(report,indent=2),flush=True)
