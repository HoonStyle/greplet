// node scripts/eval-workspace-routing.mjs <private-config.json>
// All question text, evidence, workspace identities and raw results stay in the private output directory.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const read = p => JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const runnerSha256 = sha(fs.readFileSync(new URL(import.meta.url)));
const norm = value => String(value??'').replaceAll('\\','/').toLowerCase();
const key = row => norm(row.abs)+'|'+row.id;
const config = read(process.argv[2]);
const dataFile = read(config.data), data = Array.isArray(dataFile) ? dataFile : dataFile.items;
const snapshot = read(config.snapshot), inventory = read(config.inventory);
const implementationHashes={};
for(const file of Object.keys(snapshot.compiledHashes)){
  const hash=sha(fs.readFileSync(snapshot.baseline+'/'+file));
  assert.equal(hash,snapshot.compiledHashes[file],`Frozen implementation changed: ${file}`);
  implementationHashes[file]=hash;
}
const {loadConfig}=await import(pathToFileURL(snapshot.baseline+'/config.js').href);
const {embedQuery}=await import(pathToFileURL(snapshot.baseline+'/embed.js').href);
const {routeWorkspaceVector}=await import(pathToFileURL(snapshot.baseline+'/routing.js').href);
assert.equal(data.length,config.expectedQuestions);
assert.equal(new Set(data.map(q=>q.id)).size,data.length);
if(config.dataHash) assert.equal(sha(fs.readFileSync(config.data)),config.dataHash);
if(config.stage==='test') {
  const freeze=read(config.freeze);
  assert.equal(freeze.testSha256,sha(fs.readFileSync(config.data)));
  assert.equal(freeze.runnerSha256,runnerSha256);
  assert.equal(freeze.candidate,config.candidate);
  assert.equal(freeze.catalogHash,config.catalogHash);
  assert.deepEqual(freeze.embedding,config.embedding);
  assert.equal(freeze.observerSha256,sha(fs.readFileSync(new URL('./retrieval-trace-hook.mjs',import.meta.url))));
  for(const [method,file]of Object.entries(config.models)) assert.equal(sha(fs.readFileSync(file)),freeze.models[method]);
}
assert(!fs.existsSync(config.output),'Use a fresh private output directory');
fs.mkdirSync(config.output,{recursive:true});
const models=Object.fromEntries(Object.entries(config.models).map(([name,file])=>[name,read(file)]));
const baseCfg={...loadConfig(),dbDir:snapshot.dbDir};
async function verifyEmbeddingIdentity(){
  if(!config.embedding) return;
  const expected=config.embedding;
  const configured=baseCfg.ollamaModel.includes(':')?baseCfg.ollamaModel:baseCfg.ollamaModel+':latest';
  assert.equal(configured,expected.name,'Embedding name changed');
  const response=await fetch(baseCfg.ollamaUrl+'/api/tags');assert(response.ok,'Embedding inventory unavailable');
  const tags=await response.json();
  assert(tags.models.some(m=>m.name===expected.name&&m.digest===expected.digest),'Embedding digest changed');
}
await verifyEmbeddingIdentity();
const workspaces=inventory.workspaces.map(w=>({slug:w.slug,label:w.label,kind:w.kind,roots:w.api.roots,
  includeExt:[],excludeDirs:[],excludeFiles:[],pdfPasswordFile:null}));
const scopes=workspaces.map(w=>w.slug);
const catalogHash=config.catalogHash;
const runtimes={};
for(const policy of config.policies){
  const runtime=path.join(path.dirname(snapshot.baseline),'routing-eval-'+policy+'-'+sha(JSON.stringify(config)).slice(0,12));
  assert(!fs.existsSync(runtime),'Never overwrite a runtime');
  fs.mkdirSync(runtime);
  for(const name of fs.readdirSync(snapshot.baseline).filter(x=>x.endsWith('.js')))
    fs.copyFileSync(snapshot.baseline+'/'+name,runtime+'/'+name);
  const sourceFile=runtime+'/search.js';let source=fs.readFileSync(sourceFile,'utf8');
  assert.equal(sha(source),snapshot.compiledHashes['search.js']);
  const once=(from,to)=>{assert.equal(source.split(from).length,2,`Instrumentation anchor: ${from}`);source=source.replace(from,to);};
  once('queryVector ??= embedQuery(cfg, query)','queryVector ??= (opts.getQueryVector ? opts.getQueryVector() : embedQuery(cfg, query))');
  once('.rerank(rr)','.rerank(observeReranker(rr))');
  once('const hits = perWs.flat().sort((a, b) => b.score - a.score);',
    'observeRows("workspace_return", perWs.flat());\n    const hits = perWs.flat().sort((a, b) => b.score - a.score);');
  if(policy==='weighted4_all_scopes')once('workspaces.length === 1','false');
  else assert.equal(policy,'production_scoped_prefix3');
  const rows=source.match(/^\s*const rows = await .*\.toArray\(\);$/gm);assert.equal(rows.length,6);
  source=source.replace(/^(\s*const rows = await .*\.toArray\(\);)$/gm,'$1\nobserveRows("query_return", rows);');
  source='import { observeRows, observeReranker } from "./retrieval-trace-hook.mjs";\n'+source;
  fs.writeFileSync(sourceFile,source);
  fs.copyFileSync(new URL('./retrieval-trace-hook.mjs',import.meta.url),runtime+'/retrieval-trace-hook.mjs');
  const url=pathToFileURL(runtime+'/').href;
  const {search}=await import(url+'search.js');
  const hook=await import(url+'retrieval-trace-hook.mjs');
  const {subscribeActivity}=await import(url+'activity.js');subscribeActivity(hook.observeEvent);
  const {getConnection}=await import(url+'db.js');const db=await getConnection(baseCfg);
  for(const ws of inventory.workspaces)assert.equal(await(await db.openTable(ws.table.name)).version(),snapshot.versions[ws.slug]);
  runtimes[policy]={search,hook,db,sourceHash:sha(source),runtime};
}

