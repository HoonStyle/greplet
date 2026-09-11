import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { withTrace, observeReranker } from './retrieval-trace-hook.mjs';
import { classifyRetrievalTrace as classify } from './classify-retrieval-trace.mjs';

const stages = ['vector_candidates', 'fts_candidates', 'fused_union', 'query_return', 'search_return', 'evaluation_top5'];
const trace = (ranks, extras = {}) => ({ mode: 'hybrid', targetRank: ranks[5], cached: false,
  warnings: [], events: [], workspaceResults: [{ effectiveMode: 'hybrid', failed: false }],
  snapshots: stages.map((stage, i) => ({ stage, targetRank: ranks[i] })), ...extras });
assert.equal(classify(trace([0, 0, 0, 0, 0, 0])), 'candidate_pool_miss');
assert.equal(classify(trace([0, 8, 65, 0, 0, 0])), 'fused_pool_cutoff');
assert.equal(classify(trace([2, 0, 8, 8, 8, 0])), 'final_top5_cutoff');
assert.equal(classify(trace([8, 2, 3, 3, 3, 3])), 'target_hit');
assert.equal(classify(trace([2, 0, 0, 0, 0, 0])), 'inconsistent_trace');
assert.equal(classify(trace([0, 0, 1, 1, 1, 1])), 'inconsistent_trace');
assert.equal(classify(trace([2, 0, 3, 3, 0, 0])), 'not_observed');
assert.equal(classify(trace([2, 0, 3, 3, 3, 3], { cached: true })), 'not_observed');
assert.equal(classify(trace([2, 0, 3, 3, 3, 3], { snapshots: [] })), 'not_observed');
assert.equal(classify(trace([2, 0, 3, 3, 3, 3], { events: [{ type: 'search.stage', status: 'fallback' }] })), 'fallback');
assert.equal(classify(trace([0, 0, 0, 0, 0, 0], { warnings: ['test error'] })), 'execution_error');
assert.equal(classify(trace([0, 0, 0, 0, 0, 0], { mode: 'vector', workspaceResults: [{ effectiveMode: 'vector' }] })), 'top5_miss_unresolved');

// Reproduce a native callback losing AsyncLocalStorage context; verify two observers remain isolated.
const require = createRequire(new URL('../indexer/package.json', import.meta.url));
const { makeArrowTable } = require('@lancedb/lancedb');
const batch = makeArrowTable([{ id: 'C001', _rowid: 1, _relevance_score: 0.5 }]).batches[0];
const before = JSON.stringify(batch.toArray().map(r => r.toJSON()));
const outside = new AsyncResource('native-callback-test');
const a = { started: performance.now(), snapshots: [] }, b = { started: performance.now(), snapshots: [] };
const native = { rerankHybrid: async () => batch };
const ra = withTrace(a, () => observeReranker(native));
const rb = withTrace(b, () => observeReranker(native));
const results = await outside.runInAsyncScope(() => Promise.all([
  ra.rerankHybrid('query A', batch, batch), rb.rerankHybrid('query B', batch, batch),
]));
assert(results.every(r => r === batch));
assert.equal(JSON.stringify(batch.toArray().map(r => r.toJSON())), before);
assert.deepEqual(a.snapshots.map(s => s.stage), stages.slice(0, 3));
assert.deepEqual(b.snapshots.map(s => s.stage), stages.slice(0, 3));
console.log('12 attribution checks and native-context/Arrow identity isolation checks passed.');
