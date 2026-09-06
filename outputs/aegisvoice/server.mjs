import http from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createReadiness, readableFile, pythonEnvironment, validateAsrBackend } from './server-readiness.mjs';
import { sendAudio } from './audio-response.mjs';
import { auditHumanVishingCorpus } from './human-vishing-coverage.mjs';
import { verifyThirdPartyModels } from './model-integrity.mjs';
import { MAX_MEDIA_BYTES } from './media-input.mjs';

const root=path.dirname(fileURLToPath(import.meta.url)),workspace=path.resolve(root,'../..');
const port=Number(process.env.PORT||4173);

export function resolveRuntimeSettings(options={}){
  const base=path.resolve(options.workspace??workspace),env=options.env??process.env;
  const configPath=options.configPath===null?null:path.resolve(base,options.configPath??path.join('work','runtime.json'));
  let config={};
  if(configPath){
    let contents;
    try{contents=readFileSync(configPath,'utf8');}
    catch(error){if(error.code!=='ENOENT')throw new Error(`Cannot read local runtime configuration ${configPath}: ${error.message}`,{cause:error});}
    if(contents!==undefined){
      try{config=JSON.parse(contents.replace(/^\uFEFF/,''));}
      catch(error){throw new Error(`Invalid local runtime configuration ${configPath}: ${error.message}`,{cause:error});}
      if(!config||typeof config!=='object'||Array.isArray(config))throw new Error(`Local runtime configuration ${configPath} must be a JSON object.`);
      for(const key of ['python','asrBackend','speechModel']){
        if(Object.hasOwn(config,key)&&(typeof config[key]!=='string'||!config[key].trim()))throw new Error(`Local runtime configuration ${key} must be a nonempty string.`);
      }
      if(Object.hasOwn(config,'asrBackend'))validateAsrBackend(config.asrBackend);
    }
  }
  const explicit=options.readiness??{};
  const asrBackend=validateAsrBackend(options.asrBackend??explicit.asrBackend??env.AEGIS_ASR_BACKEND??config.asrBackend??'faster-whisper');
  const pythonOverride=options.python??explicit.python??env.AEGIS_ASR_PYTHON;
  const python=pythonOverride??config.python??path.join('work','asr-runtime','Scripts','python.exe');
  const speechModel=options.speechModel??explicit.speechModel??env.AEGIS_ASR_MODEL??config.speechModel??path.join('work','asr-model');
  for(const [key,value] of Object.entries({python,speechModel})){
    if(typeof value!=='string'||!value.trim())throw new Error(`Configured ${key} must be a nonempty string.`);
  }
  // Preserve bare interpreter commands from options/environment; persisted paths are workspace-relative.
  return {workspace:base,asrBackend,python:pythonOverride!==undefined&&!/[\\/]/.test(python)?python:path.resolve(base,python),speechModel:path.resolve(base,speechModel)};
}

