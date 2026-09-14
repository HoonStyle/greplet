// Merge source judgments without exposing source identities or reinterpreting unjudged rows as negatives.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = new Map(), dirs = [];
for (let i=2; i<process.argv.length; i+=2) {
  if(process.argv[i]==='--judgments') dirs.push(process.argv[i+1]);
  else args.set(process.argv[i],process.argv[i+1]);
}
for(const flag of ['--pack','--scores','--pool','--analysis','--output']) assert(args.get(flag),`Required: ${flag}`);
assert(dirs.length,'At least one --judgments directory is required');
const read = f => JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const pack = read(args.get('--pack')), analysis = read(args.get('--analysis'));
const rows = fs.readFileSync(args.get('--scores'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
const pool = args.get('--pool'), mapping = read(path.join(pool,'mapping.private.json'));
const manifest = read(path.join(pool,'manifest.local.json'));
assert.equal(manifest.packSha256,hash(args.get('--pack')));
assert.equal(manifest.scoresSha256,hash(args.get('--scores')));
assert.equal(analysis.inputs.packSha256,manifest.packSha256);
const output=args.get('--output'); assert(!fs.existsSync(output),'Use a fresh output directory');
const grades={'0':0,'1':0,'2':0,unknown:0}, cases=[], privateCases=[], judgementHashes={};
const seen=new Set(); let additions=0;
for(const dir of dirs) for(const file of fs.readdirSync(dir).filter(f=>/^J\d+\.json$/.test(f)).sort()) {
  const j=read(path.join(dir,file)),m=mapping[j.caseId];
  assert(m && !seen.has(j.caseId),'Unknown or duplicate reviewed case'); seen.add(j.caseId);
  const packet=read(path.join(pool,j.caseId+'.json'));
  assert.equal(j.candidates.length,packet.candidates.length);
  assert.equal(new Set(j.candidates.map(c=>c.id)).size,j.candidates.length);
  const q=pack.cases.find(q=>q.id===m.queryId);
  const accepted=q.groups.map(()=>new Set()), byKey=new Map();
  for(const c of j.candidates){
    assert(Object.hasOwn(m.candidates,c.id),'Unknown candidate judgment');
    assert([0,1,2,null].includes(c.grade),'Unknown grade');
    assert(Array.isArray(c.groups) && c.groups.every(g=>Object.hasOwn(m.groups,g)),'Changed required group');
    grades[c.grade===null?'unknown':String(c.grade)]++;
    const key=m.candidates[c.id]; byKey.set(key,c);
    if(c.grade===2){
      assert(c.groups.length,'A direct match must identify a required group');
      for(const g of c.groups){
        const index=q.groups.findIndex(x=>x.id===m.groups[g]); assert(index>=0);
        accepted[index].add(key);
        if(!q.groups[index].keys.includes(key))additions++;
      }
    }
  }
  const outcomes=rows.filter(row=>row.id===q.id).map(row=>{
    const methods={};
    for(const method of ['B0','BC','R1']){
      const top=row[method].slice(0,5), known=top.map(key=>byKey.get(key));
      assert(known.every(x=>x!==undefined),'Final top5 is missing from the reviewed pool');
      const groupRanks=accepted.map(keys=>top.findIndex(key=>keys.has(key))+1);
      const positive=groupRanks.filter(x=>x>0);
      methods[method]={firstDirectRank:positive.length?Math.min(...positive):0,
        allGroupsComplete:groupRanks.every(x=>x>0),unjudgedTop5:known.filter(x=>x.grade===null).length,
        top5Grades:known.map(x=>x.grade)};
    }
    return {round:row.round,methods};
  });
  const before=outcomes[0].methods.B0.firstDirectRank,after=outcomes[0].methods.R1.firstDirectRank;
  const unresolved=Object.values(outcomes[0].methods).some(m=>m.unjudgedTop5>0);
  const visible=q.groups.flatMap(g=>g.keys).map(key=>({
    baselineRank:rows.find(r=>r.id===q.id).B0.indexOf(key)+1,
    rerankedRank:rows.find(r=>r.id===q.id).R1.indexOf(key)+1,
    truncated:rows.find(r=>r.id===q.id).visibility[key]?.truncated??null,
  }));
  cases.push({id:analysis.anonymousMap.cases[q.id],reviewedCandidates:j.candidates.length,
    outcome:unresolved?'unresolved':before&&!after?'lost_hit':!before&&after?'gained_hit':before&&after?'retained_hit':'retained_miss',outcomes,knownTargetVisibility:visible});
  privateCases.push({queryId:q.id,packet:j.caseId,reviewer:j.reviewer,humanReviewed:j.humanReviewed,accepted:accepted.map(x=>[...x])});
  judgementHashes[j.caseId]=hash(path.join(dir,file));
}
cases.sort((a,b)=>a.id.localeCompare(b.id));
const summary={schemaVersion:1,status:'partial_source_judgment_audit',selection:'Changed-hit and retained-rank-drop regression cases; not a representative accuracy sample',
  wholeCohortCases:pack.cases.length,reviewedCases:cases.length,unreviewedCases:pack.cases.length-cases.length,
  pooledCases:manifest.cases,pooledCandidates:manifest.candidates,reviewedCandidates:Object.values(grades).reduce((a,b)=>a+b,0),grades,
  reviewers:[...new Set(privateCases.map(x=>x.reviewer))],humanReviewed:privateCases.every(x=>x.humanReviewed===true),
  blinding:'Candidate method, rank and score hidden during source judgment; original question and required references supplied',
  additionalDirectMappings:additions,confirmedHitGains:cases.filter(x=>x.outcome==='gained_hit').length,
  confirmedHitLosses:cases.filter(x=>x.outcome==='lost_hit').length,cases,
  limitation:'Unreviewed candidates remain unjudged; this audit does not turn whole-cohort known-qrels metrics into fully judged accuracy.'};
fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'summary.public.json'),JSON.stringify(summary,null,2)+'\n');
fs.writeFileSync(path.join(output,'audit.local.json'),JSON.stringify({summary,privateCases,inputs:{packSha256:manifest.packSha256,scoresSha256:manifest.scoresSha256,judgementHashes}},null,2)+'\n');
console.log(JSON.stringify({reviewedCases:cases.length,reviewedCandidates:summary.reviewedCandidates,grades,additionalDirectMappings:additions,
  confirmedHitGains:summary.confirmedHitGains,confirmedHitLosses:summary.confirmedHitLosses}));
