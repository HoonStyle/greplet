# greplet MCP 서버 (원격, Streamable HTTP)

greplet 인덱서 `/api/search`·`/api/workspaces` 를 감싸는 **원격 MCP 서버**. Bearer 토큰 인증, stateless. 다른 PC 나 클라우드 에이전트(Claude Cowork 커넥터 등)에서 로컬 인덱서를 쓰게 할 때 사용한다. 같은 PC 에서만 쓸 거면 `greplet-mcpb`(stdio, 인증 불필요)가 더 간단하다.

`greplet.ps1` 의 출력 포맷(점수순·중복 제거·300자 스니펫)을 동치 이식했다. 워크스페이스 병합·정렬은 인덱서가 하므로 이 서버는 API 1회 호출과 포맷팅만 담당한다.

## 구조

```
클라이언트 ──HTTPS+Bearer──▶ (터널) ──▶ 이 서버(:7801, 127.0.0.1 바인딩)
                                          │ localhost REST
                                          ▼
                               greplet 인덱서(:7802, 무인증 로컬 전용)
```

- 툴: `greplet`(검색, 읽기 전용) · `greplet_workspaces`(목록). topN 상한 20, mode hybrid/vector/fts.
- 워크스페이스 목록은 인덱서 `GET /api/workspaces` 에서 받아 온다(60초 캐시). 하드코딩 없음.
- **127.0.0.1 에만 바인딩** — 외부 노출은 반드시 터널(Cloudflare Tunnel 등) 경유.

## 실행

```powershell
# 필수 (미설정 시 기동 거부)
$env:MCP_AUTH_TOKEN = "<클라이언트 Bearer 토큰>"
# 선택
# $env:GREPLET_BASE_URL          기본 http://localhost:7802
# $env:GREPLET_DEFAULT_WORKSPACE  workspace 미지정 시 기본값 (없으면 서버의 첫 워크스페이스)
# $env:PORT                       기본 7801

pwsh ../indexer/start-indexer.ps1     # 인덱서가 먼저 떠 있어야 한다
npm install
npm run build
npm start                             # → http://127.0.0.1:7801/mcp
```

## 검증

```powershell
# 무토큰 401 → initialize → tools/list → greplet 호출
node scripts/smoke.mjs http://127.0.0.1:7801/mcp $env:MCP_AUTH_TOKEN "재시도 백오프 로직"

# 같은 질의를 ps1 로 대조
pwsh ../greplet.ps1 -Query "재시도 백오프 로직" -All
```

## 엔드포인트

| 경로 | 인증 | 용도 |
|---|---|---|
| `POST /mcp` | Bearer 필수 | MCP Streamable HTTP (stateless) |
| `GET /healthz` | 없음 | 가동 확인(`ok`) — 정보 노출 없음 |
