#!/usr/bin/env sh
# Two-browser game simulation (see scripts/simulate.mjs) in Playwright's Docker
# image, against the running dev stack (docker compose -f docker-compose.dev.yml up).
#
#   scripts/simulate.sh                         # every module combination, once
#   REPEAT=3 ONLY="Intern,Kerosene+Intern" scripts/simulate.sh
#
# BASE defaults to the host's dev client as seen from the container. Failure
# screenshots land in ./sim-output/.
set -e
cd "$(dirname "$0")/.."
mkdir -p sim-output
exec docker run --rm \
  --add-host host.docker.internal:host-gateway \
  -e BASE="${BASE:-http://host.docker.internal:5173}" -e REPEAT -e ONLY -e OUT=/out \
  -v "$PWD/scripts/simulate.mjs:/sim/simulate.mjs:ro" -v "$PWD/sim-output:/out" \
  -w /sim mcr.microsoft.com/playwright:v1.49.0-noble \
  sh -c "npm init -y >/dev/null && npm i --silent playwright@1.49.0 >/dev/null && node simulate.mjs"
