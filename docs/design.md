# greplet 설계

코드·PDF·문서를 **구문 단위로 청킹**해 LanceDB 에 넣고, 벡터(Ollama `bge-m3`) + FTS(BM25) 를 RRF 로 융합하는 로컬 하이브리드 검색 서비스. 소스 주석의 `§번호` 는 이 문서의 절 번호다.

## 0. 목표

| 해소하려는 한계 | 방법 |
|---|---|
| 순수 의미 검색만 있으면 상수·에러 코드·메서드명 같은 정확 토큰에 약하다 | LanceDB FTS(BM25) + 벡터 → RRF 하이브리드, `fts` 단독 모드 제공 |
| 고정 길이 청킹은 메서드 중간에서 끊긴다 | Roslyn 으로 타입·멤버 단위 청킹, PDF 는 페이지 단위 |
| 추가만 반영하고 삭제는 수동 정리해야 하는 업로드형 도구 | 파일 해시 매니페스트로 추가·변경·삭제 전부 증분 반영 |
| 열려 있는 리포 하나만 인덱스하는 IDE 내장 검색 | 로컬 디스크 어디든 여러 루트를 워크스페이스로 묶어 인덱스 |

관리 UI 는 다섯 기능만: 워크스페이스 목록 · 업로드 · 재인덱스 · 검색 테스트 · 진행 로그. 채팅·LLM 생성은 없다.

## 1. 요구 환경

| 항목 | 값 |
|---|---|
| Node | 22+ (개발 24.x) · `@lancedb/lancedb` 0.38 (win32-x64 네이티브) |
| Ollama | `http://localhost:11434`, 모델 `bge-m3` (1024차원). `POST /api/embed` 배열 입력. 16건 × 1200자 배치 ≈ 340 ms |
| .NET SDK | 8.0+ (Extractor 는 `net8.0`) |
| PowerShell | 7+ (`greplet.ps1`, `start-indexer.ps1`, Windows 전용). macOS/Linux 는 `greplet.mjs`, `indexer/start-indexer.sh` 사용 |
| 문서 | PDF(암호 PDF 포함) · HTML · Markdown |

## 2. 구성 요소와 폴더

```
Extractor/                 C# net8 콘솔 — Roslyn·PdfPig 로 청크 JSONL 생성 (§4)
indexer/                   Node/TS 서비스 — 인덱싱·검색 API·정적 UI (§5, §6)
  src/server.ts            Express, 라우팅, SSE
  src/config.ts            env + workspaces.json 로드
  src/scan.ts              파일 열거·SHA256·매니페스트 diff
  src/extract.ts           Extractor 프로세스 호출, JSONL 파싱
  src/embed.ts             Ollama /api/embed 배치·재시도
  src/db.ts                LanceDB 연결·스키마·테이블·FTS 인덱스
  src/indexJob.ts          워크스페이스 인덱스 잡(큐, 로그 이벤트)
  src/search.ts            hybrid/vector/fts 검색
  public/index.html        관리 UI (단일 파일, vanilla JS)
  tests/incremental.mjs    증분 시나리오 검증
  workspaces.json          워크스페이스 정의 (§3) — 리포에는 workspaces.example.json 만
  start-indexer.ps1        백그라운드 기동(Windows)
  start-indexer.sh          백그라운드 기동(macOS/Linux, start-indexer.ps1 동치)
greplet.ps1 · greplet-shared.ps1        CLI 클라이언트, Windows (§7)
greplet.mjs                             CLI 클라이언트, 모든 OS(Node) (§7)
mcp-server/                             원격 MCP 서버, Bearer 인증 (§7)
greplet-mcpb/                           로컬 stdio MCP 번들 (§7)
git-hooks/post-commit                   커밋 후 증분 인덱스 트리거 (§7)
```

머신 로컬 데이터(리포 밖):

```
%LOCALAPPDATA%\greplet\
  db\                        LanceDB 디렉터리 + <slug>.manifest.json
  uploads\<slug>\            UI 업로드 파일 (해당 워크스페이스의 추가 root 로 취급)
  logs\                      인덱스 잡 로그
```

환경변수: `GREPLET_PORT`(7802) · `GREPLET_DATA_DIR`(위 경로) · `OLLAMA_URL`(`http://localhost:11434`) · `GREPLET_WORKSPACES`(workspaces.json 경로) · `GREPLET_EXTRACTOR`(Extractor 실행 파일, 기본 `../Extractor/bin/Release/net8.0/Extractor.exe`, 없으면 `dotnet build` 1회 시도).

