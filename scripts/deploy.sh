#!/usr/bin/env bash
# Validate and release the three Workers using their committed Wrangler settings.
# Infrastructure setup and role administration are separate operations.
set -euo pipefail

# Reject old preparation modes before invoking any deployment tools.
if [[ "${1:-}" == --help && "$#" -eq 1 ]]; then
  printf 'pnpm deploy:hosted\nValidate, migrate D1, and deploy API, Tools, and App with Wrangler.\n'
  exit 0
fi
if [[ "$#" -ne 0 ]]; then
  printf 'Use pnpm deploy:hosted without options; use pnpm deploy:roles for roles.\n' >&2
  exit 1
fi

# Resolve every configuration from the checkout, regardless of the caller's directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# A development shell must not select a named environment for hosted releases.
unset CLOUDFLARE_ENV

# Complete local validation before making hosted changes. Wrangler authenticates
# with the operator's login or CLOUDFLARE_API_TOKEN when deployment begins.
pnpm cf:types
pnpm typecheck
pnpm exec vp check --no-fmt
pnpm test
pnpm build
pnpm build:storybook
pnpm test:browser

# Both backend Workers share D1; apply its pending migrations only once.
pnpm exec wrangler d1 migrations apply DB --remote --env="" --config apps/api/wrangler.jsonc

# API exposes provider entrypoints consumed by Tools. Publish the public App last.
pnpm exec wrangler deploy --env="" --config apps/api/wrangler.jsonc
pnpm exec wrangler deploy --env="" --config apps/tools/wrangler.jsonc
pnpm exec wrangler deploy --env="" --config apps/web/deploy/wrangler.jsonc
