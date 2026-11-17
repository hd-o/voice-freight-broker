# Instructions

This project is not live, it's still in development.

This project requires senior software engineering specialized in:

- Frontend Next.js Development
- Backend Cloudflare Development
- Pragmatic Software Architecture

## Naming

These rules are never optional and never overridden:

- **Classes / Types**: Nouns
- **Functions / Methods**: Verbs
- **Component Functions**: Nouns
- **Variables / Arguments**: Nouns
- **Files / Modules**: Nouns
- **Script Files**: Verbs

## Comments

- Names explain what, comments explain why
- Explain non-obvious decisions near the relevant code
- Avoid unnecessary documentation that merely repeat types
- Format comments as justified blocks instead of max line length

## Code

Separate an intermediate multiline statement from adjacent statements with a blank line.
A statement is intermediate when another statement comes before or after it in the same block.
Do not add blank lines between a statement and the opening or closing boundary of its enclosing
block. A block containing only one statement needs no padding.

## Project

IMPORTANT: Keep this section concisely up-to-date

Local voice workflows, Decisions confirmation, queued post-call analysis, and
text evaluations, and hosted Access are implemented. Terraform manages hosted
resources; committed Wrangler configurations drive local releases.
Hosted account settings still require initial configuration.
The CLI supports local inspection, quota resets, evaluations, and hosted role
synchronization.

## Structure

This TypeScript monorepo uses pnpm workspaces and Vite+:

- `apps/web/`: React frontend using vinext and shadcn/ui
- `apps/api/`: Hono API worker and call Durable Object
- `apps/tools/`: private business RPC worker and analysis queue consumer
- `packages/backend/`: domain logic, Drizzle schema, and D1 migrations
- `packages/contracts/`: shared types and Zod contracts
- `packages/cli/`: development and hosted administration CLI; inspection stays read-only
- `tests/`: Playwright browser tests; Storybook is in web

### Testing

- Use `playwright-cli` for on-demand testing and debugging
- Use `playwright` and `vitest` for integration testing
- Avoid unit tests. Test public or exported interfaces
- Focus on high ROI cases. Avoid exhaustive coverage

### Commands

Commit messages follow Conventional Commits.

Commander.js `pnpm --silent cli [command]` commands:

- This CLI is made for coding agents
- Where possible, run with `--json`
- Run with `--help` for command details
- `calls` and `db` inspect storage read-only without Workers or credentials
- `dev limits reset` requires local Workers and changes daily call quotas
- `eval` makes paid requests using the existing provider key and shared allowance
- `hosted roles sync` changes hosted roles using applied Terraform state
- `--database` and `--persist-to` belong to the `calls` and `db` command groups

```txt
cli calls                       Inspect locally stored calls.
cli calls transcript <call-id>  Fetch saved dialogue and completion status.
cli db                          Inspect a local D1 database without changing it.
cli db schema [table]           List table, index, view, and trigger definitions.
cli db query [options] <sql>     Execute one read-only SELECT or CTE.
cli dev limits reset            Reset daily call quotas through local Workers.
cli eval [case-prefix]           Run workflow and confirmation evaluations.
cli hosted roles sync           Synchronize hosted roles from Terraform state.
```

Vite+ `vpr [command]` project commands:

```yaml
"@voice-freight/api#build:test": Dry-run deploy the API worker for the local environment.
"@voice-freight/api#build": Dry-run deploy the API worker.
"@voice-freight/api#cf:types": Generate Cloudflare types for the API worker configuration.
"@voice-freight/api#dev": Start the API worker locally with local configuration.
"@voice-freight/api#test": Run the API package tests.
"@voice-freight/api#typecheck": Type-check the API package and test suite.
"@voice-freight/backend#db:generate": Generate backend database migrations.
"@voice-freight/backend#typecheck": Type-check the backend package.
"@voice-freight/cli#test": Run the CLI package tests.
"@voice-freight/cli#typecheck": Type-check the CLI package.
"@voice-freight/contracts#typecheck": Type-check the shared contracts package.
"@voice-freight/tools#build:test": Dry-run deploy the tools worker for the local environment.
"@voice-freight/tools#build": Dry-run deploy the tools worker.
"@voice-freight/tools#cf:types": Generate Cloudflare types for the tools worker.
"@voice-freight/tools#typecheck": Type-check the tools package.
"@voice-freight/web#build:storybook": Build the web app's Storybook static site.
"@voice-freight/web#build": Build the web app.
"@voice-freight/web#dev": Start the web app in development mode.
"@voice-freight/web#preview": Preview the web app with the deploy worker config.
"@voice-freight/web#storybook": Start the web app's Storybook server.
"@voice-freight/web#typecheck": Type-check the web app.
"build:storybook": Build the web app's Storybook bundle.
"build": Build the project.
"cf:types": Generate Cloudflare type definitions for the tools and API workers.
"check": Run workspace checks, type checks, and markdown linting.
"cli": Launch the local CLI entrypoint.
"db:generate": Generate the backend Drizzle schema migrations.
"db:migrate": Apply local D1 migrations to the development database.
"deploy": Validate and deploy Workers using committed Wrangler configuration.
"deploy:hosted": Run the same local release workflow as deploy.
"deploy:roles": Synchronize hosted application roles.
"dev:reset:limits": Reset local daily call quotas for all users.
"dev:web": Start the web frontend in development mode.
"dev:workers": Start the API worker in development mode.
"dev": Start the web and API development servers in parallel.
"eval:help": Show help for the evaluation tooling.
"eval:typecheck": Type-check the evaluation provider and workers.
"eval:view": Open the local Promptfoo results viewer.
"eval": Run workflow and confirmation suites through Promptfoo.
"format": Format the codebase.
"lint": Lint the codebase and fix auto-fixable issues.
"prepare": Prepare the workspace configuration without agent setup.
"preview": Preview the web app locally.
"storybook": Start the Storybook development server.
"test:browser": Run the Playwright browser test suite.
"test:cli": Run the CLI test suite.
"test:eval": Run free Cloudflare evaluation harness integration checks.
"test": Run CLI, tools build, and API tests.
"typecheck": Run repository-wide TypeScript type checks.
```
