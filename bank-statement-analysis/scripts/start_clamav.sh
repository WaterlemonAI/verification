#!/bin/sh
set -eu

clamd --config-file=/app/clamd.conf &
clamd_pid=$!

update_signatures() {
  freshclam --config-file=/app/freshclam.conf --stdout || true
}

(
  while kill -0 "$clamd_pid" 2>/dev/null; do
    update_signatures
    sleep 7200
  done
) &
updater_pid=$!

cleanup() {
  kill "$updater_pid" "$clamd_pid" 2>/dev/null || true
  wait "$updater_pid" "$clamd_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait "$clamd_pid"
