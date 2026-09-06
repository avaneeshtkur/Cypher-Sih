"""Train on published single-agent train; freeze test and transfer corpus."""
import json, time
import joblib
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import train_test_split
from sklearn.pipeline import FeatureUnion, make_pipeline
from sklearn.preprocessing import Normalizer
from common import *
from intent_data import grouped_train_evaluation_split, load_approved_intent_corpora, load_fraud_call_india_records, load_ncsu_transcripts, source_class_balanced_weights

MODELS.mkdir(exist_ok=True)
raw=read_scam('scam_single','single-agent-scam-dialogue_train.csv','train')
official_test=read_scam('scam_single','single-agent-scam-dialogue_test.csv','test')
transfer=read_scam('scam_multi','agent_conversation_train.csv','train')+read_scam('scam_multi','agent_conversation_test.csv','test')
seen=set();unique=[]
for r in raw:
    if r['hash'] not in seen:unique.append(r);seen.add(r['hash'])
test_hashes={r['hash'] for r in official_test}
train_pool=[r for r in unique if r['hash'] not in test_hashes]
train,dev=train_test_split(train_pool,test_size=.2,random_state=42,stratify=[r['label'] for r in train_pool])
ncsu=load_ncsu_transcripts(APP/'database-audio'/'ncsu-metadata.csv')
ncsu_english=[r for r in ncsu if r['language']=='en']
ncsu_unique=[];ncsu_seen=set()
for r in ncsu_english:
    if r['hash'] not in ncsu_seen:ncsu_unique.append(r);ncsu_seen.add(r['hash'])
ncsu_train,ncsu_evaluation=grouped_train_evaluation_split(ncsu_unique)
base_hashes={r['hash'] for r in train+dev+official_test+transfer}
ncsu_train=[r for r in ncsu_train if r['hash'] not in base_hashes]
ncsu_evaluation=[r for r in ncsu_evaluation if r['hash'] not in {r['hash'] for r in train+dev}]
licensed=load_approved_intent_corpora(DATA/'intent-corpora'/'manifest.json')
licensed_unique=[];licensed_seen=set(base_hashes|ncsu_seen)
for r in licensed:
    if r['hash'] not in licensed_seen:licensed_unique.append(r);licensed_seen.add(r['hash'])
licensed_train,licensed_evaluation=grouped_train_evaluation_split(licensed_unique) if licensed_unique else ([],[])
india=load_fraud_call_india_records(DATA/'fraud-call-india'/'records.json')
india=[r for r in india if r['hash'] not in base_hashes|ncsu_seen]
india_train,india_remainder=grouped_train_evaluation_split(india,train_fraction=.7) if india else ([],[])
india_calibration,india_evaluation=grouped_train_evaluation_split(india_remainder,train_fraction=.5) if india_remainder else ([],[])
training=train+ncsu_train+licensed_train+india_train
vectorizer=make_pipeline(
    FeatureUnion([
        ('word',TfidfVectorizer(ngram_range=(1,2),min_df=2,max_df=.99,max_features=40000,sublinear_tf=True,strip_accents='unicode')),
        ('char',TfidfVectorizer(analyzer='char_wb',ngram_range=(3,5),min_df=3,max_features=60000,sublinear_tf=True,strip_accents='unicode')),
    ]),
    Normalizer(copy=False),
)
X=vectorizer.fit_transform([r['text'] for r in training]);y=np.array([r['label'] for r in training])
weights=np.array(source_class_balanced_weights(training))
model=LogisticRegression(C=4,max_iter=1500,random_state=42).fit(X,y,sample_weight=weights)
names=vectorizer.get_feature_names_out()
def predict(rows):return model.predict_proba(vectorizer.transform([r['text'] for r in rows]))[:,1]
devp=predict(dev);india_calibration_p=predict(india_calibration) if india_calibration else np.array([])
calibration_rows=dev+india_calibration
calibration_p=np.concatenate([devp,india_calibration_p])
# Choose operating thresholds using development/calibration only, never test.
candidates=np.arange(.15,.851,.025)
threshold=max(candidates,key=lambda t:(metrics([r['label'] for r in calibration_rows],calibration_p,t)['balanced_accuracy'],-abs(t-.5)))
def risk_thresholds(labels,scores,binary_threshold,max_high_error=0,max_low_error=.01):
    labels=np.asarray(labels);scores=np.asarray(scores)
    if max_high_error==0:
        high=max(float(binary_threshold),float(np.nextafter(scores[labels==0].max(),np.inf)))
    else:
        high=binary_threshold
        for value in np.linspace(binary_threshold,.99,1000):
            assigned=scores>=value
            if assigned.any() and float(np.mean(labels[assigned]==0))<=max_high_error:
                high=float(value);break
    low=binary_threshold
    for value in np.linspace(.01,binary_threshold,1000):
        assigned=scores<=value
        if assigned.any() and float(np.mean(labels[assigned]==1))<=max_low_error:
            low=float(value)
    if low>=high:
        low=min(float(binary_threshold)-.01,low);high=max(float(binary_threshold)+.01,high)
    return low,high
