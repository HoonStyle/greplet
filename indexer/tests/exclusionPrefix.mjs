import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { enumerateWorkspaceFiles, diffAgainstManifest, sha256File } from '../dist/scan.js';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'greplet-prefix-'));
const root=path.join(temp,'src'),uploads=path.join(temp,'uploads');
const ws={roots:[root],includeExt:['.txt'],excludeDirs:['bin'],excludeFiles:['*.generated.txt']};
function write(rel){const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,'test');return p;}
try {
  const kept=write('keep.txt');write('middle!name.txt');write('#tag.txt');write('!omit.txt');write('!hidden/deep/file.txt');write('nested/!hidden/file.txt');write('bin/build.txt');write('a.generated.txt');
  fs.mkdirSync(uploads);fs.writeFileSync(path.join(uploads,'!upload.txt'),'test');
  const list=()=>enumerateWorkspaceFiles(ws,uploads);
  assert.deepEqual(list().map(p=>path.basename(p)).sort(),['#tag.txt','keep.txt','middle!name.txt'].sort());
  const manifest={files:{'keep.txt':{hash:sha256File(kept)}}};
  fs.renameSync(kept,path.join(root,'!keep.txt'));
  assert.deepEqual(diffAgainstManifest(list(),[root],manifest,false).deleted,['keep.txt']);
  fs.renameSync(path.join(root,'!keep.txt'),kept);
  assert.ok(diffAgainstManifest(list(),[root],{files:{}},false).added.includes(kept));
  assert.deepEqual(enumerateWorkspaceFiles({...ws,roots:[path.join(root,'!hidden','deep')]},path.join(temp,'absent')),[]);
  console.log('[exclusion-prefix] prefix, subtree, explicit nested root, uploads, existing rules, removal/restoration passed');
} finally {
  if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('greplet-prefix-'))throw Error('Unsafe cleanup');
  fs.rmSync(temp,{recursive:true,force:true});
}