## 3. 워크스페이스 정의 (`workspaces.json`)

```json
{
  "slug": "code",
  "label": "내 솔루션",
  "kind": "code",
  "roots": ["C:\\work\\my-solution"],
  "includeExt": [".cs", ".csproj", ".sln", ".xaml", ".proto", ".config", ".md"],
  "excludeDirs": ["bin", "obj", ".vs", ".git", "packages", "node_modules"],
  "excludeFiles": ["*.Designer.cs", "AssemblyInfo.cs", "*.g.cs", "*.g.i.cs"],
  "pdfPasswordFile": null
}
```

- `kind`: `code` | `docs`. 기본 `includeExt` 는 code → `.cs .csproj .sln .xaml .proto .config .settings .manifest .md`, docs → `.pdf`. 명시하면 대체.
- `excludeDirs` 는 경로 세그먼트 단위 매칭, `excludeFiles` 는 파일명 글롭. 명시하면 기본값을 대체한다.
- `roots` 는 절대경로. 파일 키(`file`)는 root 기준 상대경로(`/` 구분)라 root 가 바뀌면 전체 재인덱스가 필요하다.
- `pdfPasswordFile`: 줄마다 비밀번호 하나. 빈 비밀번호를 항상 먼저 시도한다.

## 4. Extractor (C#)

### 4.1 CLI

```
Extractor --root <dir> [--root <dir2> ...]
          --ext .cs,.xaml --exclude-dir bin,obj --exclude-file "*.Designer.cs,AssemblyInfo.cs"
          [--files <list.txt>]            # 지정 시 이 파일들만(절대경로, 줄 단위) — 증분용
          [--pdf-password-file <path>]
          --out <chunks.jsonl>
```

- 파일 열거 규칙은 `indexer/src/scan.ts` 와 동일해야 한다(ext 소문자 비교, 경로 세그먼트 중 하나라도 exclude-dir 이면 제외, 파일명 글롭).
- stdout 진행 로그(`[n/N] file → k chunks`), stderr 오류. 종료 코드 0 = 전체 성공, 2 = 일부 파일 실패(계속 진행).

### 4.2 JSONL 레코드

```json
{"file":"Lib/Retry/RetryPolicy.cs","abs":"C:\\work\\my-solution\\Lib\\Retry\\RetryPolicy.cs","root":"C:\\work\\my-solution",
 "hash":"<sha256 hex of original bytes>","symbol":"RetryPolicy.Execute","kind":"method","startLine":120,"endLine":161,
 "text":"// Lib/Retry/RetryPolicy.cs\n// namespace My.Lib.Retry\n// class RetryPolicy : IRetryPolicy\npublic bool Execute(Func<bool> action) { ... }"}
```

`file` 은 root 기준 상대경로(`/`). 줄번호는 1-based, 원본 파일 기준.

### 4.3 인코딩

UTF-8 strict 디코딩 → 실패 시 CP949(`System.Text.Encoding.CodePages`) → BOM 제거. 해시는 **원본 바이트** 기준.

### 4.4 C# 청킹 (Roslyn)

`CSharpSyntaxTree.ParseText` 후 구문 트리 순회. 시맨틱 모델 없음.

1. **타입 선언 청크**(kind `type`): 특성·주석(leading trivia)·헤더·베이스 목록·제네릭 제약. 멤버 본문 제외. enum 은 멤버 포함 하나.
2. **멤버 청크**: 메서드·생성자·소멸자·속성·인덱서·이벤트·연산자·변환 연산자 각각(kind `method` `ctor` `property` `event` `operator`). leading trivia 포함.
3. **필드 묶음**(kind `fields`): 같은 타입의 필드·상수 전부 하나. symbol `Class.<fields>`.
4. **컨텍스트 헤더** 3줄을 모든 청크 앞에: `// {file}` · `// namespace {ns}` · `// {kind} {TypeName} : {bases}`. 임베딩·FTS 모두 헤더 포함 텍스트를 쓴다.
5. **크기**(헤더 제외): 멤버 > 6000자 → 줄 경계 4000자 윈도우 / 400자 오버랩(symbol `#1 #2 …`). 연속한 300자 미만 멤버는 1200자까지 병합(kind `members`, symbol `Class.{A,B,C}`).
6. 타입이 없거나 파싱 실패 → §4.5 텍스트 규칙 폴백.
7. 지역 함수·람다는 분리하지 않는다.