low_threshold,high_threshold=risk_thresholds([r['label'] for r in calibration_rows],calibration_p,float(threshold))
def band_metrics(rows,scores):
    labels=np.asarray([r['label'] for r in rows]);scores=np.asarray(scores)
    low=scores<=low_threshold;high=scores>=high_threshold;assigned=low|high
    return {'n':len(rows),'low_risk':int(low.sum()),'high_risk':int(high.sum()),'inconclusive':int((~assigned).sum()),
      'direct_coverage':float(assigned.mean()),'assigned_accuracy':float(np.mean(np.where(high,1,0)[assigned]==labels[assigned])) if assigned.any() else None,
      'high_risk_precision':float(np.mean(labels[high]==1)) if high.any() else None,'low_risk_negative_predictive_value':float(np.mean(labels[low]==0)) if low.any() else None}
report={'model':'TF-IDF word/bigram + character 3-5 gram logistic regression','trained_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'inputs':'Caller transcript text only. No audio, labels, scenario types, personalities, IDs or filenames are model features.',
 'train_count':len(training),'development_count':len(dev),'calibration_count':len(calibration_rows),'training_source':'BothBosu train plus campaign-disjoint NCSU/FTC transcripts and deduplicated Fraud Call India text',
 'threshold':float(threshold),'low_risk_threshold':low_threshold,'high_risk_threshold':high_threshold,'risk_band_policy':'High-risk requires zero assigned false positives on calibration; low-risk permits at most 1% assigned misses and is withheld when explicit rules conflict; middle scores receive an elevated-risk caution classification.',
 'exact_duplicates_removed':len(raw)-len(train_pool),'training_ids':[r['id'] for r in training],'development_ids':[r['id'] for r in dev],
 'training_sources':{'bothbosu':len(train),'ncsu_ftc_weak_positive':len(ncsu_train),'fraud_call_india_cc0':len(india_train),'approved_licensed_corpora':len(licensed_train)},
 'calibration_sources':{'bothbosu_development':len(dev),'fraud_call_india_cc0':len(india_calibration)},
 'supported_languages':sorted({r.get('language','en') for r in training}),
 'weighting':'Equal total weight per label, then equal weight per source within each label.',
 'limitations':['BothBosu corpora are synthetically generated English calls; NCSU/FTC adds real robocall transcripts but not benign controls or per-call adjudication.',
 'Scenario family is correlated with label (e.g. refund versus appointment). The classifier may learn topic shortcuts.',
 'NCSU/FTC examples are source-level suspected-illegal positive labels with no per-call adjudication or benign controls.',
 'Fraud Call India contributes CC0 publisher-labelled text, not verified human-call audio; its labels lack independent adjudication and matched-topic metadata.',
 'NCSU campaign groups are held out, but positive-only sensitivity cannot measure specificity or a false-positive rate.',
 'Vocabulary overlap and related templates can inflate published-split performance; transfer corpus also shares scenario families.',
 'Binary scam labels do not supervise the six manipulation categories; those remain separately identified rule evidence.',
 'Model scores are distribution-specific, not calibrated real-world fraud probabilities.']}
