#!/usr/bin/env bash
set -euo pipefail

node_pid=""
searxng_pid=""

shutdown() {
  echo "Shutting down processes..."
  if [[ -n "${node_pid}" ]] && kill -0 "${node_pid}" 2>/dev/null; then
    kill -TERM "${node_pid}" 2>/dev/null || true
  fi
  if [[ -n "${searxng_pid}" ]] && kill -0 "${searxng_pid}" 2>/dev/null; then
    kill -TERM "${searxng_pid}" 2>/dev/null || true
  fi
  wait || true
}

trap shutdown SIGINT SIGTERM

export SEARXNG_SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}"
export SEARXNG_BIND_ADDRESS="${SEARXNG_BIND_ADDRESS:-127.0.0.1}"
export SEARXNG_PORT="${SEARXNG_PORT:-8080}"
export SEARXNG_BASE_URL="${SEARXNG_BASE_URL:-http://127.0.0.1:8080}"

cd /opt/searxng
/opt/searxng-venv/bin/python -m searx.webapp &
searxng_pid=$!

echo "Waiting for SearXNG on ${SEARXNG_BASE_URL}..."
for attempt in $(seq 1 60); do
  if curl -fsS "${SEARXNG_BASE_URL}/healthz" >/dev/null 2>&1 || curl -fsS "${SEARXNG_BASE_URL}/" >/dev/null 2>&1; then
    echo "SearXNG is reachable"
    break
  fi

  if ! kill -0 "${searxng_pid}" 2>/dev/null; then
    echo "SearXNG exited before becoming healthy"
    wait "${searxng_pid}"
    exit 1
  fi

  if [[ "${attempt}" == "60" ]]; then
    echo "SearXNG did not become healthy in time"
    exit 1
  fi

  sleep 1
done

cd /app
node dist/app.js &
node_pid=$!

while true; do
  if ! kill -0 "${node_pid}" 2>/dev/null; then
    echo "Node process exited"
    set +e
    wait "${node_pid}"
    status=$?
    set -e
    shutdown
    exit "${status}"
  fi

  if ! kill -0 "${searxng_pid}" 2>/dev/null; then
    echo "SearXNG process exited"
    set +e
    wait "${searxng_pid}"
    status=$?
    set -e
    shutdown
    exit "${status}"
  fi

  sleep 2
done
