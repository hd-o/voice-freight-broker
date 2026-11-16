#!/usr/bin/env bash
# Stop on failed commands, unset variables, or failures within pipelines.
set -euo pipefail

# Use the first argument as the stub scenario, or default to workflow.
scenario="${1:-workflow}"

# Accept only the supported stub scenarios.
case "$scenario" in
  # Continue when the scenario is recognized.
  workflow|budget-start|budget-active|analysis-failure|confirmation-failure|confirmation-change) ;;
  
  # Print the valid choices to standard error and exit for any other value.
  *) printf 'Choose workflow, budget-start, budget-active, analysis-failure, confirmation-failure, or confirmation-change.\n' >&2; exit 1 ;;
esac

# Run from the repository root, regardless of the caller's current directory.
cd "$(dirname "$0")/.."

# Keep each scenario's local Wrangler data in its own directory.
storage=".wrangler/stub-${scenario}"

# Apply the API's D1 migrations to the scenario's local database.
# The continuation line selects the API configuration and storage directory.
pnpm exec wrangler d1 migrations apply DB --local --env stub \
  --config apps/api/wrangler.jsonc --persist-to "$storage"

# Use the normal voice workflow while failing the first analysis generation.
voice_scenario="$scenario"
analysis_scenario="success"
confirmation_scenario="success"
if [[ "$scenario" == "analysis-failure" ]]; then
  voice_scenario="workflow"
  analysis_scenario="failure"
fi

# Exercise unavailable cancellation/replacement or conditional acceptance safely.
if [[ "$scenario" == "confirmation-failure" ]]; then
  confirmation_scenario="recovery"
elif [[ "$scenario" == "confirmation-change" ]]; then
  confirmation_scenario="request_change"
fi

# Replace this shell with Wrangler, running both Workers locally in the stub environment.
# The continuation lines select both configurations, port 8787, shared storage,
# and the scenario binding used by the voice stub.
exec pnpm exec wrangler dev --local --env stub \
  --config apps/api/wrangler.jsonc --config apps/tools/wrangler.jsonc \
  --port 8787 --persist-to "$storage" \
  --var "VOICE_STUB_SCENARIO:${voice_scenario}" \
  --var "ANALYSIS_STUB_SCENARIO:${analysis_scenario}" \
  --var "CONFIRMATION_STUB_SCENARIO:${confirmation_scenario}"
