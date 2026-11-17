# Hosted deployment

Terraform owns D1, queues, and Cloudflare Access. The committed Wrangler configurations own the three Workers, their
bindings, schedules, and application bundles. Releases run locally with Wrangler.

## Prerequisites

Install Bash, Terraform 1.12 or newer, and the repository's Node and pnpm versions. Run
`pnpm install --frozen-lockfile`. Complete Cloudflare Zero Trust onboarding and obtain the team's `cloudflareaccess.com`
hostname.

Terraform reads `CLOUDFLARE_API_TOKEN` from the shell. Wrangler can use the same token or an operator's `wrangler login`
session. Scope the Terraform token to this account with D1, Queues, and Access Applications/Policies/Identity Providers
edit permissions. Wrangler needs Workers deployment permissions, D1 permissions for migrations and role updates, and
Worker route permissions for custom domains. Keep credentials outside committed files and Terraform inputs.

## Infrastructure setup

Copy `infrastructure/terraform.tfvars.example` to `infrastructure/terraform.tfvars`. Set the account, public origin,
Access team domain, and administrator/reviewer emails.

The resource names are fixed: `voice-freight-hosted`, `voice-freight-analysis`, and
`voice-freight-analysis-dead-letter`. Workers are named `voice-freight-api`, `voice-freight-tools`, and
`voice-freight-app`. A separate installation requires updating the committed names and settings.

```sh
terraform -chdir=infrastructure init
terraform -chdir=infrastructure fmt -check
terraform -chdir=infrastructure validate
terraform -chdir=infrastructure test
terraform -chdir=infrastructure plan -out=hosting.tfplan
terraform -chdir=infrastructure apply hosting.tfplan
terraform -chdir=infrastructure output -json hosting
```

Keep the provider lockfile committed. Local state, variable files, and plans are ignored. Back up state securely: it
includes user emails and resource IDs. Before sharing infrastructure operations, configure a remote backend with locking
and migrate state using `terraform init -migrate-state`. Use one state for these resources.

D1 and queues retain destruction protection. Review every plan; changing names must not replace existing resources
without a deliberate migration.

## Configure Wrangler once

Hosted is the default top-level environment. The `local` environment retains its development settings and tests supply
their own stub providers. The checkout contains placeholders because no hosted account is configured.

Copy these values from Terraform's `hosting` output:

- Set `account_id` in `apps/api/wrangler.jsonc`, `apps/tools/wrangler.jsonc`, `apps/web/deploy/wrangler.jsonc`, and
  `apps/tools/bootstrap/wrangler.jsonc` to `accountId`.
- Set the top-level D1 `database_id` and `database_name` in API and Tools to `databaseId` and `databaseName`. Leave
  local database IDs alone.
- Set API and App `PUBLIC_ORIGIN` to `origin`. Set API `ACCESS_ISSUER` to `issuer` and `ACCESS_AUDIENCE` to `audience`.

For `workers.dev`, use `https://voice-freight-app.YOUR-SUBDOMAIN.workers.dev` as the origin. Keep the App's
`workers_dev: true`. For a custom domain in this Cloudflare account, set `workers_dev: false` and add an App route:

```jsonc
"routes": [{ "pattern": "freight.example.com", "custom_domain": true }]
```

Commit these non-secret settings. Future deployments read these files directly and do not invoke Terraform or generate
configuration. If a resource is replaced or its domain changes, update the affected settings manually. Keep API and
Tools private with `workers_dev: false` and `preview_urls: false`.

## First release

API and Tools call named entrypoints on each other. For a fresh installation only, deploy the private Tools placeholder
so API's binding can resolve:

```sh
pnpm exec wrangler deploy --env="" \
  --config apps/tools/bootstrap/wrangler.jsonc
```

Never run that command over an established Tools Worker: it replaces its code with an unavailable placeholder. Existing
installations skip this step. Routine releases never deploy the placeholder.

Provision the hosted provider key separately through Wrangler's hidden prompt:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY --env="" \
  --config apps/api/wrangler.jsonc
