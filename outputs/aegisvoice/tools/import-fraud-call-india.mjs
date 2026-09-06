import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workspace=path.resolve(appRoot,'../..');
const datasetRoot=path.join(workspace,'work','datasets','fraud-call-india');
const sourcePath=path.join(datasetRoot,'source','fraud_call.file');
const zipPath=path.join(datasetRoot,'fraud-call-india-dataset.zip');
const outputPath=path.join(datasetRoot,'records.json');
const manifestPath=path.join(datasetRoot,'manifest.json');
const sha256=data=>createHash('sha256').update(data).digest('hex');

const [source,archive]=await Promise.all([readFile(sourcePath),readFile(zipPath)]);
const records=[];
for(const [index,line] of source.toString('utf8').split(/\r?\n/).entries()){
  if(!line.trim())continue;
  const separator=line.indexOf('\t');
  if(separator<1)throw new Error(`Malformed dataset row ${index+1}`);
  const sourceLabel=line.slice(0,separator).trim().toLowerCase();
  const text=line.slice(separator+1).trim();
  if(!['fraud','normal'].includes(sourceLabel)||!text)throw new Error(`Invalid dataset row ${index+1}`);
  records.push({
    id:`fraud-call-india-${String(records.length+1).padStart(4,'0')}`,
    source:'fraud_call_india_kaggle',source_row:index+1,published_split:'unspecified',
    turns:[{role:'caller',text}],label:sourceLabel==='fraud'?1:0,type:'publisher label',
    evaluation_split:'external corpus · split unspecified',model_score:null,prediction:null
  });
}
const counts={fraud:records.filter(row=>row.label===1).length,normal:records.filter(row=>row.label===0).length};
const manifest={
  schema_version:'1.0',dataset_name:'Fraud Call Detection Dataset',
  source_url:'https://www.kaggle.com/datasets/narayanyadav/fraud-call-india-dataset/data',
  kaggle_ref:'narayanyadav/fraud-call-india-dataset',license:'CC0: Public Domain',
  downloaded_at:new Date().toISOString(),archive_sha256:sha256(archive),source_sha256:sha256(source),
  source_bytes:source.length,records:records.length,labels:counts,
  modality:'text',audio_files:0,conversation_structure:'one utterance per record',
  provenance_limitations:[
    'The publisher provides no audio files in this release.',
    'The release does not document speaker identity, collection method, consent, call channel, language, annotators, or train/test groups.',
    'Labels are publisher-provided and have not been independently adjudicated.',
    'Records therefore support auxiliary India-oriented fraud-language testing, not interactive human-vishing or acoustic validation.'
  ]
};
await mkdir(datasetRoot,{recursive:true});
await Promise.all([
  writeFile(outputPath,JSON.stringify(records,null,2)+'\n'),
  writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n')
]);
console.log(JSON.stringify(manifest,null,2));
