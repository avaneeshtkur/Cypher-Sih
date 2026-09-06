import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {auditHumanVishingCorpus} from '../human-vishing-coverage.mjs';
const filename=resolve(process.argv[2]||'../../work/datasets/human-vishing/manifest.json');
try{
  const result=await auditHumanVishingCorpus(JSON.parse(await readFile(filename,'utf8')),dirname(filename));
  console.log(JSON.stringify({file:filename,...result},null,2));
  if(result.errors.length||!result.evidencePackageComplete)process.exitCode=1;
}catch(error){console.error(JSON.stringify({file:filename,error:error.message},null,2));process.exitCode=1;}
