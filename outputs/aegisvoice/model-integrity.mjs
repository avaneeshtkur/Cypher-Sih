import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';

const assets=[
  ['pellaV2','checkpointSha256','pella-v2/pellav2_detector.pt','deepfake'],
  ['wav2vec2XlsR300m','checkpointSha256','wav2vec2-xls-r-300m/pytorch_model.bin','deepfake'],
  ['aasist','checkpointSha256','../quarantine/aasist/models/weights/AASIST.pth','deepfake'],
  ['ecapaTdnn','embeddingSha256','ecapa-tdnn/embedding_model.ckpt','speaker'],
  ['fasterWhisperTinyEn','modelSha256','faster-whisper-tiny.en/model.bin','asr']
];
function fileHash(filename){return new Promise((resolve,reject)=>{const hash=createHash('sha256'),stream=createReadStream(filename);stream.on('data',chunk=>hash.update(chunk));stream.once('error',reject);stream.once('end',()=>resolve(hash.digest('hex')));});}
const cache=new Map();
async function inspectThirdPartyModels(root){
  const manifest=JSON.parse(await readFile(path.join(root,'models','third_party_models.json'),'utf8')),modelRoot=path.resolve(root,'..','..','work','models'),results={},errors=[];
  for(const [model,key,relative,capability] of assets){const filename=path.resolve(modelRoot,relative),expected=manifest.models?.[model]?.[key];try{const actual=await fileHash(filename),ok=actual===expected;results[model]={ok,capability,filename:path.basename(filename),expected,actual};if(!ok)errors.push(`${model} hash mismatch`);}catch(error){results[model]={ok:false,capability,filename:path.basename(filename),expected,error:error.code||error.message};errors.push(`${model} unavailable`);}}
  return {verified:errors.length===0,results,errors,checkedAt:new Date().toISOString()};
}
export function verifyThirdPartyModels(root){const key=path.resolve(root);if(!cache.has(key))cache.set(key,inspectThirdPartyModels(key));return cache.get(key);}
