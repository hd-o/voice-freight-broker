# Hosted deployment

Terraform owns D1, queues, and Cloudflare Access. Wrangler owns the three Workers, their bindings, schedules, and
application bundles. Releases run from your machine; no GitHub deployment workflow is required.

## Prerequisites

Install Bash, curl, Terraform 1.12 or newer, and the repository's Node and pnpm versions. Install dependencies with
`pnpm install --frozen-lockfile`. Complete Cloudflare Zero Trust onboarding in the client account. Obtain the team's
`cloudflareaccess.com` hostname from that account.

Export `CLOUDFLARE_API_TOKEN` in your shell. Terraform reads it directly; Wrangler uses the same exported environment.
Use a token scoped to the client account with D1, Queues, Workers Scripts, and Access Applications/Policies/Identity
Providers edit permissions. Custom domains also require permission to configure Worker routes in the relevant zone. Keep
tokens out of Terraform variables, plans, and committed files.

## Infrastructure setup

```sh
cp infrastructure/terraform.tfvars.example infrastructure/terraform.tfvars
```

Edit the copied file with your account, actual public origin, team domain, and administrator/reviewer emails. For a
`workers.dev` origin, the hostname must match `<prefix>-app.<your-workers-subdomain>.workers.dev`. For a custom origin,
use a domain in the client Cloudflare account; Wrangler configures it as the App Worker's custom domain. Public samples
remain accessible; Access protects `/api`, and the API verifies Access JWTs and D1 roles.

The default prefix preserves the original hosted resource names. A distinct prefix creates a separate installation,
including Workers and queues. The database name is `<prefix>-hosted`. For separate environments, use separate Terraform
state and variable files; prepare and deploy from the state selected for that environment, one operation at a time.

```sh
terraform -chdir=infrastructure init
terraform -chdir=infrastructure fmt -check
terraform -chdir=infrastructure validate
terraform -chdir=infrastructure test
terraform -chdir=infrastructure plan -out=hosting.tfplan
terraform -chdir=infrastructure apply hosting.tfplan
pnpm deploy:prepare
```

The provider version and dependency lockfile are committed. Local state, variable files, plans, and generated Wrangler
configs are ignored. Back up state securely. Before sharing operations across engineers, configure a client-owned remote
backend with locking and migrate state using `terraform init -migrate-state`. Never create a second state for the same
resources. Protect state access: it includes user emails and resource IDs.

D1 and queues have destruction protection. Renaming them requires an explicit data migration and a reviewed
infrastructure change.

## Adopt the existing demo

Import resources before the first apply; do not recreate the database. Use the existing account, origin, and default
prefix. Find the database and queue IDs in Cloudflare, and the Access application ID in the dashboard or old
`.local/hosting.json`. Set `identity_provider_id` to the existing email-code provider ID so Terraform reuses it without
taking ownership of an organization-wide provider.

```sh
terraform -chdir=infrastructure init
terraform -chdir=infrastructure import cloudflare_d1_database.hosting ACCOUNT_ID/DATABASE_ID
terraform -chdir=infrastructure import 'cloudflare_queue.analysis["analysis"]' ACCOUNT_ID/QUEUE_ID
terraform -chdir=infrastructure import 'cloudflare_queue.analysis["analysis-dead-letter"]' ACCOUNT_ID/DEAD_LETTER_QUEUE_ID
terraform -chdir=infrastructure import cloudflare_zero_trust_access_application.api accounts/ACCOUNT_ID/APP_ID
terraform -chdir=infrastructure plan -out=hosting.tfplan
```

Review the imported Access policy carefully. Terraform owns the application's complete policy list; the plan must retain
the intended invited-user policy and must not replace D1 or queues. Apply only after reviewing the plan. Existing
Workers and their secrets stay under Wrangler ownership.

## Secrets and first release

`pnpm deploy:prepare` reads `terraform output -json hosting` and generates `.local/wrangler/{api,tools,app}.json`. It
does not apply infrastructure, change checked-in configuration, or read your local development API key.

Provision the hosted OpenAI key separately through Wrangler's hidden prompt:

```sh
pnpm exec wrangler secret put OPENAI_API_KEY --config .local/wrangler/api.json
```

On a fresh account, allow Wrangler to create the API Worker when prompted. The secret belongs to this environment; use
the same command to rotate it. Do not copy a developer credential into a client deployment automatically.

```sh
pnpm run deploy
pnpm deploy:roles
```

`scripts/deploy.sh` orchestrates the release; `prepare-deployment.ts` prepares structured configuration and role SQL.
The release validates types and code, runs API, CLI and local browser tests, and builds the app and Storybook. It checks
source digests, freezes bundles and migrations in `.local/releases`, applies remote migrations, then publishes API,
tools, and app with Wrangler. The first release creates a private Tools stub only if that Worker does not exist,
resolving the initial circular service-binding dependency.

`deploy:roles` is a separate administration operation after migrations. It upserts configured Access users and roles and
removes Access users absent from the Terraform output. It preserves local identities and call data. After changing
invite lists, apply Terraform and run `pnpm deploy:roles`. Routine code releases do not change roles or rotate runtime
secrets.

## Verification and recovery

After releasing, check public pages, Access login, the authenticated `/api/health` endpoint (API, tools, and database),
and a short call through saved transcript and completed analysis. Local browser tests do not replace this hosted check.
Confirm rejected users cannot reach the protected API. Monitor Worker errors, queue backlog/dead letters, and provider
spending.

Save `.local/deployment.json` and its release directory (including the `deployed-at` timestamp) with your release
records. Deployments are sequential, not atomic: a failure may leave newer migrations or some newer Workers. Inspect
Wrangler output before retrying. Keep schema, RPC, queue payload, and Durable Object state changes compatible with the
previous release.

Use `wrangler rollback VERSION_ID --config .local/wrangler/NAME.json` for each affected Worker with a compatible
previous version. Worker rollback does not restore D1 data. Record a D1 Time Travel bookmark before a schema change and
rehearse restoration in staging. Durable Object lifecycle migrations need a dedicated recovery plan; they can restrict
rollback.

See [Worker rollback][rollback] and [D1 recovery][recovery].

[rollback]: https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/
[recovery]: https://developers.cloudflare.com/d1/reference/time-travel/
