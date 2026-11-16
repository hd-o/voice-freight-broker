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

## Project

IMPORTANT: Keep this section concisely up-to-date

Local voice workflows and queued post-call analysis are implemented. Hosted
Access and release validation remain in development.

## Structure

This TypeScript monorepo uses pnpm workspaces and Vite+:

- `apps/web/`: React frontend using vinext and shadcn/ui
- `apps/api/`: Hono API worker and call Durable Object
- `apps/tools/`: private business RPC worker and analysis queue consumer
- `packages/backend/`: domain logic, Drizzle schema, and D1 migrations
- `packages/contracts/`: shared types and Zod contracts
- `packages/cli/`: local, read-only agent/admin CLI
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

```txt
cli calls                       Inspect locally stored calls.
cli calls transcript <call-id>  Fetch saved dialogue with timestamps and completion status.
cli db                          Inspect a local D1 database without changing it.
cli db schema [table]           List actual table, index, view, and trigger definitions.
cli db query [options] <sql>    Execute one read-only SELECT or CTE
```

Vite+ `vpr [command]` project commands:

```yaml
"build": Build the project.
"build:storybook": Build the web app's Storybook bundle.
"cf:types": Generate Cloudflare type definitions for the tools and API workers.
"check": Run workspace checks, type checks, and markdown linting.
"cli": Launch the local CLI entrypoint.
"db:check": Verify the local D1 database is reachable.
"db:generate": Generate the backend Drizzle schema migrations.
"db:migrate": Apply local D1 migrations to the development database.
"dev": Start the web and API development servers in parallel.
"dev:stub:workers": Start the stub worker environment for local development.
"dev:web": Start the web frontend in development mode.
"dev:workers": Start the API worker in development mode.
"eval:help": Show help for the evaluation tooling.
"format": Format the codebase.
"lint": Lint the codebase and fix auto-fixable issues.
"prepare": Prepare the workspace configuration without agent setup.
"preview": Preview the web app locally.
"storybook": Start the Storybook development server.
"test": Run the CLI, tools build, and API test suite.
"test:browser": Run the Playwright browser test suite.
"test:cli": Run the CLI test suite.
"typecheck": Run repository-wide TypeScript type checks.
"@voice-freight/api#build": Dry-run deploy the API worker.
"@voice-freight/api#build:test": Dry-run deploy the API worker for the local environment.
"@voice-freight/api#cf:types": Generate Cloudflare types for the API worker configuration.
"@voice-freight/api#dev": Start the API worker locally with local configuration.
"@voice-freight/api#test": Run the API package tests.
"@voice-freight/api#typecheck": Type-check the API package and test suite.
"@voice-freight/backend#db:generate": Generate backend database migrations.
"@voice-freight/backend#typecheck": Type-check the backend package.
"@voice-freight/cli#test": Run the CLI package tests.
"@voice-freight/cli#typecheck": Type-check the CLI package.
"@voice-freight/contracts#typecheck": Type-check the shared contracts package.
"@voice-freight/tools#build": Dry-run deploy the tools worker.
"@voice-freight/tools#build:test": Dry-run deploy the tools worker for the local environment.
"@voice-freight/tools#cf:types": Generate Cloudflare types for the tools worker.
"@voice-freight/tools#typecheck": Type-check the tools package.
"@voice-freight/web#build": Build the web app.
"@voice-freight/web#build:storybook": Build the web app's Storybook static site.
"@voice-freight/web#dev": Start the web app in development mode.
"@voice-freight/web#preview": Preview the web app with the deploy worker config.
"@voice-freight/web#storybook": Start the web app's Storybook server.
"@voice-freight/web#typecheck": Type-check the web app.
```