function grade(hits,q){
  if(!q.groups.length)return {rank:null,completeAt5:null,groupRanks:[]};
  const ranks=q.groups.map(g=>{const accepted=new Set(g.alternatives.map(key));return hits.slice(0,5).findIndex(h=>accepted.has(key(h)))+1;});
  return {rank:Math.min(...ranks.filter(x=>x>0),Infinity)===Infinity?0:Math.min(...ranks.filter(x=>x>0)),
    completeAt5:ranks.every(x=>x>0),groupRanks:ranks};
}
function traceSummary(trace,q){
  const stages={};
  for(const event of trace.snapshots){
    const s=stages[event.stage]??={rows:0,groups:q.groups.map(()=>false)};
    s.rows+=event.rows.length;
    for(let i=0;i<q.groups.length;i++){
      const accepted=new Set(q.groups[i].alternatives.map(key));
      if(event.rows.some(r=>accepted.has(key(r))))s.groups[i]=true;
    }
  }
  return {stages,events:trace.events.filter(e=>e.type==='search.stage').map(e=>({workspace:e.workspace,stage:e.stage,status:e.status,note:e.note}))};
}
function selectedScopes(method,q,vector,available){
  if(method==='A0')return {selected:available,abstained:false,reason:'all_baseline',scores:[]};
  if(method==='AC')return {selected:[...available].sort(),abstained:false,reason:'canonical_all_diagnostic',scores:[]};
  if(method==='AO'){
    if(!q.groups.length)return {selected:[...available].sort(),abstained:true,reason:'oracle_abstention',scores:[]};
    // Small catalog: choose a minimum set covering every required alternative group.
    const sorted=[...available].sort();let best=null;
    for(let mask=1;mask<(1<<sorted.length);mask++){
      const subset=sorted.filter((_,i)=>mask&(1<<i));
      if(best&&subset.length>=best.length)continue;
      if(q.groups.every(g=>g.alternatives.some(e=>subset.includes(e.workspace))))best=subset;
    }
    assert(best,'Oracle evidence unavailable');return {selected:best,abstained:false,reason:'oracle_labels',scores:[]};
  }
  return routeWorkspaceVector(models[method],vector,available,baseCfg.ollamaModel,catalogHash);
}
async function runOne(q,method,policy,order='normal',capture=false){
  const started=performance.now();
  const available=order==='reverse'?[...scopes].reverse():order==='seeded'?[...scopes].sort((a,b)=>sha('t12:'+a).localeCompare(sha('t12:'+b))):scopes;
  let vectorPromise,embedMs=0,embedCalls=0;
  const vector=()=>vectorPromise??=(async()=>{const t=performance.now();embedCalls++;try{return await embedQuery(baseCfg,q.query);}finally{embedMs+=performance.now()-t;}})();
  const routeStart=performance.now();
  const queryVector=method==='A1'||method==='A2'?await vector():null;
  const computeStart=performance.now();
  const decision=selectedScopes(method,q,queryVector,available);
  const routeComputeMs=performance.now()-computeStart,routeMs=performance.now()-routeStart;
  const runtime=runtimes[policy];
  const trace={started,events:[],snapshots:[],embeddings:[]};
  const runSearch=async selected=>runtime.search(baseCfg,selected.map(slug=>workspaces.find(w=>w.slug===slug)),q.query,5,config.mode??'hybrid',{
    bypassCache:true,client:'local:workspace-routing-eval',
    // Baseline retains lazy definition lookup; router and retrieval reuse one request-local embedding.
    getQueryVector:vector,
  });
  const operation=async()=>{
    let result=await runSearch(decision.selected),expanded=false;
    const initialWarnings=[...result.warnings],initialFailed=result.workspaceResults.some(w=>w.failed);
    const searched=[...decision.selected];
    if(['A1','A2'].includes(method)&&decision.selected.length<available.length&&
       (!result.hits.length||result.workspaceResults.some(w=>w.failed))){
      result=await runSearch([...available].sort());expanded=true;searched.push(...available);
    }
    const finalScopes=expanded?[...available].sort():decision.selected;
    const judged=grade(result.hits,q);
    return {id:q.id,stratum:q.stratum,method,policy,order,...judged,route:decision,finalScopes,expanded,
      routeGroupCoverage:q.groups.length?q.groups.every(g=>g.alternatives.some(e=>decision.selected.includes(e.workspace))):null,
      finalGroupCoverage:q.groups.length?q.groups.every(g=>g.alternatives.some(e=>finalScopes.includes(e.workspace))):null,
      searchWorkspaceCalls:searched.length,routeMs,routeComputeMs,embedMs,embeddingCalls:embedCalls,
      elapsedMs:performance.now()-started,warnings:expanded?[...initialWarnings,...result.warnings]:result.warnings,
      initialFailed,failed:result.workspaceResults.some(w=>w.failed),cached:!!result.cached,
      hits:result.hits.slice(0,5).map(h=>({workspace:h.workspace,id:h.id,abs:h.abs,score:h.score})),
      ...(capture?{trace:traceSummary(trace,q)}:{})};
  };
  return capture?runtime.hook.withTrace(trace,operation):operation();
}

