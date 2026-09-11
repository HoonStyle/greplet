import { makeArrowTable, rerankers } from "@lancedb/lancedb";

/** Preserve the native union/schema and its order for weighted-score ties. */
export async function createVectorWeightedReranker(vectorWeight = 4): Promise<rerankers.Reranker> {
  if (!Number.isFinite(vectorWeight) || vectorWeight <= 0) {
    throw new Error("vectorWeight must be finite and positive");
  }
  const k = 60;
  const native = await rerankers.RRFReranker.create(k);
  if (vectorWeight === 1) return native;
  return {
    async rerankHybrid(query, vectorResults, ftsResults) {
      const union = await native.rerankHybrid(query, vectorResults, ftsResults);
      if (union.numRows === 0) return union;
      // LanceDB 0.38 RRF uses zero-based ranks and deduplicates on `_rowid`.
      const vectorRanks = new Map(vectorResults.toArray().map((row, rank) => [row._rowid, rank]));
      const ftsRanks = new Map(ftsResults.toArray().map((row, rank) => [row._rowid, rank]));
      const rows = union.toArray().map((row, tie) => ({ row: row.toJSON(), tie }));
      for (const item of rows) {
        const id = item.row._rowid;
        const vectorRank = vectorRanks.get(id);
        const ftsRank = ftsRanks.get(id);
        item.row._relevance_score = Math.fround(
          (vectorRank === undefined ? 0 : vectorWeight / (k + vectorRank)) +
          (ftsRank === undefined ? 0 : 1 / (k + ftsRank)),
        );
      }
      rows.sort((a, b) => b.row._relevance_score - a.row._relevance_score || a.tie - b.tie);
      return makeArrowTable(rows.map(item => item.row), { schema: union.schema }).batches[0];
    },
  };
}

/** Single-workspace fusion: reserve a vector prefix, then retain weighted-RRF order. */
export async function createVectorProtectedReranker(protectedCount = 3): Promise<rerankers.Reranker> {
  if (!Number.isInteger(protectedCount) || protectedCount < 0) {
    throw new Error("protectedCount must be a nonnegative integer");
  }
  const weighted = await createVectorWeightedReranker();
  if (protectedCount === 0) return weighted;
  return {
    async rerankHybrid(query, vectorResults, ftsResults) {
      const union = await weighted.rerankHybrid(query, vectorResults, ftsResults);
      if (union.numRows === 0) return union;
      const rows = union.toArray().map(row => row.toJSON());
      const byId = new Map(rows.map(row => [row._rowid, row]));
      const protectedIds = new Set(vectorResults.toArray().slice(0, protectedCount).map(row => row._rowid));
      const prefix = [...protectedIds].map(id => {
        const row = byId.get(id);
        if (row === undefined) throw new Error("Protected vector candidate is missing from fusion union");
        return row;
      });
      const ordered = [...prefix, ...rows.filter(row => !protectedIds.has(row._rowid))];
      // These are ordinal fusion scores, not confidence probabilities. This
      // mapping preserves the explicit order through SearchResponse's sort,
      // and stays below exact-definition hits (score 1).
      for (let rank = 0; rank < ordered.length; rank++) {
        ordered[rank]._relevance_score = Math.fround(0.5 * (ordered.length - rank) / ordered.length);
      }
      return makeArrowTable(ordered, { schema: union.schema }).batches[0];
    },
  };
}