symbol: `TypeName.MemberName`, 오버로드 `Name(int,string)`, 중첩 타입 `Outer.Inner.Member`.

### 4.5 기타 텍스트

`.xaml .csproj .sln .proto .config .settings .manifest .md .txt`: 줄 단위 윈도우 3000자 / 300자 오버랩. symbol `L{start}-{end}`, kind `text`, 헤더 `// {file}` 1줄. HTML 은 script·style·head 제거 → 블록 경계 줄바꿈 → 태그 제거 → 엔티티 디코드 후 같은 규칙.

### 4.6 PDF (PdfPig)

- `PdfDocument.Open(path, new ParsingOptions { Password })`. 비밀번호 파일의 줄을 순서대로 시도(빈 비밀번호 먼저).
- 페이지별 `ContentOrderTextExtractor.GetText`, 공백 정규화.
- 페이지 1개 = 청크 1개(kind `page`, symbol `p.{n}`). 3000자 초과 페이지는 3000/300 분할(`p.{n}#k`).
- 30자 미만 페이지(스캔 이미지)는 건너뛰고 파일별 스킵 수를 stderr 요약에 남긴다.
- 헤더 `// {file}` + `// page {n}/{total}`.

### 4.7 검증(추출기 단독)

- C# 파일 하나 → 메서드별 청크, `startLine` 이 해당 메서드 첫 줄(leading trivia 포함)과 일치.
- PDF 하나 → 페이지 수 = 청크 수(분할 제외). 암호 PDF 열림.
- CP949 파일 모지바케 없음.

## 5. Indexer (Node/TS)

### 5.1 스키마 · 테이블

워크스페이스당 테이블 1개, 이름 `ws_<slug with - → _>`. Arrow 스키마 명시:

| 컬럼 | 타입 |
|---|---|
| `id` | Utf8 — `${file}#${symbol}` |
| `file` `abs` `root` `symbol` `kind` `file_hash` `indexed_at` | Utf8 |
| `start_line` `end_line` | Int32 |
| `text` | Utf8 (헤더 포함 청크 전문) |
| `vector` | FixedSizeList(1024, Float32) |

벡터 인덱스는 만들지 않는다(워크스페이스당 수만 행 이하, flat 스캔 충분). FTS 인덱스는 `text` 에:

```ts
await table.createIndex("text", {
  config: Index.fts({ baseTokenizer: "simple", stem: false, removeStopWords: false, asciiFolding: true, lowercase: true }),
  replace: true,
});
```

`simple` 토크나이저는 `0x0A03` 같은 토큰을 쪼개지 않아 정확 매칭이 된다.

### 5.2 매니페스트 · 증분

`db/<slug>.manifest.json`: `{ lastRun, files: { "<file>": { hash, chunks, indexedAt } }, embeddings }`. `embeddings` 는 임베딩 모델명 또는 `"none"`(벡터 없이 인덱싱됨). 필드가 없는 구버전 매니페스트는 임베딩 있음으로 간주한다. 쓰기는 임시 파일 + `renameSync` 로 원자적으로 한다(검색이 매니페스트를 읽으므로 잡 도중 부분 쓰기를 막는다).

1. roots(+uploads) 스캔, SHA256 → 매니페스트와 비교해 `added / changed / deleted`. `force` 면 전부 changed.
2. `deleted ∪ changed` 행 삭제: `table.delete("file IN ('a','b',…)")`, 작은따옴표 `''` 이스케이프, 500개 단위.
3. `added ∪ changed` 만 `--files` 로 Extractor 호출 → JSONL 스트리밍 파싱.
4. 임베딩: Ollama 가 준비돼 있으면 16건 배치, 동시 2배치, `POST {OLLAMA_URL}/api/embed { model, input: string[] }`. 실패 시 1s→2s→4s 재시도 3회, 그래도 실패면 잡 실패. 부분 반영 파일은 매니페스트에 안 남겨 다음 실행에 재시도된다. Ollama 가 준비돼 있지 않으면 이 단계를 건너뛰고 각 청크의 벡터를 영벡터(`zeroVector()`, `db.ts`)로 채운다.
5. 200행 단위 `table.add` → 매니페스트 갱신(성공 파일만, `embeddings` 필드에 임베딩 여부 기록) → FTS 인덱스 재생성 → `optimize`.
6. 잡 로그: 메모리 링버퍼(잡당 2000줄) + `logs/<slug>-<jobId>.log`.

