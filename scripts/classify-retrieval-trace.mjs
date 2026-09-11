// Rules identify observed loss boundaries, not the causal quality of an embedder.
export function classifyRetrievalTrace(trace) {
  if (trace.cached) return 'not_observed';
  if (trace.events.some(e => e.type === 'search.stage' && e.status === 'fallback') ||
      trace.workspaceResults.some(w => w.effectiveMode !== trace.mode)) return 'fallback';
  if (trace.warnings.length || trace.events.some(e => e.error) || trace.workspaceResults.some(w => w.failed)) return 'execution_error';
  if (trace.mode !== 'hybrid') return trace.targetRank > 0 ? 'target_hit' : 'top5_miss_unresolved';
  const stages = ['vector_candidates', 'fts_candidates', 'fused_union', 'query_return', 'search_return', 'evaluation_top5'];
  if (stages.some(stage => trace.snapshots.filter(s => s.stage === stage).length !== 1)) return 'not_observed';
  const ranks = Object.fromEntries(trace.snapshots.map(s => [s.stage, s.targetRank]));
  if (!ranks.vector_candidates && !ranks.fts_candidates) {
    return stages.slice(2).some(s => ranks[s]) ? 'inconsistent_trace' : 'candidate_pool_miss';
  }
  if (!ranks.fused_union) return 'inconsistent_trace';
  if (ranks.evaluation_top5 !== trace.targetRank) return 'inconsistent_trace';
  if (!ranks.query_return) return ranks.search_return || trace.targetRank ? 'inconsistent_trace' : 'fused_pool_cutoff';
  if (!ranks.search_return) return 'not_observed'; // A filter or another unrecorded operation needs a dedicated trace.
  return trace.targetRank > 0 ? 'target_hit' : 'final_top5_cutoff';
}
