// Offline contract tests: real CLI/MCP source, memory-only fs/fetch/SDK/transport seams.
// No sockets, DB, servers, models or real workspaces. Node >=22, installed TS/zod only.
// Run: node --experimental-vm-modules scripts/test-prompt-contract.mjs
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {timingSafeEqual} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'mcp-server/package.json'));
const ts=require('typescript');const {z}=require('zod');
let assertions=0;const sections=[];
function eq(a,b){assert.deepEqual(a,b);assertions++}
function ok(value){assert.ok(value);assertions++}
async function section(name,fn){await fn();sections.push(name);console.log('PASS '+name)}
const read=f=>fs.readFileSync(path.join(root,f),'utf8');
const REF={workspace:'docs',chunkId:'fixture',fileHash:'a'.repeat(64),startLine:1,endLine:2,contentHash:'b'.repeat(64)};
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})}
class Exit extends Error{constructor(code){super('fixture exit');this.code=code}}
function synth(context,name,values){return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v)},{context,identifier:name})}
function state(extra={}){
 const s={calls:[],stdout:'',stderr:'',modules:new Map(),tools:new Map(),app:null,instances:[],...extra};
 const proc={env:{},argv:[],stdout:{write:x=>{s.stdout+=x}},stderr:{write:x=>{s.stderr+=x}},exit:code=>{throw new Exit(code)}};
 s.context=vm.createContext({process:proc,console:{log:()=>{},warn:()=>{},error:()=>{}},Buffer,AbortSignal,URL,TextDecoder,TextEncoder,fetch:async(url,init={})=>{s.calls.push({url,init});return s.respond(url,init)}});
 s.process=proc;return s;
}
async function cli(argv,{reply={hits:[],warnings:[]},status=200,reject=false,ref=REF}={}){
 const s=state();s.process.argv=['node','greplet.mjs',...argv];s.process.env={GREPLET_WORKSPACES:'/fixture/workspaces.json',GREPLET_DEFAULT_WORKSPACE:'code'};
 const memory=new Map([['/fixture/workspaces.json',JSON.stringify([{slug:'code'},{slug:'docs'}])],['/fixture/ref.json',JSON.stringify(ref)]]);
 s.respond=async()=>{if(reject)throw new Error('fixture transport failed');return response(reply,status)};
 const seams={
  'node:fs':{readFileSync:(p)=>{if(!memory.has(p))throw new Error('unexpected fs access: '+p);return memory.get(p)},existsSync:p=>memory.has(p)},
  'node:url':{fileURLToPath},'node:path':{dirname:path.dirname,join:path.join},
 };
 let source=read('greplet.mjs');ok(/\nmain\(\);\s*$/.test(source));
 // Only await the existing entry promise so errors/exit are observable in the fixture.
 source=source.replace(/\nmain\(\);\s*$/,'\nawait main();\n');
 const mod=new vm.SourceTextModule(source,{context:s.context,identifier:pathToFileURL(path.join(root,'greplet.mjs')).href,initializeImportMeta(meta,m){meta.url=m.identifier}});
 await mod.link(name=>{if(!seams[name])throw new Error('unexpected import '+name);return synth(s.context,name,seams[name])});
 try{await mod.evaluate({timeout:3000});s.exit=0}catch(e){if(e instanceof Exit)s.exit=e.code;else throw e}
 return s;
}
async function mcp(kind){
 const s=state();s.process.env={MCP_AUTH_TOKEN:'synthetic-fixture-token'};
 s.respond=async(url)=>url.endsWith('/api/workspaces')?response([{slug:'code',kind:'code',files:1,chunks:1,label:'Code'},{slug:'docs',kind:'doc',files:1,chunks:1,label:'Docs'}]):response({hits:[],warnings:[]});
 class McpServer{
  constructor(info){this.tools=new Map();this.info=info;s.instances.push(this)}
  registerTool(name,config,handler){this.tools.set(name,{config,handler})}
  async connect(){} close(){}
 }
 class Transport{async handleRequest(){} close(){}}
 const express=()=>{
  const app={routes:new Map(),use(){},get(p,fn){this.routes.set('GET '+p,fn)},post(p,fn){this.routes.set('POST '+p,fn)},delete(p,fn){this.routes.set('DELETE '+p,fn)},listen(){/* no socket */}};
  s.app=app;return app;
 };express.json=()=>()=>{};
 const packageFiles=new Map(['mcp-server/package.json','greplet-mcpb/package.json'].map(f=>[path.join(root,f),read(f)]));
 const packageFS={readFileSync:(p)=>{const key=p instanceof URL?fileURLToPath(p):p;if(!packageFiles.has(key))throw new Error('unexpected package fs access: '+key);return packageFiles.get(key)}};
 const imports={'node:fs':packageFS,'express':{default:express},'node:crypto':{timingSafeEqual},'@modelcontextprotocol/sdk/server/mcp.js':{McpServer},'@modelcontextprotocol/sdk/server/streamableHttp.js':{StreamableHTTPServerTransport:Transport},'@modelcontextprotocol/sdk/server/stdio.js':{StdioServerTransport:Transport},'zod':{z}};
 async function module(file){
  if(s.modules.has(file))return s.modules.get(file);
  let source=read(file);
  if(file.endsWith('.ts')){
   const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},reportDiagnostics:true,fileName:file});
   eq((compiled.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error).length,0);source=compiled.outputText;
  }
  const mod=new vm.SourceTextModule(source,{context:s.context,identifier:pathToFileURL(path.join(root,file)).href,initializeImportMeta(meta,m){meta.url=m.identifier}});s.modules.set(file,mod);
  await mod.link(async name=>{
   if(name==='./greplet.js')return module('mcp-server/src/greplet.ts');
   if(!imports[name])throw new Error('unexpected import '+name);
   return synth(s.context,name,imports[name]);
  });return mod;
 }
 const entry=await module(kind==='remote'?'mcp-server/src/index.ts':'greplet-mcpb/server/index.js');await entry.evaluate({timeout:3000});
 if(kind==='remote'){
  const handler=s.app.routes.get('POST /mcp');ok(handler);
  await handler({headers:{authorization:'Bearer synthetic-fixture-token'},body:{}},{on(){},headersSent:false,status(){throw new Error('unexpected response error')}});
 }
 eq(s.instances.length,1);eq(s.instances[0].info.version,JSON.parse(read(kind==='remote'?'mcp-server/package.json':'greplet-mcpb/package.json')).version);s.tools=s.instances[0].tools;eq([...s.tools.keys()],['greplet','greplet_workspaces','greplet_search_evidence','greplet_get_evidence']);
 s.call=async(name,args)=>{const t=s.tools.get(name);const parsed=z.object(t.config.inputSchema).parse(args);return t.handler(parsed)};
 return s;
}
await section('skill examples and evidence/permission/version wording',async()=>{
 for(const f of ['examples/claude-code-skill/SKILL.md','examples/codex/skills/greplet/SKILL.md']){
  const text=read(f);ok(!/~2초|그때만|\*\*그 파일만\*\*/.test(text));
  ok(!text.split('\n').some(line=>/^node /.test(line)&&line.includes('--all')&&line.includes('--workspace')));
  for(const term of ['evidence-search','evidence-get','greplet_search_evidence','greplet_get_evidence','현재 HEAD로 대체하지 않는다','해시 일치는','허용된 범위','원격 인덱스와 로컬 파일','근거가 충족되면 멈춘다','404/409','설정 변경·재인덱싱','예시 구성'])ok(text.includes(term));
 }
});
await section('real CLI workspace payload and legacy all precedence',async()=>{
 for(const [argv,workspaces,topN,mode] of [
  [['query','--full','--workspace','docs','--top-n','10','--mode','fts'],['docs'],10,'fts'],
  [['query','--all'],'all',6,'hybrid'],
  [['query','--all','--workspace','docs'],'all',6,'hybrid'],
  [['query'],['code'],6,'hybrid'],
  [['evidence-search','query','--workspace','docs'],['docs'],3,'hybrid'],
  [['evidence-search','query','--all'],'all',3,'hybrid'],
 ]){
  const r=await cli(argv);eq(r.exit,0);eq(r.calls.length,1);const body=JSON.parse(r.calls[0].init.body);eq(body.workspaces,workspaces);eq(body.topN,topN);eq(body.mode,mode);
 }
});
await section('real CLI preserves evidence errors and does not label transport failure as confirmed downtime',async()=>{
 for(const [status,code] of [[404,'not_found'],[409,'indexing'],[409,'stale_evidence'],[409,'source_unavailable'],[409,'ambiguous_source']]){
  const body={error:{code,message:'fixture explanation'},status};const r=await cli(['evidence-get','--ref-file','/fixture/ref.json'],{reply:body,status});eq(r.exit,1);eq(JSON.parse(r.stdout),body);eq(r.calls.length,1);eq(r.stderr,'');
 }
 const r=await cli(['query','--workspace','docs'],{reject:true});eq(r.exit,1);ok(r.stderr.includes('미가동을 단정할 수 없습니다'));ok(r.stderr.includes('허용 범위'));ok(!r.stderr.includes('로 기동할 것'));eq(r.calls.length,1);
});
const descriptions={};
for(const kind of ['remote','bundle']){
 await section(kind+' actual tool registrations, schema defaults and explicit scope',async()=>{
  const s=await mcp(kind);descriptions[kind]=Object.fromEntries([...s.tools].map(([name,t])=>[name,t.config.description]));
  for(const t of s.tools.values()){eq(t.config.annotations.readOnlyHint,true);eq(t.config.annotations.destructiveHint,false)}
  await s.call('greplet_search_evidence',{query:'query'});let b=JSON.parse(s.calls.at(-1).init.body);eq(b.workspaces,'all');eq(b.topN,3);eq(b.mode,'hybrid');
  await s.call('greplet_search_evidence',{query:'query',workspaces:['docs']});eq(JSON.parse(s.calls.at(-1).init.body).workspaces,['docs']);
  await s.call('greplet',{query:'query',workspace:'docs'});b=JSON.parse(s.calls.at(-1).init.body);eq(b.workspaces,['docs']);eq(b.topN,6);
  await s.call('greplet',{query:'query',workspace:'docs',all:true});eq(JSON.parse(s.calls.at(-1).init.body).workspaces,'all');
 });
 await section(kind+' evidence 404/409 status bodies and transport failure guidance',async()=>{
  const s=await mcp(kind);
  for(const [status,code] of [[404,'not_found'],[409,'indexing'],[409,'stale_evidence'],[409,'source_unavailable'],[409,'ambiguous_source']]){
   const body={error:{code,message:'fixture explanation'},status};s.respond=async()=>response(body,status);
   const before=s.calls.length;const r=await s.call('greplet_get_evidence',{evidenceRef:REF});eq(r.isError,true);eq(JSON.parse(r.content[0].text),body);eq(s.calls.length,before+1);
  }
  s.respond=async()=>{throw new Error('fixture transport failed')};const r=await s.call('greplet_workspaces',{});eq(r.isError,true);ok(r.content[0].text.includes('미가동을 단정할 수 없습니다'));ok(r.content[0].text.includes('허용 범위'));
 });
}
await section('remote and bundle descriptions remain aligned',async()=>{
 eq(descriptions.remote,descriptions.bundle);
 for(const ds of Object.values(descriptions)){
  ok(ds.greplet.includes('불충분'));ok(ds.greplet.includes('greplet_get_evidence'));
  ok(ds.greplet_search_evidence.includes('workspaces 목록을 명시'));
  for(const term of ['동일성','의미 충족','ambiguous_source','indexing','재인덱싱 권한'])ok(ds.greplet_get_evidence.includes(term));
 }
});
console.log(JSON.stringify({status:'pass',sections:sections.length,assertions,realNetworkCalls:0,realServerStarts:0,DBAccesses:0,models:0,scope:'static and actual-source contracts with synthetic fs/fetch/SDK; not deployed integration or model tool-use behavior'}));
