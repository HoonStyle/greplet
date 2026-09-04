#!/usr/bin/env bash
# start-indexer.sh - greplet 인덱서 서버 백그라운드 기동(§5.6).
# 이미 떠 있으면(healthz 200) 그대로 스킵하고, 아니면 새로 띄운 뒤 healthz 를 최대 10초 폴링한다.
#
# 사용: bash indexer/start-indexer.sh [BASE_URL] [--open|--no-open]
#   BASE_URL   기본 http://127.0.0.1:7802
#   --open     기동 확인 후 관리 UI 를 기본 브라우저로 연다 (기본값, 환경변수 GREPLET_OPEN_UI=1 과 동일)
#   --no-open  관리 UI 를 열지 않는다 (환경변수 GREPLET_OPEN_UI=0 과 동일)
set -euo pipefail

BASE_URL="http://127.0.0.1:7802"
OPEN_UI="${GREPLET_OPEN_UI:-1}"
for arg in "$@"; do
  case "$arg" in
    --open) OPEN_UI=1 ;;
    --no-open) OPEN_UI=0 ;;
    http://*|https://*) BASE_URL="$arg" ;;
    *) echo "[start-indexer] 알 수 없는 인자: $arg" >&2; exit 2 ;;
  esac
done

open_ui() {
  [ "$OPEN_UI" = "1" ] || return 0
  local url="${BASE_URL/127.0.0.1/localhost}"
  if command -v open >/dev/null 2>&1; then open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  else echo "[start-indexer] 브라우저를 열 명령이 없습니다. 직접 여세요: $url"; fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PATH="$SCRIPT_DIR/logs/server.log"

check_healthz() {
  local code
  code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BASE_URL/healthz" || true)"
  [ "$code" = "200" ]
}

if check_healthz; then
  echo "[start-indexer] 이미 기동 중 ($BASE_URL) — 스킵"
  open_ui
  exit 0
fi

DIST_SERVER="$SCRIPT_DIR/dist/server.js"
if [ ! -f "$DIST_SERVER" ]; then
  echo "[start-indexer] dist/server.js 가 없습니다. 먼저 'npm run build' 를 실행하세요. ($DIST_SERVER)" >&2
  exit 1
fi

# Homebrew 의 dotnet@8 은 keg-only 라 PATH/DOTNET_ROOT 에 없으면 Extractor(apphost)가 런타임을 못 찾는다.
# DOTNET_ROOT 미설정이고 brew keg 가 있으면 자동으로 잡아 준다(사용자가 이미 설정했으면 존중).
if [ -z "${DOTNET_ROOT:-}" ]; then
  for keg in /opt/homebrew/opt/dotnet@8/libexec /usr/local/opt/dotnet@8/libexec; do
    if [ -x "$keg/dotnet" ]; then
      export DOTNET_ROOT="$keg"
      export PATH="$keg:$PATH"
      break
    fi
  done
fi

mkdir -p "$SCRIPT_DIR/logs"

echo "[start-indexer] node dist/server.js 기동 중... (로그: $LOG_PATH)"
(
  cd "$SCRIPT_DIR"
  nohup node dist/server.js >>"$LOG_PATH" 2>>"$LOG_PATH.err" </dev/null &
)

deadline=$(( $(date +%s) + 10 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if check_healthz; then
    echo "[start-indexer] 기동 확인 ($BASE_URL)"
    open_ui
    exit 0
  fi
  sleep 0.5
done

echo "[start-indexer] 10초 내 healthz 응답 없음 — 로그 확인: $LOG_PATH / $LOG_PATH.err" >&2
exit 1
