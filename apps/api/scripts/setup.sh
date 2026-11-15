#!/usr/bin/env bash
# Stop on failed commands, unset variables, or failures within pipelines.
set -euo pipefail

# Create local wrangler env vars file
cp -n apps/api/scripts/assets/.dev.vars.example apps/api/.dev.vars.local
