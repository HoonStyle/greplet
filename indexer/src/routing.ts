/** Offline workspace routing. Models and source-specific cards stay outside the repository. */
export interface RoutingPolicy {
  minScore: number;
  relativeWindow: number;
  minCandidates: number;
  maxCandidates: number;
}

export interface RoutingModel {
  schemaVersion: 1;
  strategy: "cosine" | "logistic";
  version: string;
  embeddingModel: string;
  dimensions: number;
  workspaceSlugs: string[];
  catalogHash: string;
  prototypes?: number[][][];
  weights?: number[][];
  intercepts?: number[];
  policy: RoutingPolicy;
}

export interface RoutingDecision {
  strategy: string;
  selected: string[];
  abstained: boolean;
  reason: string;
  scores: Array<{ workspace: string; score: number }>;
  modelVersion: string;
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const finiteVector = (v: unknown, size: number): v is number[] =>
  Array.isArray(v) && v.length === size && v.every(x => typeof x === "number" && Number.isFinite(x));

export function normalizeRoutingVector(vector: number[]): number[] {
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) throw new Error("invalid_vector");
  // Scale first to avoid overflow for otherwise finite input.
  const scale = vector.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  if (scale === 0) throw new Error("zero_vector");
  const scaled = vector.map(x => x / scale);
  const norm = Math.sqrt(scaled.reduce((n, x) => n + x * x, 0));
  return scaled.map(x => x / norm);
}

export function validateRoutingModel(value: unknown): string | null {
  if (!value || typeof value !== "object") return "invalid_model";
  const m = value as RoutingModel;
  if (m.schemaVersion !== 1 || !["cosine", "logistic"].includes(m.strategy)) return "unsupported_model";
  if (![m.version, m.embeddingModel, m.catalogHash].every(x => typeof x === "string" && x.length > 0)) return "invalid_identity";
  if (!Number.isInteger(m.dimensions) || m.dimensions < 1 || m.dimensions > 65536) return "invalid_dimensions";
  if (!Array.isArray(m.workspaceSlugs) || !m.workspaceSlugs.length ||
      !m.workspaceSlugs.every(x => typeof x === "string" && x.length > 0) ||
      new Set(m.workspaceSlugs).size !== m.workspaceSlugs.length) return "invalid_classes";
  const p = m.policy;
  if (!p || !Number.isFinite(p.minScore) || !Number.isFinite(p.relativeWindow) || p.relativeWindow < 0 ||
      !Number.isInteger(p.minCandidates) || p.minCandidates < 1 ||
      !Number.isInteger(p.maxCandidates) || p.maxCandidates < p.minCandidates) return "invalid_policy";
  const count = m.workspaceSlugs.length;
  if (m.strategy === "cosine") {
    if (!Array.isArray(m.prototypes) || m.prototypes.length !== count ||
        !m.prototypes.every(group => Array.isArray(group) && group.length > 0 &&
          group.every(v => finiteVector(v, m.dimensions) && v.some(x => x !== 0)))) return "invalid_prototypes";
  } else if (!Array.isArray(m.weights) || m.weights.length !== count ||
      !m.weights.every(v => finiteVector(v, m.dimensions)) || !finiteVector(m.intercepts, count)) return "invalid_weights";
  return null;
}

export function routeWorkspaceVector(
  model: unknown, queryVector: number[], availableSlugs: string[], embeddingModel: string, catalogHash: string,
): RoutingDecision {
  const all = [...new Set(availableSlugs.filter(x => typeof x === "string" && x.length > 0))].sort(compare);
  const m = model as RoutingModel | undefined;
  const fallback = (reason: string, scores: RoutingDecision["scores"] = []): RoutingDecision => ({
    strategy: m?.strategy ?? "unavailable", selected: all, abstained: true, reason, scores,
    modelVersion: typeof m?.version === "string" ? m.version : "unavailable",
  });
  const invalid = validateRoutingModel(model);
  if (invalid) return fallback(invalid);
  const valid = m!;
  if (valid.embeddingModel !== embeddingModel) return fallback("embedding_model_changed");
  if (valid.catalogHash !== catalogHash) return fallback("catalog_changed");
  if (all.length !== availableSlugs.length || all.length !== valid.workspaceSlugs.length ||
      !all.every(x => valid.workspaceSlugs.includes(x))) return fallback("workspace_catalog_changed");
  if (!finiteVector(queryVector, valid.dimensions)) return fallback("invalid_query_vector");
  let unit: number[];
  try { unit = normalizeRoutingVector(queryVector); } catch { return fallback("invalid_query_vector"); }
  const dot = (v: number[]) => unit.reduce((sum, x, j) => sum + x * v[j], 0);
  const scores = valid.workspaceSlugs.map((workspace, i) => {
    if (valid.strategy === "cosine") {
      return { workspace, score: Math.max(...valid.prototypes![i].map(v => dot(normalizeRoutingVector(v)))) };
    }
    const logit = dot(valid.weights![i]) + valid.intercepts![i];
    const score = logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit));
    return { workspace, score };
  }).sort((a, b) => b.score - a.score || compare(a.workspace, b.workspace));
  if (!scores.every(x => Number.isFinite(x.score))) return fallback("invalid_scores");
  const eligible = scores.filter(x => x.score >= valid.policy.minScore);
  if (!eligible.length) return fallback("low_score", scores);
  const chosen = eligible.filter(x => eligible[0].score - x.score <= valid.policy.relativeWindow);
  for (const candidate of eligible) {
    if (chosen.length >= valid.policy.minCandidates) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  if (chosen.length < valid.policy.minCandidates) return fallback("insufficient_candidates", scores);
  if (chosen.length > valid.policy.maxCandidates) return fallback("ambiguous_candidates", scores);
  return { strategy: valid.strategy, selected: chosen.map(x => x.workspace).sort(compare), abstained: false,
    reason: "selected", scores, modelVersion: valid.version };
}
