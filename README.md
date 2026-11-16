# Voice Freight Broker

Browser-based freight brokerage simulation with voice calls using GPT Live

## Development

Build a devcontainer, or run the setup script:

```sh
bash scripts/setup.sh
```

Add your API keys to `apps/api/.dev.vars.local`.

Then apply migrations and start the dev servers:

```sh
vpr db:migrate
vpr dev
```

Open <http://localhost:3000>.

For evaluations, see [evals/README.md](evals/README.md).

## Architecture

```mermaid
flowchart TD
  Browser["Browser"]
  Dev["vinext dev server"]
  App["App worker<br/>Static vinext export"]
  API["API worker<br/>Hono"]
  Tools["Tools worker<br/>WorkerEntrypoint"]
  Call["Call Durable Object"]
  Live["GPT Live + Responses"]
  DB[("Shared local D1")]
  Queue["Analysis queue + dead-letter queue"]

  Browser -->|Development| Dev
  Browser -->|Static preview| App
  Dev -->|/api proxy| API
  API -->|Health check RPC| Tools
  API -->|Call lifecycle| Call
  Browser <-->|WebRTC audio and transcript | Live
  Call <-->|Sideband events and continuation| Live
  Call -->|Private business RPC| Tools
  Call -->|Transcripts and spending| DB
  API -->|Drizzle| DB
  Tools -->|Drizzle| DB
  Tools <-->|Analysis jobs| Queue
  Tools -->|Private analysis provider RPC| API
```