```

On a fresh account, allow Wrangler to create the API Worker if prompted. Use the same command to rotate the key.
Deployment does not copy local development credentials.

```sh
pnpm deploy
pnpm deploy:roles
```

The release applies pending D1 migrations before publishing API, Tools, and App. Synchronizing roles afterward enables
invited users to use the app.

## Routine releases and roles

`pnpm deploy` and `pnpm deploy:hosted` run the same release workflow in `scripts/deploy.sh`. It generates local
Cloudflare types, validates types and code, runs integration tests, builds Workers, App, and Storybook, and runs browser
tests. Only after these succeed does it apply remote D1 migrations and deploy API, Tools, then App with the committed
configurations.

Wrangler bundles the current source during deployment. Keep the checkout stable while releasing; this workflow does not
freeze local release copies. Terraform, role synchronization, and secret rotation are separate operations.

After changing administrator/reviewer lists, review and apply Terraform, then synchronize D1 explicitly:

```sh
pnpm deploy:roles
# Equivalent command with structured output:
pnpm --silent cli hosted roles sync --json
```

Synchronization reads applied Terraform state and checks its account, database ID, and database name against the
committed API configuration. It upserts configured Access users and roles, removes Access users no longer listed,
preserves local identities and business data, and increments the database revision. Temporary role SQL is removed after
execution.

User lists stay outside shared schema migrations. Access controls who can reach `/api`; API verifies Access JWTs and the
application roles in D1. Public sample pages remain accessible.

## Adopt an existing installation

Import existing resources before applying Terraform. Do not recreate the database or queues. Reuse the existing account,
origin, resource names, and Access application. If names differ from this checkout, update Terraform and Wrangler
consistently before planning.

```sh
terraform -chdir=infrastructure init
terraform -chdir=infrastructure import \
  cloudflare_d1_database.hosting ACCOUNT_ID/DATABASE_ID
terraform -chdir=infrastructure import \
  'cloudflare_queue.analysis["analysis"]' ACCOUNT_ID/QUEUE_ID
terraform -chdir=infrastructure import \
  'cloudflare_queue.analysis["analysis-dead-letter"]' ACCOUNT_ID/DEAD_LETTER_ID
terraform -chdir=infrastructure import \
  cloudflare_zero_trust_access_application.api accounts/ACCOUNT_ID/APP_ID
terraform -chdir=infrastructure plan -out=hosting.tfplan
```

Set `identity_provider_id` to reuse an existing organization identity provider. Review the complete Access policy list
before applying. Existing Workers and secrets remain under Wrangler ownership.

When migrating from generated configuration, copy existing hosted values into the committed Wrangler files first.
Preserve Worker names, Durable Object migration tags, and the D1 migration history. Skip the Tools placeholder for
existing installations. Old `.local/wrangler`, `.local/releases`, and `.local/deployment.json` files are no longer used;
archive any release records you still need.

## Verification and recovery

After releasing, verify public pages, Access login and rejected users, authenticated `/api/health`, and a short call
through saved transcript and completed analysis. Local browser tests do not replace this hosted check. Monitor Worker
errors, queue backlog/dead letters, and provider spending.

Cloudflare records Worker versions and deployments. Inspect them and roll back each affected Worker using its committed
configuration:

```sh
pnpm exec wrangler versions list --env="" --config apps/api/wrangler.jsonc
pnpm exec wrangler deployments list --env="" --config apps/api/wrangler.jsonc
pnpm exec wrangler rollback VERSION_ID --env="" --config apps/api/wrangler.jsonc
```

Use the corresponding Tools or App configuration for those Workers. Deployments are sequential: failures can leave newer
migrations or a subset of newer Workers. Keep schema, RPC, queue payload, and Durable Object state changes compatible
with the preceding release. Inspect the failed step before retrying.

Worker rollback does not restore D1 data. Record a D1 Time Travel bookmark before schema changes and rehearse
restoration. Durable Object lifecycle migrations require their own recovery plan.
