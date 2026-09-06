import csv, hashlib, json, re
from pathlib import Path
import numpy as np
from scipy.fft import dct
from scipy.signal import resample_poly
from sklearn.metrics import accuracy_score, balanced_accuracy_score, precision_recall_fscore_support, roc_auc_score, confusion_matrix, roc_curve

APP=Path(__file__).resolve().parents[1]
WORK=APP.parents[1]/'work'
DATA=WORK/'datasets'
MODELS=APP/'models'

def parse_dialogue(text):
    matches=list(re.finditer(r'\b(Suspect|Innocent|Caller|Employee)\s*:',text,re.I))
    if not matches:return [{'role':'caller','text':text.strip()}]
    return [{'role':'caller' if m[1].lower() in ('suspect','caller') else 'employee',
             'text':text[m.end():matches[i+1].start() if i+1<len(matches) else len(text)].strip()}
            for i,m in enumerate(matches)]

def caller_text(turns):return '\n'.join(t['text'] for t in turns if t['role']=='caller')
def fingerprint(text):return hashlib.sha256(re.sub(r'\W+',' ',text.lower()).strip().encode()).hexdigest()

def read_scam(folder,filename,split):
    with (DATA/folder/filename).open(encoding='utf-8-sig',newline='') as f:
        rows=[]
        for i,row in enumerate(csv.DictReader(f)):
            turns=parse_dialogue(row['dialogue']);text=caller_text(turns)
            if not text.strip():raise ValueError(f'Missing caller in row {i}')
            rows.append({'id':f'{folder}-{split}-{i:04d}','source':folder,'source_row':i,'published_split':split,'turns':turns,'text':text,'label':int(row['labels']),'type':row['type'],'hash':fingerprint(text)})
        return rows

def metrics(y,p,threshold=.5):
    y=np.asarray(y);p=np.asarray(p);pred=(p>=threshold).astype(int)
    precision,recall,f1,_=precision_recall_fscore_support(y,pred,average='binary',zero_division=0)
    tn,fp,fn,tp=confusion_matrix(y,pred,labels=[0,1]).ravel()
    fpr,tpr,_=roc_curve(y,p);i=int(np.argmin(np.abs(fpr-(1-tpr))))
    return {'n':len(y),'positive':int(y.sum()),'negative':int((1-y).sum()),'accuracy':float(accuracy_score(y,pred)),'balanced_accuracy':float(balanced_accuracy_score(y,pred)),
            'precision':float(precision),'recall':float(recall),'f1':float(f1),'auroc':float(roc_auc_score(y,p)),
            'eer_approx':float((fpr[i]+1-tpr[i])/2),'false_positive_rate':float(fp/(fp+tn)),'false_negative_rate':float(fn/(fn+tp)),
            'confusion':{'tn':int(tn),'fp':int(fp),'fn':int(fn),'tp':int(tp)},'threshold':float(threshold)}

def audio_features(audio,sr):
    """LFCC + delta statistics on speech-energy frames. Never uses filename/label/duration."""
    x=np.asarray(audio,dtype=np.float64)
    if x.ndim>1:x=x.mean(axis=1)
    if sr!=16000:
        from math import gcd
        g=gcd(int(sr),16000);x=resample_poly(x,16000//g,int(sr)//g)
    if len(x)<400:raise ValueError('Insufficient audio')
    rms=float(np.sqrt(np.mean(x*x)))
    if rms<1e-6:raise ValueError('No usable audio')
    x=x/(np.max(np.abs(x))+1e-9)
    frames=np.lib.stride_tricks.sliding_window_view(x,400)[::160]
    energy=np.mean(frames*frames,axis=1)
    frames=frames[energy>max(float(np.max(energy))*0.001,1e-8)]
    if len(frames)<5:raise ValueError('Insufficient speech frames')
    if len(frames)>1200:frames=frames[np.linspace(0,len(frames)-1,1200).astype(int)]
    spectra=np.abs(np.fft.rfft(frames*np.hamming(400),n=512))**2
    points=np.linspace(0,256,62);bins=np.arange(257);filters=[]
    for i in range(60):filters.append(np.maximum(0,np.minimum((bins-points[i])/(points[i+1]-points[i]),(points[i+2]-bins)/(points[i+2]-points[i+1]))))
    log_bands=np.log(np.maximum(spectra@np.array(filters).T,1e-12))
    lfcc=dct(log_bands,type=2,axis=1,norm='ortho')[:,1:31]
    delta=np.gradient(lfcc,axis=0);delta2=np.gradient(delta,axis=0)
    feats=[]
    for a in (lfcc,delta,delta2):feats.extend([a.mean(axis=0),a.std(axis=0),np.percentile(a,10,axis=0),np.percentile(a,90,axis=0)])
    # Relative band energies capture replay coloration without raw loudness or silence duration.
    relative=log_bands-log_bands.mean(axis=1,keepdims=True)
    feats.extend([relative.mean(axis=0),relative.std(axis=0)])
    return np.concatenate(feats).astype(np.float32)