전역 큐로 **한 번에 잡 1개**. 같은 slug 가 대기 중이면 중복 등록하지 않는다. Ollama 준비 상태는 매니페스트 로드 직후 `GET /api/tags` 로 확인하되, 미가동·모델 없음이어도 잡을 실패시키지 않고 경고 로그 후 벡터 없이(영벡터) 계속 진행한다 — 매니페스트가 `"none"` 이었는데 Ollama 가 준비된 경우에만 전체 재인덱스로 승격한다.

### 5.3 검색

```ts
const qvec = await embed([query]);                       // 헤더 없이 질의문 그대로
let q = table.query().nearestTo(qvec[0]).distanceType("cosine");
if (mode === "hybrid") q = q.fullTextSearch(query).rerank(await rerankers.RRFReranker.create());
const rows = await q.select(cols).limit(poolSize).toArray();   // 융합 후 topN 만 남긴다
```

- `hybrid`(기본) · `vector`(nearestTo 만) · `fts`(fullTextSearch 만, 임베딩 호출 없음).
- 점수는 `score` 하나로 정규화(hybrid `_relevance_score`, vector `1-_distance`, fts `_score`), 응답에 `mode` 동봉.
- FTS 구문 오류(특수문자 질의) → `vector` 로 자동 폴백, `warnings` 기록. vector 경로 자체가 실패해도(예: Ollama 가 잡 도중 죽음) `fts` 로 폴백한다.
- 임베딩 없는 워크스페이스(매니페스트 `embeddings === "none"`) 는 `hybrid`/`vector` 요청이 와도 검색 시작 시 `fts` 로 강등한다. 영벡터에 cosine 을 적용하면 결과가 전부 NaN 이 되므로 이 강등이 유일한 보호막이다. `warnings` 에 강등 사실을 남긴다.
- 다중 워크스페이스는 병렬 조회 후 점수 내림차순 병합. RRF 점수는 `1/(k+rank)` 합이라 테이블 간 비교 가능.
- **후보 풀**: LanceDB 의 `limit` 은 벡터·FTS 하위 질의 각각에 걸린다. topN 만 주면 두 목록이 거의 겹치지 않아 RRF 점수가 전부 동점이 되고 순위가 사실상 무작위가 된다. 하위 질의마다 최소 50건(`HYBRID_MIN_POOL`)을 뽑아 융합한 뒤 topN 만 남긴다.

### 5.4 LanceDB API 형태 (0.38 에서 확인)

```ts
import { connect, Index, rerankers } from "@lancedb/lancedb";
const db = await connect(dbDir);
const t = await db.createEmptyTable(name, schema);
await t.createIndex("text", { config: Index.fts({ baseTokenizer: "simple", stem: false, removeStopWords: false, asciiFolding: true }) });
const rr = await rerankers.RRFReranker.create();
const res = await t.query().nearestTo(vec).distanceType("cosine").fullTextSearch("0x0A03").rerank(rr).select(["id","text"]).limit(50).toArray();
// res[i]._relevance_score
const fts = await t.query().fullTextSearch("0x0A03").select(["id","text"]).limit(3).toArray();  // fts[i]._score
await t.delete("file IN ('a')"); await t.countRows();
```

`apache-arrow` 는 `@lancedb/lancedb` 가 의존하는 버전(18.1.0)에 고정한다. 버전이 어긋나면 스키마 객체가 호환되지 않는다.