report['development']=metrics([r['label'] for r in dev],devp,threshold)
report['calibration']=metrics([r['label'] for r in calibration_rows],calibration_p,threshold)
testp=predict(official_test);report['published_test']=metrics([r['label'] for r in official_test],testp,threshold)
report['published_test_risk_bands']=band_metrics(official_test,testp)
ncsup=predict(ncsu_evaluation)
report['ncsu_campaign_holdout']={
 'n':len(ncsu_evaluation),'positive':len(ncsu_evaluation),'negative':0,
 'campaign_groups':len({r['group'] for r in ncsu_evaluation}),
 'sensitivity':float(np.mean(ncsup>=threshold)),
 'mean_score':float(np.mean(ncsup)),'minimum_score':float(np.min(ncsup)),
 'note':'Positive-only suspected-illegal robocalls from FTC cases excluded from training. This cannot estimate specificity or precision.'}
report['ncsu_source_inventory']={'rows':len(ncsu),'english':len(ncsu_english),'non_english_excluded':len(ncsu)-len(ncsu_english),'unique_english':len(ncsu_unique)}
if india_evaluation:
    indiap=predict(india_evaluation);report['fraud_call_india_holdout']=metrics([r['label'] for r in india_evaluation],indiap,threshold)
    report['fraud_call_india_risk_bands']=band_metrics(india_evaluation,indiap)
if licensed_evaluation:
        licensedp=predict(licensed_evaluation);labels=[r['label'] for r in licensed_evaluation]
        report['licensed_corpus_holdout']=metrics(labels,licensedp,threshold) if len(set(labels))==2 else {
            'n':len(labels),'positive':sum(labels),'negative':len(labels)-sum(labels),
            'positive_detection_rate':float(np.mean(licensedp>=threshold)) if labels[0]==1 else None,
            'negative_false_alarm_rate':float(np.mean(licensedp>=threshold)) if labels[0]==0 else None,
            'note':'Single-class holdout; balanced metrics are unavailable.'}
# Diagnostic: quarantine close lexical neighbors from evaluation, while retaining full test results.
testX=vectorizer.transform([r['text'] for r in official_test]);nearest=(testX@X.T).max(axis=1).toarray().ravel()
novel=np.where(nearest<.85)[0]
report['near_duplicate_diagnostic']={'cosine_cutoff':.85,'near_training_neighbors':int((nearest>=.85).sum()),'less_similar_test':metrics([official_test[i]['label'] for i in novel],testp[novel],threshold) if len(novel) and len({official_test[i]['label'] for i in novel})==2 else None}
used={r['hash'] for r in train+dev};transfer=[r for r in transfer if r['hash'] not in used]
transferp=predict(transfer);report['transfer_test']=metrics([r['label'] for r in transfer],transferp,threshold)
report['per_scenario_test']={k:metrics([r['label'] for r in official_test if r['type']==k],testp[[i for i,r in enumerate(official_test) if r['type']==k]],threshold) if len({r['label'] for r in official_test if r['type']==k})==2 else {'n':sum(r['type']==k for r in official_test),'accuracy':float(np.mean((testp[[i for i,r in enumerate(official_test) if r['type']==k]]>=threshold)==[r['label'] for r in official_test if r['type']==k]))} for k in sorted({r['type'] for r in official_test})}
prefix_report=[]
for count in [1,2,3]:
    texts=['\n'.join([t['text'] for t in r['turns'] if t['role']=='caller'][:count]) for r in official_test]
    p=model.predict_proba(vectorizer.transform(texts))[:,1]
    prefix_report.append({'caller_turns':count,**metrics([r['label'] for r in official_test],p,threshold),'note':'Conversation-level labels; early turns may not yet contain a malicious request.'})
report['prefix_diagnostic']=prefix_report
joblib.dump({'vectorizer':vectorizer,'model':model,'train_rows':training,'train_X':X,'threshold':float(threshold),'low_risk_threshold':low_threshold,'high_risk_threshold':high_threshold},MODELS/'intent.joblib')
def export_row(r,p,split):return {**{k:v for k,v in r.items() if k not in ('text','hash')},'evaluation_split':split,'model_score':float(p),'prediction':int(p>=threshold)}
examples=[export_row(r,p,'published test') for r,p in zip(official_test,testp)]+[export_row(r,p,'transfer test') for r,p in zip(transfer,transferp)]
(MODELS/'text_examples.json').write_text(json.dumps(examples,ensure_ascii=False),encoding='utf-8')
(MODELS/'text_report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({k:report[k] for k in ['train_count','development_count','published_test','transfer_test','near_duplicate_diagnostic']},indent=2))
