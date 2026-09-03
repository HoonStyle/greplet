#!/usr/bin/env bash
# screenshot.sh - README 용 관리 UI 스크린샷(docs/images/dashboard.png)을 다시 찍는다.
#
# 임시 워크스페이스 3개(code / code-legacy / docs)를 리포 자체를 소재로 만들고, Ollama 가 없어도 되도록
# 해시 기반 모의 임베딩 서버를 띄운 뒤, 인덱싱 → 검색 결과가 뜬 화면을 Playwright 로 캡처한다.
# 개인 경로가 화면에 남지 않도록 루트는 /tmp 아래 심볼릭 링크로 만든다.
#
# 사용: bash scripts/screenshot.sh [출력 경로]      (기본 docs/images/dashboard.png)
# 요구: python3 + playwright, node, 빌드된 indexer/dist, Extractor 바이너리(또는 dotnet)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$REPO/docs/images/dashboard.png}"
PORT=7896
MOCK_PORT=11498
QUERY="재시도 백오프"

[ -f "$REPO/indexer/dist/server.js" ] || { echo "indexer/dist 가 없습니다. cd indexer && npm run build" >&2; exit 1; }

T="$(mktemp -d /tmp/greplet-shot.XXXX)"
cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$T"
}
trap cleanup EXIT

# --- 모의 Ollama (/api/tags, /api/embed) ---
cat > "$T/mock.mjs" <<'EOF'
import http from "node:http"; import crypto from "node:crypto";
function vec(t){const h=crypto.createHash("sha256").update(t).digest();const v=[];for(let i=0;i<1024;i++)v.push(((h[i%32]+i*7)%97)/97-0.5);return v;}
http.createServer((req,res)=>{let b="";req.on("data",d=>b+=d);req.on("end",()=>{
 if(req.url==="/api/tags"){res.end(JSON.stringify({models:[{name:"bge-m3:latest"}]}));return;}
 if(req.url==="/api/embed"){const {input}=JSON.parse(b);res.end(JSON.stringify({embeddings:input.map(vec)}));return;}
 res.statusCode=404;res.end();});}).listen(Number(process.argv[2]),"127.0.0.1");
EOF
node "$T/mock.mjs" "$MOCK_PORT" & MOCK_PID=$!
disown "$MOCK_PID"

# --- 샘플 워크스페이스 (리포 자체, 짧은 경로) ---
mkdir -p "$T/work"
ln -s "$REPO/indexer/src" "$T/work/my-solution"
ln -s "$REPO/Extractor"   "$T/work/legacy-v1"
ln -s "$REPO/docs"        "$T/work/specs"
cat > "$T/ws.json" <<EOF
[{"slug":"code","label":"메인 솔루션","kind":"code","roots":["$T/work/my-solution"],"includeExt":[".ts"]},
 {"slug":"code-legacy","label":"레거시 소스","kind":"code","roots":["$T/work/legacy-v1"],"includeExt":[".cs"],"excludeDirs":["bin","obj"]},
 {"slug":"docs","label":"사양서·설계 문서","kind":"docs","roots":["$T/work/specs"],"includeExt":[".md"]}]
EOF

# --- 인덱서 (포그라운드 자식으로 띄워 종료 시 같이 정리) ---
if [ -z "${DOTNET_ROOT:-}" ]; then
  for keg in /opt/homebrew/opt/dotnet@8/libexec /usr/local/opt/dotnet@8/libexec; do
    [ -x "$keg/dotnet" ] && export DOTNET_ROOT="$keg" && export PATH="$keg:$PATH" && break
  done
fi
(
  cd "$REPO/indexer"
  GREPLET_WORKSPACES="$T/ws.json" GREPLET_DATA_DIR="$T/data" GREPLET_PORT="$PORT" \
  OLLAMA_URL="http://127.0.0.1:$MOCK_PORT" exec node dist/server.js >"$T/server.log" 2>&1
) & SERVER_PID=$!
disown "$SERVER_PID"

for _ in $(seq 1 20); do
  curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/healthz" && break
  sleep 0.5
done
curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/healthz" || { echo "인덱서 기동 실패"; cat "$T/server.log"; exit 1; }

for s in code code-legacy docs; do
  curl -s -X POST "http://127.0.0.1:$PORT/api/index/$s" -H 'Content-Type: application/json' -d '{}' >/dev/null
done
for _ in $(seq 1 120); do
  N=$(curl -s "http://127.0.0.1:$PORT/api/jobs" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>console.log(JSON.parse(b).filter(j=>j.state==="done"||j.state==="failed").length))')
  [ "$N" = "3" ] && break
  sleep 1
done
echo "[screenshot] 인덱싱 완료:"
curl -s "http://127.0.0.1:$PORT/api/workspaces" | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>JSON.parse(b).forEach(w=>console.log("  ",w.slug,w.files,"files",w.chunks,"chunks")))'

# --- 완료된 인덱싱 뒤 활동 피드용 모의 트래픽 (5 queries × 3 clients) ---
for query in "재시도 백오프" "SSE 이벤트" "매니페스트 diff" "RRF rerank" "fileGlob 정규식"; do
  for client in mcp:claude mcp:codex cli; do
    curl -s -X POST "http://127.0.0.1:$PORT/api/search" \
      -H 'Content-Type: application/json' -H "X-Greplet-Client: $client" \
      -d "$(node -e 'console.log(JSON.stringify({query:process.argv[1],workspaces:"all",topN:3,mode:"hybrid"}))' "$query")" >/dev/null &
  done
done
wait

# --- 캡처 (1400×1100 논리 픽셀, 2배율) ---
mkdir -p "$(dirname "$OUT")"
OUT="$OUT" PORT="$PORT" QUERY="$QUERY" python3 - <<'PY'
import os
import sys
import threading
import urllib.request
import json

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[screenshot] python3 playwright가 필요합니다. 설치: python3 -m pip install playwright && python3 -m playwright install chromium", file=sys.stderr)
    sys.exit(1)

base = f"http://127.0.0.1:{os.environ['PORT']}"

def post(path, payload, client=None):
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if client:
        headers["X-Greplet-Client"] = client
    request = urllib.request.Request(base + path, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30):
            pass
    except Exception as exc:
        print(f"[screenshot] 모의 요청 실패: {path}: {exc}", file=sys.stderr)

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 1100}, device_scale_factor=2)
    page.goto(base + "/?demo=0", wait_until="load")

    page.wait_for_timeout(1200)  # hello 수신 대기

    # 캐시에 없는 새 질의를 동시에 보내 파이프가 점등된 순간을 잡는다
    threads = []
    for index, (query, client) in enumerate([("임베딩 배치 재시도", "mcp:claude"), ("LanceDB FTS 인덱스 생성", "mcp:codex"), ("Extractor JSONL 파싱", "cli")]):
        thread = threading.Thread(target=post, args=("/api/search", {"query": query, "workspaces": "all", "topN": 3, "mode": "hybrid"}, client))
        thread.start()
        threads.append(thread)
    index_thread = threading.Thread(target=post, args=("/api/index/code", {"force": True}))
    index_thread.start()
    threads.append(index_thread)
    page.wait_for_timeout(450)
    page.screenshot(path=os.environ["OUT"], full_page=False)
    for thread in threads:
        thread.join(timeout=30)
    browser.close()
PY
echo "[screenshot] 저장: $OUT"
