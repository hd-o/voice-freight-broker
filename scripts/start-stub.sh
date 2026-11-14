#!/usr/bin/env bash
# Stop on failed commands, unset variables, or failures within pipelines.
set -euo pipefail

# Use the first argument as the stub scenario, or default to workflow.
scenario="${1:-workflow}"

# Accept only the supported stub scenarios.
case "$scenario" in
  # Continue when the scenario is recognized.
  workflow|budget-start|budget-active) ;;
  
  # Print the valid choices to standard error and exit for any other value.
  *) printf 'Choose workflow, budget-start, or budget-active.\n' >&2; exit 1 ;;
esac

# Run from the repository root, regardless of the caller's current directory.
cd "$(dirname "$0")/.."

# Keep each scenario's local Wrangler data in its own directory.
storage=".wrangler/stub-${scenario}"

# Apply the API's D1 migrations to the scenario's local database.
# The continuation line selects the API configuration and storage directory.
pnpm exec wrangler d1 migrations apply DB --local --env stub \
  --config apps/api/wrangler.jsonc --persist-to "$storage"

# Replace this shell with Wrangler, running both Workers locally in the stub environment.
# The continuation lines select both configurations, port 8787, shared storage,
# and the scenario binding used by the voice stub.
exec pnpm exec wrangler dev --local --env stub \
  --config apps/api/wrangler.jsonc --config apps/tools/wrangler.jsonc \
  --port 8787 --persist-to "$storage" \
  --var "VOICE_STUB_SCENARIO:${scenario}"
