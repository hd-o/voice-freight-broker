# Production deployment

Terraform manages the application Workers, D1, queues, Access, bindings, schedules, and publication. Wrangler builds
local bundles and supports local development. Production changes run through Terraform.

## Prerequisites

Install Terraform 1.12 or newer, Bash, Node, and pnpm. Run `pnpm install --frozen-lockfile`. Enable R2, Workers, and
Zero Trust in the Cloudflare account before provisioning.

Put `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the ignored `.env` file or the shell environment. The token
needs D1, Workers, Queues, R2, Access Applications/Policies, and Identity Providers edit permissions. The CLI derives R2
S3 credentials in memory and passes them to Terraform. Do not commit credentials or supply them as Terraform variables.

Copy `infrastructure/terraform.tfvars.example` to `infrastructure/terraform.tfvars`. Set the public origin, Access team
domain, and administrator/reviewer emails. The account ID comes from the environment. For the first release and secret
rotation, provide `OPENAI_API_KEY` in the environment. Terraform state and plans do not contain this key.

## State bootstrap

The state bucket belongs to a separate Terraform root. Its state and the application state live under separate keys in
the private bucket. Application destruction never removes the bucket.

Start the bucket root locally using an ignored backend override:

```sh
cat > infrastructure/bootstrap/backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
TF_LOCAL_BACKEND=1 pnpm --silent cli deployed terraform -- \
  -chdir=infrastructure/bootstrap init
TF_LOCAL_BACKEND=1 pnpm --silent cli deployed terraform -- \
  -chdir=infrastructure/bootstrap apply
rm infrastructure/bootstrap/backend_override.tf
pnpm --silent cli deployed terraform -- \
  -chdir=infrastructure/bootstrap init -migrate-state
pnpm --silent cli deployed terraform -- -chdir=infrastructure init
```

The CLI supplies the R2 endpoint and state keys during initialization. If an existing application has local Terraform
state, back it up and initialize with `-migrate-state` instead. Never discard state while migrating.

R2 does not provide native S3 object versioning. Export protected, timestamped copies of both states before migration,
destructive changes, and recovery. Keep copies outside Git. Do not set retention locks on live state or lockfiles.

## First release

API and Tools reference named entrypoints on each other. A first installation therefore needs a private Tools
placeholder and API publication before the normal release. Bootstrap refuses to replace an established Tools Worker.

```sh
pnpm deploy:bootstrap
pnpm deploy
```

The release validates source, builds local bundles, and applies Terraform. Database migrations and role synchronization
run through Cloudflare's API before App becomes public. Secret values are supplied to the API from the process
environment, never through Terraform state. To rotate the key, change `secret_revision` in the Terraform inputs and
provide the new key.

## Routine releases and administration

`pnpm deploy` and `pnpm deploy:prod` run the same workflow. Update Terraform inputs for user changes; the apply
synchronizes Access and D1 roles. The standalone `pnpm deploy:roles` command also synchronizes roles from applied
Terraform output. It preserves local identities and business data.

Use the Terraform wrapper for other operations, for example:

```sh
pnpm --silent cli deployed terraform -- -chdir=infrastructure plan
pnpm --silent cli deployed terraform -- -chdir=infrastructure output -json
```

D1 and queues have `prevent_destroy`. Removing a complete resource block also removes its protection, so inspect every
plan. Worker removal deletes its Durable Object namespaces. Shared Access identity providers and the state bucket are
outside application teardown.

Scheduled triggers use the shell Terraform provider because Cloudflare does not clear schedules when their resources are
removed. Keep the CLI schedule helper available until scheduled-resource deletion is applied.

## Verification and recovery

After releasing, verify public pages, Access login and rejected users, authenticated `/api/health`, and a short call
through saved transcript and completed analysis. Monitor Worker errors, queue backlog, and provider spending.

Reapply a previously verified source and build with Terraform to restore Worker code. Worker rollback does not restore
D1 data or reverse migrations. Record a D1 Time Travel bookmark before schema changes and rehearse restoration.
