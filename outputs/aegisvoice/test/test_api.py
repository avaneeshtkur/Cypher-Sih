"""Run against the local server. Tests use downloaded records, never canned scores."""
import io, json, os, sys, time, urllib.request, urllib.error, wave
from pathlib import Path
APP=Path(__file__).resolve().parents[1];BASE=os.environ.get('AEGIS_TEST_URL','http://127.0.0.1:4173')
checks=[]
def check(value,message):
    if not value:raise AssertionError(message)
    checks.append(message);print('PASS:',message,flush=True)
def get(route):return urllib.request.urlopen(BASE+route,timeout=125)
def post(route,payload,origin=None):
    binary=isinstance(payload,bytes);headers={'Content-Type':'application/octet-stream' if binary else 'application/json'}
    if origin:headers['Origin']=origin
    return urllib.request.urlopen(urllib.request.Request(BASE+route,data=payload if binary else json.dumps(payload).encode(),headers=headers),timeout=125)

status=json.load(get('/api/status'));check(status['intent'] and status['replay'] and status['asr'],'All three local models are ready')
reports=json.load(get('/api/reports'));check(reports['intent']['published_test']['n']==320 and reports['replay']['held_out_test']['n']==13306,'API serves actual evaluation reports')
check(json.load(get('/api/dataset/text?limit=1'))['total']>=1920,'Trained evaluations and external India text records are accessible')
check(json.load(get('/api/dataset/audio?limit=1'))['total']==13306,'All 13,306 audio evaluation records accessible')
for label in [0,1]:
    row=json.load(get(f'/api/dataset/text?label={label}&limit=1'))['rows'][0]
    prediction=json.load(post('/api/intent',{'turns':row['turns']}))
    check(abs(prediction['score']-row['model_score'])<1e-10,f'Public text label {label}: fresh inference reproduces saved score')
    tampered=json.load(post('/api/intent',{'turns':row['turns'],'label':1-label,'id':'attacker-controlled','prediction':1-label}))
    check(abs(tampered['score']-prediction['score'])<1e-10,f'Public text label {label}: supplied label/ID cannot alter prediction')
for label in [0,1]:
    row=json.load(get(f'/api/dataset/audio?label={label}&limit=1'))['rows'][0]
    raw=get('/api/dataset/audio/'+row['id']).read();check(raw[:4]==b'RIFF',f'Public audio label {label}: endpoint returns actual WAV bytes')
    result=json.load(post('/api/replay',raw))
    check(abs(result['score']-row['model_score'])<.0001,f'Public audio label {label}: waveform inference reproduces saved score')
    if label==0:
        asr=json.load(post('/api/transcribe',raw));check(bool(asr.get('segments')) and bool(asr.get('text')), 'ASR transcribes a downloaded genuine recording')
text_errors=json.load(get('/api/dataset/text?errors=1&limit=12'))
expected_text_errors=sum(part['confusion']['fp']+part['confusion']['fn'] for part in [reports['intent']['published_test'],reports['intent']['transfer_test']])
check(text_errors['total']==expected_text_errors and all(r['label']!=r['prediction'] for r in text_errors['rows']),'Text errors filter exposes every saved binary mistake')
audio_errors=json.load(get('/api/dataset/audio?errors=1&limit=12'))
check(audio_errors['total']==4515 and all(r['label']!=r['prediction'] for r in audio_errors['rows']),'Audio errors filter exposes all 4,515 binary mistakes')
out=io.BytesIO()
with wave.open(out,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\0\0'*32000)
check(json.load(post('/api/replay',out.getvalue()))['status']=='Uncertain','Silence abstains from replay classification')
check(json.load(post('/api/transcribe',out.getvalue()))['text']=='','Silence produces no fabricated transcript')
for payload,origin,expected in [(b'',None,400),(b'x','https://unrelated.example',403)]:
    try:post('/api/replay',payload,origin);raise AssertionError('Expected rejection')
    except urllib.error.HTTPError as e:check(e.code==expected,f'Invalid or foreign-origin replay request rejected: {expected}')
for route in ['/api/dataset/audio/not-a-file','/models/intent.joblib','/../server.mjs']:
    try:get(route);raise AssertionError('Expected 404')
    except urllib.error.HTTPError as e:check(e.code==404,f'No unintended file exposure: {route}')
result={'tested_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'passed':len(checks),'checks':checks,'scope':'Live HTTP/model integration using actual public text and WAV records; hardware microphone capture not tested.'}
(APP/'models'/'api_validation.json').write_text(json.dumps(result,indent=2))
print(json.dumps({'passed':len(checks)},indent=2))
