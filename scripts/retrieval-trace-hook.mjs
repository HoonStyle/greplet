// Evaluation-only observer. Installed in isolated runtime copies by trace-retrieval-eval.mjs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const context = new AsyncLocalStorage();
export const withTrace = (trace, run) => context.run(trace, run);
export function observeEvent(event) {
  context.getStore()?.events.push(event);
}
export function observeRows(stage, rows) {
  const trace = context.getStore();
  if (!trace) return;
  trace.snapshots.push({ stage, elapsedMs: performance.now() - trace.started,
    rows: rows.map((r, i) => ({ rank: i + 1, id: r.id,
      rowid: r._rowid === undefined ? undefined : String(r._rowid),
      abs: r.abs, symbol: r.symbol,
      score: r._relevance_score ?? r._score ?? r._distance ?? r.score })) });
}
export async function observeEmbed(run) {
  const trace = context.getStore();
  if (!trace) return run();
  const event = { stage: 'embed', status: 'started' };
  trace.embeddings.push(event);
  const started = performance.now();
  try {
    const vector = await run();
    Object.assign(event, { status: 'success', dimensions: vector.length,
      hash: createHash('sha256').update(JSON.stringify(vector)).digest('hex') });
    return vector;
  } catch (error) {
    event.status = 'error';
    throw error;
  } finally {
    event.ms = performance.now() - started;
  }
}
export function observeReranker(reranker) {
  // Native LanceDB callbacks can enter outside the caller's async context.
  const trace = context.getStore();
  return {
    rerankHybrid(query, vector, fts) {
      return context.run(trace, async () => {
        observeRows('vector_candidates', vector.toArray());
        observeRows('fts_candidates', fts.toArray());
        const started = performance.now();
        const fused = await reranker.rerankHybrid(query, vector, fts);
        if (trace) trace.rerankMs = performance.now() - started;
        observeRows('fused_union', fused.toArray());
        return fused; // Preserve the original batch, schema, scores, and tie order.
      });
    },
  };
}
