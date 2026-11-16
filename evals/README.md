# Text evaluations

Promptfoo runs 10 workflow cases and 33 confirmation fixtures through the real application prompts, tools, Decisions
classifier, and post-call analysis. Inputs are scripted text and timed transcript events; audio and GPT Live behavior
require separate voice testing.

## Run and review

Use `OPENAI_API_KEY` or the existing key in `apps/api/.dev.vars.local`. `test:eval` is free; `eval` makes paid requests.

```sh
vpr db:migrate
vpr test:eval
vpr eval
vpr eval:view
```

Open <http://localhost:15500> and choose `freight-evaluations-v1`. Both suites share the viewer and
`evals/results/<run-id>/results.json`. Results include inputs, tool calls, saved state, analysis, assertions, and usage
receipts. Caching and telemetry are disabled; results stay local.

Select a suite or case prefix:

```sh
vpr eval --suite workflows
vpr eval --suite confirmations
vpr eval 03
vpr eval --suite confirmations dallas-fragmented
```

## Cases and scoring

- [Workflow cases](cases.ts): booking, bargaining, resumption, cancellation, replacement, carrier restrictions,
  browsing, recovery, interruption, and conflicting or missing evidence. Fixtures use MC `123456`, `seed-v1`, and
  November 16, 2026. Cases have isolated databases; resumption shares state across two calls.
- [Confirmation fixtures](../packages/backend/src/confirmation-fixtures.ts): 29 frozen labels plus four recorded Live
  fragmentation regressions. Assertions measure **Approval**, **Readback**, and **Intent**.
- [Shared suites](suites.ts) and [workflow scoring](scoring.ts): assertions check tool behavior, saved facts, outcomes,
  evidence, sentiment, and usage. Expected labels never enter model requests. Any failed assertion makes the command
  fail; provider errors never count as correct rejections.

Prompts come from the application's [live configuration], [confirmation policy], and [analysis provider]. See
[measured results](results.md) for failures and limitations. The [recorded baseline](baseline.json) covers the earlier
ten-workflow run.

## Limits and accounting

Per case: 20 caller turns, 40 delegated requests, four tool continuations per turn, 2,048 output tokens per request, and
five minutes. A full run is bounded by 50 minutes, 320 paid requests, and $1 exposure. There are no automatic paid
reruns. Usage shares the application's existing D1 ledger and $25 monthly allowance. Unknown usage retains its
reservation; daily voice quotas are unaffected.

## Manual review

Check that agent responses follow caller intent and report only saved actions. Compare summaries, rates, and agreement
statuses with saved facts, and read cited evidence to verify support. Sentiment covers the whole call: satisfaction is
Positive, dissatisfaction Negative, routine exchanges Neutral, and missing caller evidence Unknown. Partial transcripts
must be identified. The checkpoint requires passing assertions and human quality review. User confirmation is required
before Phase 6.

[live configuration]: ../apps/api/src/live-configuration.ts
[confirmation policy]: ../packages/backend/src/confirmation-policy.ts
[analysis provider]: ../packages/backend/src/analysis-provider.ts
