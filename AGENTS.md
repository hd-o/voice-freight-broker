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

Keep the following concisely up-to-date if they change.

This TypeScript monorepo uses pnpm workspaces and Vite+

- Commit messages follow Conventional Commits.
- Run `vpr --json | jq -c` for available commands.
- `apps/web/`: React frontend using vinext and shadcn/ui
- `apps/api/`: Hono API worker and call Durable Object
- `apps/tools/`: private business RPC worker
- `packages/backend/`: domain logic, Drizzle schema, and D1 migrations
- `packages/contracts/`: shared types and Zod contracts
- `tests/`: Playwright browser tests; Storybook is in web

### Testing

- Use `playwright-cli` for on-demand testing and debugging
- Use `playwright` and `vitest` for integration testing
- Avoid unit tests. Test public or exported interfaces
- Focus on high ROI cases. Avoid exhaustive coverage
