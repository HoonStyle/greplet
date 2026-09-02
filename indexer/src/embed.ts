/*
  embed.ts — Ollama /api/embed 배치 호출(§5.2-4). 16건 배치, 동시 2배치, 실패 시 1s→2s→4s 재시도 3회.
*/
import type { AppConfig } from "./config.js";

const BATCH_SIZE = 16;
const CONCURRENCY = 2;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

interface EmbedResponse {
  embeddings: number[][];
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(cfg: AppConfig, texts: string[]): Promise<number[][]> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const resp = await fetch(`${cfg.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: cfg.ollamaModel, input: texts }),
      });
      if (!resp.ok) {
        throw new Error(`Ollama /api/embed HTTP ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as EmbedResponse;
      if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        throw new Error(`Ollama 임베딩 개수 불일치: 요청 ${texts.length} / 응답 ${data.embeddings?.length ?? 0}`);
      }
      return data.embeddings;
    } catch (err) {
      lastError = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }
  throw new Error(`Ollama 임베딩 배치 실패(3회 재시도 후): ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** 전체 텍스트를 16건 배치·동시 2배치로 임베딩한다. 순서는 입력과 동일하게 보존된다. */
export async function embedAll(cfg: AppConfig, texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const results: number[][][] = new Array(batches.length);
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < batches.length) {
      const idx = cursor++;
      results[idx] = await embedBatch(cfg, batches[idx]);
      done += batches[idx].length;
      onProgress?.(done, texts.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker());
  await Promise.all(workers);

  return results.flat();
}

/** 질의 1건 임베딩(검색용, 헤더 없이 질의문 그대로 — §5.3). */
export async function embedQuery(cfg: AppConfig, query: string): Promise<number[]> {
  const [vec] = await embedBatch(cfg, [query]);
  return vec;
}

export interface OllamaStatus {
  ok: boolean;
  model: string;
  hasModel: boolean;
  error?: string;
}

/** GET /api/tags 로 Ollama 가동·모델 존재 여부를 확인한다(§5.2 마지막 문단). */
export async function checkOllama(cfg: AppConfig): Promise<OllamaStatus> {
  try {
    const resp = await fetch(`${cfg.ollamaUrl}/api/tags`);
    if (!resp.ok) return { ok: false, model: cfg.ollamaModel, hasModel: false, error: `HTTP ${resp.status}` };
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    const hasModel = (data.models ?? []).some((m) => m.name === cfg.ollamaModel || m.name.startsWith(`${cfg.ollamaModel}:`));
    return { ok: true, model: cfg.ollamaModel, hasModel };
  } catch (err) {
    return { ok: false, model: cfg.ollamaModel, hasModel: false, error: err instanceof Error ? err.message : String(err) };
  }
}
