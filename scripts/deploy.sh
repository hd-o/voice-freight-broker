#!/usr/bin/env bash
# Release validated Worker bundles against Terraform-owned infrastructure.
# Configuration and SQL generation stay in the companion TypeScript helper.
set -euo pipefail

# Reject unsupported modes before reading state or invoking deployment tools.
mode="${1:-}"
case "$mode" in
  --help)
    printf 'pnpm deploy:hosted [--prepare | --roles]\n--prepare generates Wrangler configuration.\n--roles synchronizes hosted user roles.\n'
    exit 0
    ;;
  ''|--prepare|--roles) ;;
  *) printf 'Choose --prepare, --roles, or no option to deploy.\n' >&2; exit 1 ;;
esac
if [[ "$#" -gt 1 ]]; then
  printf 'Choose one deployment mode.\n' >&2
  exit 1
fi

# Resolve paths from the checkout, even when the caller uses another directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p .local/wrangler
terraform -chdir=infrastructure output -json hosting > .local/wrangler/hosting.json
node scripts/prepare-deployment.ts

# Preparation and role administration never run the release pipeline.
if [[ "$mode" == --prepare ]]; then
  printf 'Wrangler configurations ready in .local/wrangler.\n'
  exit 0
fi
if [[ "$mode" == --roles ]]; then
  pnpm exec wrangler d1 execute DB --remote --config .local/wrangler/api.json \
    --file .local/hosted-roles.sql
  exit 0
fi
: "${CLOUDFLARE_API_TOKEN:?Export CLOUDFLARE_API_TOKEN before deploying.}"

# Validate a stable source snapshot before creating any hosted changes.
digest="$(node scripts/prepare-deployment.ts --digest)"
pnpm typecheck
pnpm exec vp check --no-fmt
pnpm test
pnpm build
pnpm build:storybook
pnpm test:browser
if [[ "$digest" != "$(node scripts/prepare-deployment.ts --digest)" ]]; then
  printf 'Source changed during validation. Nothing has been deployed.\n' >&2
  exit 1
fi

# Freeze bundles, static assets, and migrations; publication never rebuilds them.
mkdir -p .local/releases
release="$PWD/$(mktemp -d .local/releases/XXXXXXXX)"
cp -R apps/api/dist "$release/api"
cp -R apps/tools/dist "$release/tools"
cp -R apps/web/dist/client "$release/assets"
cp -R packages/backend/migrations "$release/migrations"
pnpm exec esbuild apps/web/deploy/worker.ts --bundle --format=esm \
  --platform=browser --target=es2023 --outfile="$release/app/worker.js"
node scripts/prepare-deployment.ts --release "$release"
if [[ "$digest" != "$(node scripts/prepare-deployment.ts --digest)" ]]; then
  printf 'Source changed while freezing the release. Nothing has been deployed.\n' >&2
  exit 1
fi

# Inspect the account before migrations, and bootstrap Tools only when absent.
account="$(node -p 'require("./.local/wrangler/api.json").account_id')"
curl --fail --silent --show-error --max-time 30 \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts" > "$release/workers.json"
bootstrap="$(node scripts/prepare-deployment.ts --bootstrap "$release")"
pnpm exec wrangler d1 migrations apply DB --remote --config "$release/api.json"
if [[ "$bootstrap" == true ]]; then
  pnpm exec wrangler deploy --config .local/wrangler/bootstrap.json
fi

# Publish the provider entrypoints before Tools, then expose the app last.
for worker in api tools app; do
  pnpm exec wrangler deploy --no-bundle --config "$release/$worker.json"
done

# Record success only after all three Workers have been published.
cp "$release/deployment.json" .local/deployment.json
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$release/deployed-at"
printf 'Deployed release: %s\n' "$release"
