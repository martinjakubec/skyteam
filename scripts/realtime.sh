#!/usr/bin/env sh
# Real-Time module end-to-end checks (see scripts/realtime.mjs) in Playwright's
# Docker image, against the running dev stack (docker compose -f
# docker-compose.dev.yml up). Takes ~2.5 minutes: the rounds run on the clock.
#
#   scripts/realtime.sh
#
# BASE defaults to the host's dev client as seen from the container.
set -e
cd "$(dirname "$0")/.."
exec docker run --rm \
  --add-host host.docker.internal:host-gateway \
  -e BASE="${BASE:-http://host.docker.internal:5173}" \
  -v "$PWD/scripts/realtime.mjs:/sim/realtime.mjs:ro" \
  -w /sim mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c "npm init -y >/dev/null && npm i --silent playwright@1.49.0 >/dev/null && node realtime.mjs"
