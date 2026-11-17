#!/usr/bin/env bash
# Validate and release the application through Terraform; Wrangler only bundles local artifacts.
set -euo pipefail

# Choose the one-time installation phase without accepting arbitrary release options.
bootstrap=false
if [[ "${1:-}" == --help && "$#" -eq 1 ]]; then
  printf 'pnpm deploy:prod | pnpm deploy:bootstrap\nValidate, build, and apply the application with Terraform.\n'
  exit 0
fi
if [[ "${1:-}" == --bootstrap && "$#" -eq 1 ]]; then
  bootstrap=true
elif [[ "$#" -ne 0 ]]; then
  printf 'Use pnpm deploy:prod or pnpm deploy:bootstrap without options.\n' >&2
  exit 1
fi

# Resolve every configuration from the checkout, regardless of the caller's directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."
unset CLOUDFLARE_ENV

# Refuse to replace a live or partially published Tools Worker with its placeholder.
if [[ "$bootstrap" == true ]]; then
  pnpm --silent cli deployed terraform -- -chdir=infrastructure show -json | node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const state = JSON.parse(input);
    const resources = state.values?.root_module?.resources ?? [];
    const tools = resources.find(resource => resource.type === "cloudflare_workers_script" && resource.name === "tools");
    const app = resources.find(resource => resource.type === "cloudflare_workers_script" && resource.name === "app");
    if (app || (tools && !String(tools.values.content_file ?? "").includes("/dist-bootstrap/"))) {
      process.stderr.write("Bootstrap cannot replace an established or partially released installation.\n");
      process.exit(1);
    }
  '
fi

# Check source and create the local application bundles before asking Terraform to apply.
pnpm cf:types
pnpm typecheck
pnpm exec vp check --no-fmt
pnpm build

# Package the gateway and initial placeholder as ESM for Terraform's Worker uploads.
pnpm exec esbuild apps/tools/bootstrap/worker.ts --bundle --format=esm --platform=neutral --external:cloudflare:* --external:node:* --outfile=apps/tools/dist-bootstrap/worker.js
pnpm exec esbuild apps/web/deploy/worker.ts --bundle --format=esm --platform=neutral --external:cloudflare:* --external:node:* --outfile=apps/web/dist-gateway/worker.js

# Terraform manages production resources, migrations, secrets, and publication ordering.
pnpm --silent cli deployed terraform -- -chdir=infrastructure apply -var="bootstrap=$bootstrap"