const resultFile=config.output+'/runs.local.jsonl';let completed=0;
const append=result=>{fs.appendFileSync(resultFile,JSON.stringify(result)+'\n');completed++;};
for(let round=1;round<=config.rounds;round++){
  for(let i=0;i<data.length;i++){
    const methods=(i+round)%2?[...config.methods].reverse():config.methods;
    for(const policy of config.policies)for(const method of methods){
      const result=await runOne(data[i],method,policy,'normal',round===1);append({...result,round});
    }
    if((i+1)%10===0)console.log(JSON.stringify({stage:config.stage,round,questions:i+1,completed}));
  }
}
if(config.orderChecks){
  const out=config.output+'/order.local.jsonl';let count=0;
  for(const q of data)for(const order of ['reverse','seeded'])for(const method of ['A0',config.candidate]){
    const result=await runOne(q,method,'production_scoped_prefix3',order,false);
    fs.appendFileSync(out,JSON.stringify(result)+'\n');count++;
  }
  console.log(JSON.stringify({orderCalls:count}));
}
if(config.concurrency){
  // In-process requests share the same frozen engine; these timings are not production HTTP timings.
  const questions=['single','multi','ambiguous','out_of_scope'].flatMap(s=>data.filter(q=>q.stratum===s).slice(0,6));
  assert.equal(questions.length,24);
  const out=config.output+'/concurrency.local.jsonl';
  for(const level of [1,4,8])for(let round=1;round<=3;round++)for(const method of (round%2?['A0',config.candidate]:[config.candidate,'A0'])){
    let cursor=0;const batch=[];
    await Promise.all(Array.from({length:level},async()=>{while(cursor<questions.length){const q=questions[cursor++];
      batch.push({...await runOne(q,method,'production_scoped_prefix3'),concurrency:level,round});}}));
    for(const row of batch)fs.appendFileSync(out,JSON.stringify(row)+'\n');
    console.log(JSON.stringify({concurrency:level,round,method,requests:batch.length}));
  }
}
for(const runtime of Object.values(runtimes))for(const ws of inventory.workspaces)
  assert.equal(await(await runtime.db.openTable(ws.table.name)).version(),snapshot.versions[ws.slug]);
for(const [file,hash]of Object.entries(implementationHashes))assert.equal(sha(fs.readFileSync(snapshot.baseline+'/'+file)),hash);
await verifyEmbeddingIdentity();
assert.equal(sha(fs.readFileSync(new URL(import.meta.url))),runnerSha256,'Runner changed during execution');
fs.writeFileSync(config.output+'/completion.local.json',JSON.stringify({at:new Date().toISOString(),stage:config.stage,questions:data.length,
  mainCalls:completed,dataSha256:sha(fs.readFileSync(config.data)),runnerSha256,
  configSha256:sha(fs.readFileSync(process.argv[2])),snapshotSha256:sha(fs.readFileSync(config.snapshot)),implementationHashes,embedding:config.embedding,
  runtimes:Object.fromEntries(Object.entries(runtimes).map(([p,r])=>[p,{path:r.runtime,sourceHash:r.sourceHash}])),tablesStable:true},null,2));
console.log(JSON.stringify({completed:true,mainCalls:completed}));
