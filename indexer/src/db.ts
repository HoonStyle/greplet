/*
  db.ts — LanceDB 연결·스키마·테이블·FTS 인덱스(§5.1, §5.4). API 형태는 프로브로 검증된 것을 그대로 쓴다.
*/
import path from "node:path";
import { connect, Index, type Connection, type Table } from "@lancedb/lancedb";
// apache-arrow 는 @lancedb/lancedb 가 의존하는 버전(node_modules 에 호이스팅됨)을 그대로 쓴다 — 버전 불일치 방지.
import { Schema, Field, Utf8, Int32, FixedSizeList, Float32 } from "apache-arrow";
import type { AppConfig, WorkspaceConfig } from "./config.js";

export const VECTOR_DIM = 1024;

/** Ollama 없이 인덱싱할 때 채우는 영벡터. null 은 LanceDB 가 non-nullable 컬럼에서 거부하므로 쓰지 않는다(§8 프로브로 확인). */
export function zeroVector(): number[] {
  return new Array(VECTOR_DIM).fill(0);
}

export function tableNameFor(slug: string): string {
  return "ws_" + slug.replace(/-/g, "_");
}

export function buildSchema(): Schema {
  return new Schema([
    new Field("id", new Utf8()),
    new Field("file", new Utf8()),
    new Field("abs", new Utf8()),
    new Field("root", new Utf8()),
    new Field("symbol", new Utf8()),
    new Field("kind", new Utf8()),
    new Field("file_hash", new Utf8()),
    new Field("indexed_at", new Utf8()),
    new Field("start_line", new Int32()),
    new Field("end_line", new Int32()),
    new Field("text", new Utf8()),
    new Field("vector", new FixedSizeList(VECTOR_DIM, new Field("item", new Float32()))),
  ]);
}

let connectionPromise: Promise<Connection> | null = null;

export function getConnection(cfg: AppConfig): Promise<Connection> {
  if (!connectionPromise) {
    connectionPromise = connect(cfg.dbDir);
  }
  return connectionPromise;
}

/** 워크스페이스 테이블을 열거나(없으면) 빈 스키마로 생성한다. */
export async function openOrCreateTable(cfg: AppConfig, ws: WorkspaceConfig): Promise<Table> {
  const db = await getConnection(cfg);
  const name = tableNameFor(ws.slug);
  const names = await db.tableNames();
  if (names.includes(name)) {
    return db.openTable(name);
  }
  return db.createEmptyTable(name, buildSchema());
}

export async function tableExists(cfg: AppConfig, ws: WorkspaceConfig): Promise<boolean> {
  const db = await getConnection(cfg);
  const names = await db.tableNames();
  return names.includes(tableNameFor(ws.slug));
}

/** text 컬럼 FTS 인덱스 재생성(§5.1). */
export async function rebuildFtsIndex(table: Table): Promise<void> {
  await table.createIndex("text", {
    config: Index.fts({ baseTokenizer: "simple", stem: false, removeStopWords: false, asciiFolding: true, lowercase: true }),
    replace: true,
  });
}

/** file IN (...) 조건으로 행 삭제. 500개 단위로 나눠 실행한다(§5.2-2). */
export async function deleteByFiles(table: Table, fileKeys: string[]): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < fileKeys.length; i += CHUNK) {
    const slice = fileKeys.slice(i, i + CHUNK);
    const list = slice.map((f) => `'${f.replace(/'/g, "''")}'`).join(", ");
    await table.delete(`file IN (${list})`);
  }
}

export function manifestPathFor(cfg: AppConfig, slug: string): string {
  return path.join(cfg.dbDir, `${slug}.manifest.json`);
}