export function createAegisServer(options={}){
const {python,speechModel,asrBackend,workspace:runtimeWorkspace}=resolveRuntimeSettings(options);
const modelIntegrity=(options.verifyModels??verifyThirdPartyModels)(root).catch(error=>({verified:false,results:{},errors:[error.message],checkedAt:new Date().toISOString()}));
const env=pythonEnvironment(asrBackend,options.env??process.env),spawnProcess=options.spawnProcess??spawn;
const audioDirectory=path.join(runtimeWorkspace,'work','datasets','asvspoof2017','extracted','ASVspoof2017_V2_eval');
const readiness=createReadiness({root,audioDirectory,...options.readiness,python,speechModel,asrBackend,env});
const allowed=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/dataset-lab.js',['dataset-lab.js','text/javascript']],['/engine.mjs',['engine.mjs','text/javascript']],['/style.css',['style.css','text/css']]]);
const tasks=new Set();
for(const name of ['live-call.js','audio-core.mjs','media-input.mjs','evidence-boundary.mjs','pcm-worklet.js','liveness-core.mjs','lang-intent.mjs','reasoning.mjs','workspace.js','demo-session.mjs','decision.mjs','demos.js','attack-model.mjs','attack-lab.js','attack-simulations.mjs','case-library.mjs','visuals.js'])allowed.set('/'+name,[name,'text/javascript']);
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const artifact=async name=>JSON.parse(await readFile(path.join(root,'models',name),'utf8'));
const samplePath=record=>typeof record.filename==='string'&&path.basename(record.filename)===record.filename?path.join(audioDirectory,record.filename):null;
async function body(req,limit){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Input exceeds size limit.'),{status:413});chunks.push(chunk);}if(!size)throw Object.assign(new Error('No input received.'),{status:400});return Buffer.concat(chunks);}
function runPython(args,payload,timeoutMs=120000,signal){return new Promise((resolve,reject)=>{
  const child=spawnProcess(python,args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env});let out='',err='',settled=false,timer;
  const finish=(action,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);action(value);};
  const abort=()=>{child.kill();finish(reject,Object.assign(new Error('Local inference cancelled.'),{status:499}));};
  if(signal?.aborted){abort();return;}
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>{child.kill();finish(reject,new Error('Local inference timed out. Use a shorter clip.'));},timeoutMs);
  child.stdout.on('data',d=>{out+=d;if(out.length>2e6)child.kill();});child.stderr.on('data',d=>{if(err.length<4000)err+=d;});
  child.on('error',()=>finish(reject,Object.assign(new Error('Configured Python runtime is unavailable.'),{status:503})));
  child.on('close',code=>{let parsed;try{parsed=JSON.parse(out);}catch{}if(code||!parsed||parsed.error){
    const unavailable=/ModuleNotFoundError|ImportError|No module named|No such file or directory|cannot find the (?:file|path)/i.test(`${parsed?.error||''}\n${err}`);
    finish(reject,Object.assign(new Error(unavailable?'Required local runtime dependencies or assets are unavailable.':parsed?.error||'Could not process this input. Check the local model setup and audio format.'),{status:unavailable?503:500}));return;
  }finish(resolve,parsed);});
  child.stdin.on('error',()=>{});child.stdin.end(payload);
});}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost'),pathname=url.pathname;
    if(pathname.startsWith('/api/')&&req.method==='POST'){
      const origin=req.headers.origin;
      const listeningPort=server.address()?.port||port;
      if(origin&&![`http://127.0.0.1:${listeningPort}`,`http://localhost:${listeningPort}`].includes(origin)){json(res,403,{error:'Origin not allowed'});return;}
    }
    if(pathname==='/api/status'&&req.method==='GET'){
      const ready=await readiness(),integrity=await modelIntegrity,reported={...ready,reasons:{...ready.reasons}};
      for(const capability of ['deepfake','speaker',...(asrBackend==='faster-whisper'?['asr']:[])])if(Object.values(integrity.results).some(item=>item.capability===capability&&!item.ok)){reported[capability]=false;reported.reasons[capability]=`${capability} model integrity verification failed.`;}
      let intentLanguages=['en'];
      try{const report=await artifact('text_report.json');if(Array.isArray(report.supported_languages)&&report.supported_languages.length)intentLanguages=report.supported_languages;}
      catch{}
      json(res,200,{...reported,intentLanguages,modelIntegrity:integrity,version:'0.3.0'});return;
    }
    if(pathname==='/api/demos'&&req.method==='GET'){
      try{json(res,200,JSON.parse((await readFile(path.join(root,'demo-audio','manifest.json'),'utf8')).replace(/^\uFEFF/,'')));}
      catch{json(res,503,{error:'Saved demo manifest is unavailable.'});}return;
    }
    if(pathname==='/api/database-audio'&&req.method==='GET'){
      try{json(res,200,JSON.parse(await readFile(path.join(root,'database-audio','manifest.json'),'utf8')));}
      catch{json(res,503,{error:'Bundled database-audio manifest is unavailable.'});}return;
    }
    if(pathname==='/api/reports'&&req.method==='GET'){
      const result={};for(const [key,file] of Object.entries({sources:'sources.json',intent:'text_report.json',replay:'audio_report.json',mendeleyDeepfake:'mendeley_deepfake_report.json',rules:'rules_benchmark.json',channel:'channel_calibration.json',attack:'attack_calibration.json'})){
        try{result[key]=await artifact(file);}catch{result[key]=null;}
      }json(res,200,result);return;
    }
    if(pathname==='/api/human-vishing-coverage'&&req.method==='GET'){
      const candidate=path.join(runtimeWorkspace,'work','datasets','human-vishing','manifest.json');
      const fallback=path.join(root,'models','human_vishing_manifest.example.json');
      let manifest,source='unpopulated template',corpusRoot=path.dirname(fallback);
      try{manifest=JSON.parse(await readFile(candidate,'utf8'));source='local partner manifest';corpusRoot=path.dirname(candidate);}
      catch(error){if(error.code!=='ENOENT'){json(res,500,{source:'invalid local partner manifest',deploymentValidated:false,evaluationReady:false,evidencePackageComplete:false,errors:[error.message],gaps:['The local manifest cannot be audited.']});return;}manifest=JSON.parse(await readFile(fallback,'utf8'));}
      json(res,200,{source,...await auditHumanVishingCorpus(manifest,corpusRoot)});return;
    }
    if(['/api/dataset/text','/api/dataset/audio'].includes(pathname)&&req.method==='GET'){
      const audio=pathname.endsWith('audio');let rows=await artifact(audio?'audio_examples.json':'text_examples.json');
      if(!audio){
        try{rows=rows.concat(JSON.parse(await readFile(path.join(runtimeWorkspace,'work','datasets','fraud-call-india','records.json'),'utf8')));}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      if(url.searchParams.has('label')&&['0','1'].includes(url.searchParams.get('label')))rows=rows.filter(r=>r.label===Number(url.searchParams.get('label')));
      if(url.searchParams.get('source'))rows=rows.filter(r=>r.source===url.searchParams.get('source'));
      if(url.searchParams.get('errors')==='1')rows=rows.filter(r=>Number.isInteger(r.prediction)&&r.label!==r.prediction);
      const total=rows.length,offset=Math.max(0,parseInt(url.searchParams.get('offset')||'0')||0),limit=Math.min(50,Math.max(1,parseInt(url.searchParams.get('limit')||'12')||12));
      let pageRows=rows.slice(offset,offset+limit);
      if(audio)pageRows=await Promise.all(pageRows.map(async record=>({...record,audioAvailable:Boolean(samplePath(record)&&await readableFile(samplePath(record)))})));
      json(res,200,{total,offset,rows:pageRows});return;
    }
    if(pathname.startsWith('/api/dataset/audio/')&&['GET','HEAD'].includes(req.method)){
      const id=decodeURIComponent(pathname.split('/').pop());const rows=await artifact('audio_examples.json');const record=rows.find(r=>r.id===id);
      if(!record){json(res,404,{error:'Unknown audio sample'});return;}
      const filename=samplePath(record);
      if(!filename||!await readableFile(filename)){json(res,503,{error:'This dataset recording is unavailable locally. Its saved metadata can still be browsed.'});return;}
      await sendAudio(req,res,filename);return;
    }
    if(pathname.startsWith('/demo-audio/')&&['GET','HEAD'].includes(req.method)){
      const name=pathname.slice('/demo-audio/'.length);
      if(!['payment-pressure.wav','legitimate-payment.wav','digital-arrest.wav','refund-lure.wav'].includes(name)){json(res,404,{error:'Not found'});return;}
      await sendAudio(req,res,path.join(root,'demo-audio',name));return;
    }
    if(pathname.startsWith('/database-audio/')&&['GET','HEAD'].includes(req.method)){
      const name=decodeURIComponent(pathname.slice('/database-audio/'.length));
      let manifest;try{manifest=JSON.parse(await readFile(path.join(root,'database-audio','manifest.json'),'utf8'));}catch{json(res,503,{error:'Bundled database-audio manifest is unavailable.'});return;}
      if(path.basename(name)!==name||!manifest.samples?.some(sample=>sample.file===name)){json(res,404,{error:'Unknown database audio sample'});return;}
      await sendAudio(req,res,path.join(root,'database-audio',name));return;
    }
    const cmd={'/api/intent':'intent','/api/replay':'replay','/api/transcribe':'transcribe','/api/deepfake':'deepfake','/api/speaker':'speaker'}[pathname];
    if(cmd&&req.method==='POST'){
      if(tasks.has(cmd)){json(res,429,{error:'This local model is already processing a request. Try again shortly.'});return;}
      tasks.add(cmd);
      const requestAbort=new AbortController();
      const abortRequest=()=>requestAbort.abort();
      req.once('aborted',abortRequest);
      res.once('close',()=>{if(!res.writableEnded)abortRequest();});
      try{
        const status=await readiness(),key=cmd==='transcribe'?'asr':cmd;
        if(!status[key]){json(res,503,{error:status.reasons[key],capability:key,available:false});return;}
        if(['deepfake','speaker','transcribe'].includes(cmd)&&!(cmd==='transcribe'&&asrBackend==='openai-whisper')){const integrity=await modelIntegrity,needed=Object.values(integrity.results).filter(item=>item.capability===key);if(!needed.length||needed.some(item=>!item.ok)){json(res,503,{error:`${key} model integrity verification failed.`,capability:key,available:false});return;}}
        const payload=await body(req,cmd==='intent'?500000:cmd==='speaker'?MAX_MEDIA_BYTES*2+4:MAX_MEDIA_BYTES);
        const args=cmd==='transcribe'?[path.join(root,'transcribe.py'),speechModel]:
          ['deepfake','speaker'].includes(cmd)?[path.join(root,'ml/audio_models.py'),cmd]:[path.join(root,'ml/infer.py'),cmd];
        // The offline medium checkpoint is a batch CPU backend, not a real-time engine.
        const result=await runPython(args,payload,cmd==='transcribe'&&asrBackend==='openai-whisper'?240000:300000,requestAbort.signal);
        if(!requestAbort.signal.aborted)json(res,200,result);
      }finally{tasks.delete(cmd);}return;
    }
    const entry=allowed.get(pathname);
    if(req.method!=='GET'||!entry){json(res,404,{error:'Not found'});return;}
    const data=await readFile(path.join(root,entry[0]));res.writeHead(200,{'Content-Type':`${entry[1]}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});res.end(data);
  }catch(error){if(!res.headersSent&&!res.destroyed)json(res,error.status||500,{error:error.message});else if(!res.writableEnded&&!res.destroyed)res.end();}
});
return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const server=createAegisServer();
server.listen(port,'127.0.0.1',()=>{
  const listeningPort=server.address().port;
  console.log(`AegisVoice v0.3 running at http://127.0.0.1:${listeningPort}`);
  if(process.argv.includes('--open')&&process.platform==='win32'){const opener=spawn('explorer.exe',[`http://127.0.0.1:${listeningPort}`],{windowsHide:true,stdio:'ignore'});opener.on('error',()=>{});opener.unref();}
});
}