### 5.5 HTTP API (`127.0.0.1:7802`, 무인증 — 로컬 전용)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /healthz` | | `ok` |
| `GET /api/status` | | `{ ollama: {ok, model, hasModel}, dbDir, extractor: {ok, path}, queue: [slug…] }` |
| `GET /api/workspaces` | | `[{ slug, label, kind, roots, files, chunks, lastRun, indexing, embeddings }]` |
| `POST /api/search` | `{ query, workspaces: string[] \| "all", topN=6, mode="hybrid" }` | `{ hits: [{ workspace, file, symbol, kind, startLine, endLine, score, text }], mode, warnings }` (topN 상한 20) |
| `POST /api/index/:slug` | `{ force?: boolean }` | `202 { jobId }` · 이미 큐에 있으면 `200 { jobId, queued: true }` |
| `GET /api/jobs` | | 최근 잡 20개 |
| `GET /api/jobs/:id/events` | SSE | 로그 라인 스트림(링버퍼 재생 후 실시간), 종료 시 `event: done` |
| `POST /api/upload/:slug` | multipart `files[]` | `uploads/<slug>/` 저장 → 증분 인덱스 등록 |
| `DELETE /api/workspaces/:slug/files?file=<rel>` | | 업로드 파일 삭제 + 재인덱스(uploads 하위만) |
| `GET /` | | 관리 UI |

slug 는 `workspaces.json` 목록으로 화이트리스트 검증. 업로드 파일명은 basename 만 취하고 `..` 제거.

### 5.6 기동

- `npm run build` → `npm start`(`node dist/server.js`). 개발 시 `npm run dev`(tsx).
- `start-indexer.ps1`: `GET /healthz` 200 이면 종료, 아니면 `Start-Process node dist/server.js -WindowStyle Hidden`, 로그 `logs/server.log`. healthz 를 최대 10초 폴링. 폴링 주소는 `127.0.0.1` 을 명시한다(`localhost` 는 .NET HttpClient 가 IPv6 를 먼저 시도해 수 초 지연될 수 있음).
- `start-indexer.sh`: 동치 동작을 bash 로 구현(macOS/Linux). `GET /healthz` 200 이면 종료, 아니면 `nohup node dist/server.js` 백그라운드 기동 후 `127.0.0.1` healthz 를 최대 10초 폴링, 로그 `logs/server.log`.
- 서버 기동 시 `GREPLET_EXTRACTOR` 경로 확인, 없으면 `dotnet build ../Extractor -c Release` 1회 시도.

## 6. 관리 UI (`public/index.html`)

워크스페이스 목록(청크 수·마지막 인덱스) · 파일 업로드 · [증분 인덱스]/[전체 재인덱스] · 검색 테스트(모드·topN) · 잡 진행 로그(SSE). 외부 CDN 없이 단일 파일.

## 7. 클라이언트

모두 인덱서 `/api/search` 1회 호출 + 동일한 포맷팅(점수순, `파일|선두 80자` 중복 제거, 300자 스니펫, `#rank  score x.xxxx  |  [ws] file :: symbol (Lstart-end)`, PDF 는 `:: p.N`).

- `greplet.ps1`: `-Query -Workspace -All -TopN -Full -Mode -BaseUrl`. `-Workspace` 미지정 시 `GREPLET_DEFAULT_WORKSPACE` → `workspaces.json` 첫 항목.
- `greplet.mjs`: Windows 를 포함한 모든 OS 에서 동작하는 Node CLI 동치물. `<query> -q -w --all --top-n --full --mode --base-url`. `-w` 미지정 시 `GREPLET_DEFAULT_WORKSPACE` → `workspaces.json` 첫 항목.
- `mcp-server`: Streamable HTTP, stateless, Bearer 필수, `127.0.0.1:7801` 바인딩(외부 노출은 터널 경유). 툴 `greplet` · `greplet_workspaces`.
- `greplet-mcpb`: stdio, 인증 없음(로컬). 같은 툴 2개. 워크스페이스 목록은 `GET /api/workspaces` 로 받아 온다(60초 캐시).
- `git-hooks/post-commit`: `git config greplet.slug` 가 가리키는 워크스페이스에 `POST /api/index/:slug`. 서버 꺼져 있으면 조용히 스킵.

## 8. 검증

1. `dotnet build Extractor -c Release`, indexer·mcp-server `npm run build` 경고·오류 0.
2. §4.7.
3. `tests/incremental.mjs`: 임시 root 워크스페이스에서 파일 2개 추가 → 인덱스 → 1개 수정 → 해당 파일 청크만 교체(id 집합 비교) → 1개 삭제 → 청크 0, 매니페스트에서 제거.
4. `greplet.ps1 -Mode fts` 로 실제 존재하는 상수 리터럴 검색 → 그 상수를 담은 청크가 1위. `-All` 이 빈 워크스페이스가 있어도 오류 없이 동작.
5. `mcp-server` `npm run smoke`, `greplet-mcpb` `npm run smoke`.
