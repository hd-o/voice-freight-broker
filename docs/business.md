# Local business engine

See the [README](../README.md#getting-started) for local setup and accounts.

## Local data

Migrations live in `packages/backend/migrations`. Both Workers persist local D1 data in `.wrangler/state`. Use
`vpr db:generate` to generate schema changes and inspect the SQL before applying it. Custom triggers and initial
revision data live in `0002_invariants.sql`.

Automated browser tests prepare fixtures through the local administrator-only `POST /api/local/seed` endpoint. Backend
integration tests call the same handler with a fixed clock. Seeding creates the local accounts and adds the `seed-v1`
inventory batch once. Restarts and repeated seeding preserve data.

Each restock adds 20 loads with new IDs and preserves inventory and history. Retrying the same operation ID adds
nothing. New calls include restocked loads; existing calls keep their original inventory list. Bookings and
cancellations affect availability across all calls immediately.

## Fixtures and units

[Carrier fixtures](../packages/backend/src/carriers.ts) provide these outcomes:

| MC     | Carrier          | Result                              |
| ------ | ---------------- | ----------------------------------- |
| 123456 | Summit Transport | Eligible                            |
| 234567 | Harbor Logistics | Eligible                            |
| 345678 | Prairie Trucking | Ineligible                          |
| 456789 | Cedar Transport  | Unavailable: missing evidence       |
| 567890 | Mesa Freight     | Unavailable: contradictory evidence |
| Other  | Unknown          | Not found                           |

Eligibility requires active property-carrier authority, permission to operate, and no out-of-service status. Explicit
disqualifying evidence makes a carrier ineligible; missing or contradictory evidence makes verification unavailable.
Results identify their fixture source and version; they do not verify real carriers or caller authority. The first
eligible carrier and its evidence are fixed for the call. Failed attempts allow MC corrections.

[Inventory fixtures](../packages/backend/src/inventory.ts) cover five US routes and three equipment types. Each batch
uses its creation time: pickups are 1–20 days later, with delivery one day after pickup. Repeated seeding preserves the
original dates.

Weight is pounds, distance is miles, dimensions are inches, and money is integer USD cents for freight rates. Provider
spending uses integer USD microdollars; all corresponding amount names include `Microdollars`, and price names also
include their denominator. Load details and posted rates are public; maximum rates stay private in the backend.

## Commands and negotiation

[REST routes](../apps/api/src/worker.ts) expose business commands through `POST /api/calls/:callId/tools/:name` with
`{ invocationId, arguments }`. The command names and argument schemas live in the
[business contracts](../packages/contracts/src/business.ts). [Tools RPC](../apps/tools/src/worker.ts) exposes the same
commands. REST resolves the user from the session; RPC receives trusted user and call context separately from tool
arguments. Agreement changes require their original call to remain active, including for administrators.

Each invocation saves its successful result or terminal business rejection. Retries with the same invocation ID and
arguments return that saved decision, even if inventory or verification later changes. A rejected command preserves
business state and saves only its failure receipt. Validation, authorization, and transient infrastructure failures do
not consume an invocation ID. A new attempt after a business rejection requires a new invocation ID and current
quote/confirmation evidence.

A quote belongs to one call, verified carrier, and load. Negotiated prices and rounds are shared per carrier/load pair
across users and calls. Three distinct offered prices exhaust bargaining; repeated prices use no rounds. On rounds one
and two, an above-limit offer moves the broker counter halfway from the current quote toward the private maximum,
rounded down to the cent. After bargaining is exhausted, a valid quote can still be accepted.

A new quote replaces that call's previous quote. A change to the shared negotiation also invalidates quotes in other
calls. Either change requires fresh confirmation.

## Confirmation and agreements

Confirmation commands require IDs of persisted broker read-back and caller events. The private `recordEvidence` RPC
method records them; it has no REST endpoint and is outside the model's tool catalog. Each event identifies its action,
target quote or agreement, transcript position, and whether the caller confirmed. The caller event must reference a
preceding matching read-back and confirm unambiguously. Browser and model tool arguments cannot create evidence.
Integration tests exercise this boundary through the exported recorder and RPC.

For live calls, the Durable Object records every provider transcript fragment and executes `executeObserved` through
Tools RPC. That path derives evidence inside the same transaction as the business command. Broker speech must name the
current carrier, load reference, and exact rate. Caller speech must follow without overlap and clearly affirm;
ambiguity, corrections, mismatched cents, and stale context require another read-back. New quotes establish a transcript
boundary so an earlier read-back cannot confirm a later quote. Transcripts have no completed-turn marker; interpretation
remains fallible. A short collection delay permits trailing fragments to arrive before confirmation is checked.

The browser cannot invoke the direct business or finalization REST adapters for provider-managed calls. It uses
authenticated SDP creation, status, audio-ready, and hang-up actions. The Durable Object resolves its trusted owner and
invokes the same business engine; model arguments cannot choose that owner.

Finalization freezes agreement facts immediately. Late transcript fragments update the retained transcript separately;
reporting combines it with the immutable final snapshot. Final usage settles a reservation only after known delegated
responses also have recorded usage. Missing usage, failed startup after a provider attempt, and unrecoverable
connections retain money for later reconciliation. Unconfirmed provider termination also retains concurrency capacity.
Recovery attempts to attach and close a known provider session are bounded; a missing provider ID cannot establish
termination.

Agreement commits claim inventory exclusively. Replacement supersedes the old version and inserts its replacement in one
batch while retaining the allocation. Cancellation releases inventory and retains agreement and evidence history.
Finalization freezes the call snapshot, invalidates quotes, and creates one pending analysis/outbox record.

## Local identity and persistence

Local accounts require both `ENVIRONMENT=local` and `AUTH_MODE=local`; the default hosted configuration rejects local
authentication. Local sessions use random server-stored IDs, eight-hour expiry, and HttpOnly, SameSite cookies. Private
responses forbid caching. Logout revokes the session; logout, account changes, and detected expiry clear private query
data.

Browser session changes hold one Web Lock across tabs until their requests and local updates finish. Account actions are
disabled while pending. An attempt in another tab waits for availability without queuing a sign-in; choose the account
again after the current change completes. Public samples remain usable.

Mutations require the API's own origin. Local mode also allows `http://localhost:3000` and `http://127.0.0.1:3000` for
the frontend proxy.

[Persistence](../packages/backend/src/repository.ts) reads a consistent snapshot and commits changes in a D1 batch. A
shared revision guard serializes writes across Workers; conflicts roll back the batch and retry a bounded number of
times. Database constraints protect carrier/load pairs, consumed prices, exclusive allocations, carrier binding, and
final snapshots. Reading the full snapshot keeps this demo simple; larger datasets would need narrower queries.

## Reporting

The dashboard combines bundled samples from `apps/web/data/calls.json` with authorized backend calls, newest first.
History and metrics use the same population. Samples remain available after logout or when private reporting is
unavailable; anonymous sample browsing makes no API requests until sign-in is requested.

The agreement rate counts each qualifying ended call once: calls with an effective agreement, or eligible matched calls
without an unresolved error. Rate variance uses only final effective agreements. Unknown sentiment stays separate, and
dates display in UTC. See the [reporting implementation](../packages/contracts/src/reporting.ts).
