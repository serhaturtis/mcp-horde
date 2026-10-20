#!/usr/bin/env bash
# The project's checks, run locally (they replaced the GitHub Actions workflow).
#
#   ./ci.sh            lint, typecheck, bundle check, build, tests (npm ci first when node_modules is missing)
#   ./ci.sh --install  a clean install (npm ci) first, as the old CI did
#   ./ci.sh --live     also the real-model e2e scenarios: HORDE_E2E_MODEL (default
#                      deepseek/deepseek-flash, needs DEEPSEEK_API_KEY, a few cents a run)
#   ./ci.sh --latest   also the tests against OpenCode's latest release; reinstalls the pinned one after
set -euo pipefail
cd "$(dirname "$0")"

install= live= latest=
for arg; do
  case $arg in
    --install) install=1 ;;
    --live) live=1 ;;
    --latest) latest=1 ;;
    *) echo "usage: $0 [--install] [--live] [--latest]" >&2; exit 2 ;;
  esac
done

set -x
if [[ $install || ! -d node_modules ]]; then npm ci; fi
npm run lint
npm run typecheck
node scripts/bundle-plugin.mjs --check
node scripts/eval-tools.mjs --check
npm run build
npm test

if [[ $live ]]; then
  HORDE_E2E_MODEL=${HORDE_E2E_MODEL:-deepseek/deepseek-flash} npm run test:e2e -w @mcp-horde/opencode
fi

if [[ $latest ]]; then
  trap 'npm ci' EXIT
  npm install --no-save @opencode/cli@latest @opencode/client@latest -w @mcp-horde/opencode
  npm ls @opencode/cli @opencode/client -w @mcp-horde/opencode || true
  npm run build
  npm test
fi
