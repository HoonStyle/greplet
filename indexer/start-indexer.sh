#!/usr/bin/env bash
# start-indexer.sh - greplet 인덱서 서버 백그라운드 기동(§5.6).
# 이미 떠 있으면(healthz 200) 그대로 스킵하고, 아니면 새로 띄운 뒤 healthz 를 최대 10초 폴링한다.
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:7802}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_PATH="$SCRIPT_DIR/logs/server.log"

check_healthz() {
  local code
  code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "$BASE_URL/healthz" || true)"
  [ "$code" = "200" ]
}

if check_healthz; then
  echo "[start-indexer] 이미 기동 중 ($BASE_URL) — 스킵"
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
    exit 0
  fi
  sleep 0.5
done

echo "[start-indexer] 10초 내 healthz 응답 없음 — 로그 확인: $LOG_PATH / $LOG_PATH.err" >&2
exit 1
