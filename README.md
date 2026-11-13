# Voice Freight Broker

Browser-based voice freight brokerage simulation using synthetic carriers and
loads. The intended experience is a carrier sales conversation followed by an
inspectable dashboard record.

## Getting started

Open the repository in its devcontainer, or run the setup script:

```sh
bash scripts/setup.sh
```

Follow the script's instruction to load Vite+, then start the public app:

```sh
vp run dev:web
```


Run `vp run dev` to include the local API and Tools workers. For isolated UI
development, run `vp run storybook`; stories cover component and layout states,
light/dark themes, and phone/tablet/desktop viewports.

Use `vp run` without a task name to discover the other workspace tasks.

UI components use shadcn's `base-nova` preset with Base UI primitives.

Local development runs without Cloudflare or OpenAI credentials. The
[setup script](scripts/setup.sh) documents installation details; package
manifests and the lockfile own dependency versions.

## Development notes

The frontend is intended to remain a static export. Backend behavior belongs in
the Workers, with shared business logic kept outside the HTTP and RPC adapters.
Browser-safe contracts are separate from private backend code.

Static preview requires a build first and serves only the exported frontend. Use
the development server when working with the API proxy. Storybook has a separate
Vite configuration because its client renderer must not load vinext's
server-component plugins.

Run `vp run check`, `vp run build`, `vp run build:storybook`, `vp run test`, and
`vp run test:browser` for validation. Browser checks manage their own servers;
stop existing Storybook/static previews first. Checks cover static sample
browsing with the API unavailable, URL history, reporting denominators, keyboard
access, responsive behavior, and accessibility.

Public records live in `apps/web/data/calls.json`, validated by the browser-safe
contracts package. Shared reporting counts each matched ended call once,
excludes unresolved errors without a retained agreement, and uses only final
effective agreements for rate variance. Unknown sentiment stays separate; dates
show UTC.

See the [CI workflow](.github/workflows/checks.yml) for the validation sequence
and [AGENTS.md](AGENTS.md) for contributor conventions.

[prd]: https://chatgpt.com/space/page_4da0fc95119881919f400a7d37c9181c

## Architecture

The application supports local development and static frontend preview:

```mermaid
flowchart TD
  Browser["Browser"]
  Dev["vinext dev server"]
  App["App worker<br/>Static vinext export"]
  API["API worker<br/>Hono"]
  Tools["Tools worker<br/>WorkerEntrypoint"]
  DB[("Shared local D1")]

  Browser -->|Development| Dev
  Browser -->|Static preview| App
  Dev -->|/api proxy| API
  API -->|Service Binding RPC| Tools
  API -->|Drizzle| DB
  Tools -->|Drizzle| DB
```

API and Tools import the same backend package and Zod contracts. The RPC path
currently exercises the health probe; voice coordination, authentication, and
post-call processing are defined in the [PRD][prd] and remain to be implemented.
