"""Download versioned public datasets; retain original bytes and checksums."""
import argparse, concurrent.futures, hashlib, json, time, urllib.request, zipfile
from pathlib import Path

APP=Path(__file__).resolve().parents[1]
WORK=APP.parents[1]/'work'
DATA=WORK/'datasets'
SOURCES=[
 ('scam_single','BothBosu/single-agent-scam-conversations','1debe2743472927cd4ed3bf39e8b0d8234bd5e3f',['README.md','single-agent-scam-dialogue_train.csv','single-agent-scam-dialogue_test.csv']),
 ('scam_multi','BothBosu/multi-agent-scam-conversation','709db2b6c37f424c3070f29138abb33971e21ab9',['README.md','agent_conversation_train.csv','agent_conversation_test.csv'])
]
ASV={
 'README_V2.txt':'ab9df60c-3909-4667-bff3-09b4925ea00a',
 'protocol_V2.zip':'dbf267c4-517e-4193-9cdf-c8eadc82ec78',
 'ASVspoof2017_V2_train.zip':'4c7e2262-fe78-497e-839f-0ceabbbf2d1e',
 'ASVspoof2017_V2_dev.zip':'4daef0d3-f9e8-49e4-9ffc-a7362842a8f2',
 'ASVspoof2017_V2_eval.zip':'77c52086-76ed-4517-a72a-cc94e54a2c0a'
}
MENDELEY={
 'Fake_ElevenLabs_Respeecher.zip':('ed91b7d0-c7aa-4ecb-9516-4ca7e968bb3e','4ff7910fa37dd4af6fb897a1fc8051936c25eaefbdfa288c43c4d93875e05cb1'),
 'metadata.xlsx':('510d1aa9-41f8-4291-8c86-a3b0b303d6c7','4676c37940e903ab503b2839310370e62307cb0bcb46e92c93615c76d12b3edb')
}
def download(entry):
    name,url,destination,license,revision=entry
    destination.parent.mkdir(parents=True,exist_ok=True)
    if not destination.exists():
        tmp=destination.with_suffix(destination.suffix+'.part')
        for attempt in range(3):
            try:
                offset=tmp.stat().st_size if tmp.exists() else 0
                request=urllib.request.Request(url,headers={'Range':f'bytes={offset}-'} if offset else {})
                with urllib.request.urlopen(request,timeout=90) as res:
                    resumed=offset>0 and getattr(res,'status',None)==206
                    with tmp.open('ab' if resumed else 'wb') as out:
                        total=offset if resumed else 0
                        if offset and not resumed:print(f'Server did not accept resume for {name}; restarting.',flush=True)
                        while block:=res.read(1024*1024):out.write(block);total+=len(block)
                tmp.replace(destination);break
            except Exception:
                if attempt==2:raise
                time.sleep(2)
        print(f'Downloaded {name}: {destination.stat().st_size:,} bytes',flush=True)
    h=hashlib.sha256()
    with destination.open('rb') as f:
        while block:=f.read(1024*1024):h.update(block)
    if destination.suffix=='.zip':
        target=destination.parent/'extracted';target.mkdir(exist_ok=True)
        with zipfile.ZipFile(destination) as z:
            for member in z.infolist():
                resolved=(target/member.filename).resolve()
                if not resolved.is_relative_to(target.resolve()):raise ValueError('Archive path escapes destination')
                if not resolved.exists():z.extract(member,target)
    return {'name':name,'url':url,'path':str(destination.relative_to(WORK)),'bytes':destination.stat().st_size,'sha256':h.hexdigest(),'license':license,'revision':revision}

def source_entries(include_audio=True):
    entries=[]
    for folder,repo,sha,files in SOURCES:
        for file in files:entries.append((folder+'/'+file,f'https://huggingface.co/datasets/{repo}/resolve/{sha}/{file}',DATA/folder/file,'Apache-2.0',sha))
    if include_audio:
        for file,id in ASV.items():entries.append(('asvspoof2017/'+file,f'https://datashare.ed.ac.uk/bitstreams/{id}/download',DATA/'asvspoof2017'/file,'CC-BY-NC-4.0','ASVspoof 2017 V2 · DOI 10.7488/ds/2332'))
        for file,(id,expected) in MENDELEY.items():entries.append(('mendeley-fake-audio/'+file,f'https://data.mendeley.com/public-files/datasets/79g59sp69z/files/{id}/file_downloaded',DATA/'mendeley-fake-audio-v1'/file,'CC BY 4.0',f'10.17632/79g59sp69z.1 · sha256 {expected}'))
    return entries

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--text-only',action='store_true',help='Download only the pinned conversation corpora.')
    parser.add_argument('--manifest',type=Path,default=APP/'models'/'sources.json')
    args=parser.parse_args()
    entries=source_entries(include_audio=not args.text_only)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:manifest=list(pool.map(download,entries))
    args.manifest.parent.mkdir(parents=True,exist_ok=True)
    if args.text_only and args.manifest.exists():
        previous=json.loads(args.manifest.read_text(encoding='utf-8'))
        downloaded={entry['name'] for entry in manifest}
        manifest.extend(entry for entry in previous.get('files',[]) if entry.get('name') not in downloaded)
    args.manifest.write_text(json.dumps({'retrieved_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'files':manifest},indent=2),encoding='utf-8')
    print('Source manifest saved.',flush=True)
