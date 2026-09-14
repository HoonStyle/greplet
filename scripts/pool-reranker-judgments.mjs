// Prepare private, method-blinded candidate pools. No relevance labels are inferred.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
for (const flag of ['--pack', '--references', '--scores', '--output']) assert(args.get(flag), `Required: ${flag}`);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const pack = read(args.get('--pack'));
const references = read(args.get('--references'));
assert.equal(references.pack?.sha256, hash(fs.readFileSync(args.get('--pack'))), 'References belong to a different frozen pack');
const rows = fs.readFileSync(args.get('--scores'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const output = args.get('--output');
assert(!fs.existsSync(output), 'Never overwrite a blinded judgment packet');
const depth = Number(args.get('--depth') ?? 20);
assert(Number.isInteger(depth) && depth >= 5);
const selected = args.has('--ids') ? new Set(read(args.get('--ids'))) : new Set(rows.map(row => row.id));
assert([...selected].every(id => pack.cases.some(q => q.id === id)), 'Unknown selected question');
const docs = references.documents;
assert(docs && typeof docs === 'object', 'Expected reference documents keyed by candidate identity');
fs.mkdirSync(output, {recursive: true});
const privateMap = {};
let caseCount = 0, candidateCount = 0;
for (const q of pack.cases.filter(q => selected.has(q.id) && q.groups.length)) {
  const runs = rows.filter(row => row.id === q.id);
  assert(runs.length, `No scores for selected case ${q.id}`);
  const byKey = new Map([...q.U, ...q.C].map(row => [row.key, row]));
  const keys = new Set(q.groups.flatMap(g => g.keys));
  for (const row of runs) for (const method of ['B0', 'BC', 'R1', 'U0', 'U1'])
    for (const key of (row[method] ?? []).slice(0, depth)) keys.add(key);
  const caseId = `J${String(++caseCount).padStart(3, '0')}`;
  const ordered = [...keys].sort((a,b) => {
    const x = hash('T13-blind-pool-v1|' + q.id + '|' + a), y = hash('T13-blind-pool-v1|' + q.id + '|' + b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const clean = row => ({workspace: row.workspace, file: row.file, symbol: row.symbol, text: row.text});
  const candidates = ordered.map((key,i) => {
    const row = byKey.get(key) ?? docs[key];
    assert(row && typeof row.text === 'string', `Missing full source for ${caseId}`);
    return {id: `P${String(i+1).padStart(3, '0')}`, ...clean(row)};
  });
  const groups = q.groups.map((g,i) => ({id: `G${i+1}`, references: g.keys.map(key => {
    const row = docs[key] ?? byKey.get(key);
    assert(row, `Missing required reference for ${caseId}`);
    return clean(row);
  })}));
  privateMap[caseId] = {queryId: q.id, candidates: Object.fromEntries(ordered.map((k,i) => [candidates[i].id,k])), groups: Object.fromEntries(q.groups.map((g,i) => [`G${i+1}`,g.id]))};
  fs.writeFileSync(path.join(output, caseId + '.json'), JSON.stringify({caseId, query: q.query, requiredGroups: groups, candidates}, null, 2) + '\n');
  candidateCount += candidates.length;
}
fs.writeFileSync(path.join(output, 'mapping.private.json'), JSON.stringify(privateMap, null, 2) + '\n');
const manifest = {schemaVersion:1, purpose:'Method/rank/score-blinded source review; labels not yet assigned', depth, cases:caseCount, candidates:candidateCount,
  packSha256:hash(fs.readFileSync(args.get('--pack'))), scoresSha256:hash(fs.readFileSync(args.get('--scores'))),
  referencesSha256:hash(fs.readFileSync(args.get('--references'))), generatorSha256:hash(fs.readFileSync(new URL(import.meta.url)))};
fs.writeFileSync(path.join(output, 'manifest.local.json'), JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({cases:caseCount,candidates:candidateCount,depth}));
