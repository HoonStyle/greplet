// Real LanceDB candidates: strong vector-only rows compete with lexical overlap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, Index } from '@lancedb/lancedb';
import { createVectorWeightedReranker, createVectorProtectedReranker } from '../dist/rerank.js';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'greplet-fusion-protection-'));
try {
  const db = await connect(temporary);
  const rows = Array.from({ length: 50 }, (_, i) => {
    const cosine = 1 - i / 100;
    return { id: `C${String(i + 1).padStart(3, '0')}`, text: i < 3 ? 'semantic evidence' : 'needle lexical evidence',
      vector: [cosine, Math.sqrt(1 - cosine * cosine)], evidence: `metadata-${i}` };
  });
  const table = await db.createTable('candidates', rows);
  await table.createIndex('text', { config: Index.fts() });
  let observed;
  const current = await createVectorWeightedReranker();
  const protectedFusion = await createVectorProtectedReranker();
  const observer = {
    async rerankHybrid(query, vector, fts) {
      const before = await current.rerankHybrid(query, vector, fts);
      const after = await protectedFusion.rerankHybrid(query, vector, fts);
      const disabled = await (await createVectorProtectedReranker(0)).rerankHybrid(query, vector, fts);
      assert.deepEqual(disabled.toArray().map(r => r.toJSON()), before.toArray().map(r => r.toJSON()));
      observed = { before: before.toArray().map(r => r.toJSON()), after: after.toArray().map(r => r.toJSON()),
        vector: vector.toArray().map(r => r.toJSON()), schemaBefore: before.schema.toString(), schemaAfter: after.schema.toString() };
      return after;
    },
  };
  const returned = await table.query().nearestTo([1, 0]).distanceType('cosine').fullTextSearch('needle')
    .rerank(observer).select(['id', 'text', 'evidence']).limit(50).toArray();
  assert(!observed.before.slice(0, 5).some(r => r.id === 'C001'));
  assert.deepEqual(returned.slice(0, 3).map(r => r.id), observed.vector.slice(0, 3).map(r => r.id));
  assert.equal(observed.schemaAfter, observed.schemaBefore);
  assert.deepEqual(new Set(observed.after.map(r => r._rowid)), new Set(observed.before.map(r => r._rowid)));
  const protectedIds = new Set(observed.vector.slice(0, 3).map(r => r._rowid));
  assert.deepEqual(observed.after.slice(3).map(r => r._rowid), observed.before.filter(r => !protectedIds.has(r._rowid)).map(r => r._rowid));
  for (const r of returned) assert.equal(r.evidence, rows.find(v => v.id === r.id).evidence);
  assert(returned.every(r => r._relevance_score > 0 && r._relevance_score < 1));
  assert(returned.every((r, i) => i === 0 || returned[i - 1]._relevance_score > r._relevance_score));
  for (const text of ['semantic', 'unmatched']) {
    const result = await table.query().nearestTo([1, 0]).distanceType('cosine').fullTextSearch(text)
      .rerank(observer).select(['id', 'text', 'evidence']).limit(50).toArray();
    assert.deepEqual(result.slice(0, 3).map(r => r.id), ['C001', 'C002', 'C003']);
    assert.equal(new Set(result.map(r => r.id)).size, result.length);
    assert.equal(observed.after.length, observed.before.length);
  }
  // Empty union preserves the native empty batch, including its schema.
  const emptyQuery = await table.query().nearestTo([1, 0]).distanceType('cosine').fullTextSearch('needle')
    .rerank({ async rerankHybrid(query, v, f) {
      const empty = v.slice(0, 0);
      const union = await protectedFusion.rerankHybrid(query, empty, f.slice(0, 0));
      assert.equal(union.numRows, 0);
      return union;
    } }).limit(50).toArray();
  assert.equal(emptyQuery.length, 0);
  await assert.rejects(createVectorProtectedReranker(-1));
  await assert.rejects(createVectorProtectedReranker(1.5));
  console.log('Protected fusion: real candidate competition, union/schema/metadata, tail order, score order, empty union, and validation passed.');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
