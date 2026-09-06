import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.join(appRoot,'database-audio');
await mkdir(output,{recursive:true});
const sha256=data=>createHash('sha256').update(data).digest('hex');
async function download(url,file){
  const response=await fetch(url);if(!response.ok)throw new Error(`${response.status} downloading ${url}`);
  const data=Buffer.from(await response.arrayBuffer());await writeFile(path.join(output,file),data);return data;
}
function parseCsv(text){
  const rows=[];let row=[],value='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(value);value='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(value);if(row.some(Boolean))rows.push(row);row=[];value='';}else value+=c;}
  if(value||row.length){row.push(value);rows.push(row);}const headers=rows.shift();return rows.map(values=>Object.fromEntries(headers.map((header,index)=>[header,values[index]??''])));
}

const ncsuBase='https://raw.githubusercontent.com/wspr-ncsu/robocall-audio-dataset/main/';
const metadataBytes=await download(`${ncsuBase}metadata.csv`,'ncsu-metadata.csv');
const metadata=parseCsv(metadataBytes.toString('utf8'));
const selected=['1112259_normalized.wav','520125_normalized.wav','598182_normalized.wav','660764_normalized.wav','241125_normalized.wav','274452_normalized.wav'];
const samples=[];
for(const [index,name] of selected.entries()){
  const record=metadata.find(row=>row.file_name?.endsWith('/'+name));if(!record)throw new Error(`Missing NCSU metadata for ${name}`);
  const file=`ncsu-${String(index+1).padStart(2,'0')}.wav`,data=await download(`${ncsuBase}${record.file_name}`,file);
  samples.push({id:`ncsu-${index+1}`,title:`NCSU real robocall ${index+1}`,file,source:'NCSU / FTC Robocall Audio Dataset',sourceUrl:'https://github.com/wspr-ncsu/robocall-audio-dataset',provenance:'Real-world deployed automated or semi-automated robocall recording',voiceOrigin:'Human versus synthesized voice is not independently labelled',fraudContext:'Suspected illegal/malicious robocall',language:record.language||'en',publisherTranscript:record.transcript,license:'Data public domain; documentation CC BY-ND 4.0',bytes:data.length,sha256:sha256(data)});
}

const manifest={schemaVersion:'1.0',generatedAt:new Date().toISOString(),samples,sourceStatus:[
  {name:'NCSU / FTC Robocall Audio Dataset',status:'bundled',count:selected.length,kind:'real-world malicious robocall audio'},
  {name:'INDICA',status:'excluded from showcase',count:0,kind:'synthetic TTS Indian scam audio',reason:'The available samples were not suitable as real-human demonstration audio.'},
  {name:'WiserBrand Hindi Call Center Conversation Dataset',status:'access required',count:0,kind:'claimed authentic human control audio',reason:'Databricks Marketplace access and applicable licence are required before files can be bundled.'},
  {name:'FutureBeeAI Indian English BFSI',status:'commercial access required',count:0,kind:'claimed authentic human control audio',reason:'The vendor page describes the product but provides no downloadable licensed audio files.'}
]};
await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({samples:samples.length,ncsu:selected.length,indica:0,output},null,2));
