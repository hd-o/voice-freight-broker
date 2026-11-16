import type { Scenario } from "./cases.ts";
import type { EvaluationResult } from "./runtime.ts";
import type { AnalysisInput } from "../packages/backend/src/analysis";

export type Assessment = { pass: boolean; score: number; reason: string; failures: string[] };

export function scoreWorkflow(result: EvaluationResult, scenario: Scenario): Assessment {
  const failures: string[] = [];
  const check = (condition: boolean, reason: string): void => {
    if (!condition) {
      failures.push(reason);
    }
  };

  check(!result.error, result.error ?? "Provider error");
  const agreements = result.state.agreements.map((entry): object => ({
    loadId: entry.load.id,
    rateCents: entry.rateCents,
    status: entry.status,
  }));
  const normalize = (entries: readonly object[]): string =>
    JSON.stringify(entries.map((entry): string => JSON.stringify(entry)).sort());
  check(
    normalize(agreements) === normalize(scenario.agreements),
    "Persisted agreement versions, statuses, loads, or rates differ from expectations.",
  );
  check(result.state.calls.length === Math.max(1, scenario.calls.length), "Scenario call count differs.");
  check(
    result.state.calls.every((entry): boolean => !!entry.finalSnapshot),
    "A call was not finalized.",
  );
  check(result.state.calls.at(-1)?.outcome === scenario.outcome, "Final authoritative outcome differs.");

  for (const name of scenario.requiredTools) {
    check(
      result.tools.some(
        (event): boolean =>
          event.name === name && !(event.result && typeof event.result === "object" && "error" in event.result),
      ),
      `Missing successful model-selected ${name}.`,
    );
  }

  if (scenario.calls.length) {
    check(
      result.state.calls.every((entry): boolean => entry.verification?.carrierId === "carrier-summit"),
      "First eligible carrier binding changed or is missing.",
    );
  }

  if (scenario.prices) {
    const pair = result.state.negotiations.find((entry): boolean => entry.loadId === "seed-v1-01");
    check(
      JSON.stringify(pair?.prices) === JSON.stringify(scenario.prices),
      "Distinct shared offered amounts or used rounds differ.",
    );

    if (scenario.rateCents !== undefined) {
      check(pair?.rateCents === scenario.rateCents, "Last shared broker rate differs.");
    }
  }

  for (const event of result.tools) {
    if (event.name === "end_call") {
      check(Object.keys(event.arguments).length === 0, "Call closure used invalid tool arguments.");
    }

    if (event.name === "evaluate_offer") {
      check(
        Number.isSafeInteger(event.arguments.amountCents) && Number(event.arguments.amountCents) > 0,
        "Offer arguments are not positive integer USD cents.",
      );
      check(
        result.state.quotes.some(
          (entry): boolean => entry.callId === event.callId && entry.id === event.arguments.quoteId,
        ),
        "Offer used an invented or foreign quote.",
      );
    }

    if (event.name === "confirm_handoff" || event.name === "cancel_agreement") {
      check(!("evidence" in event.arguments), "The model supplied evidence references instead of observed speech.");
    }
  }

  for (const agreement of result.state.agreements) {
    const evidence = result.state.evidence.filter((entry): boolean =>
      [agreement.evidence.readbackId, agreement.evidence.callerId].includes(entry.id),
    );
    check(
      evidence.length === 2 &&
        evidence.every((entry): boolean => !!entry.confirmationAttemptId && !!entry.transcriptIds?.length),
      "Agreement lacks saved confirmation evidence.",
    );
    check(
      evidence.every((entry): boolean =>
        entry.transcriptIds!.every((id): boolean =>
          result.state.fragments.some((fragment): boolean => fragment.id === id),
        ),
      ),
      "Agreement evidence cites an unsaved fragment.",
    );
  }

  if (scenario.id === "02-negotiation") {
    check(
      result.state.events.some(
        (entry): boolean => entry.decision === "repeated_price" && !entry.consumed && entry.amountCents === 240000,
      ),
      "Repeated offer did not exercise repeated-price handling.",
    );
    check(
      result.state.events.filter((entry): boolean => entry.consumed).length === 3,
      "Bargaining did not consume exactly three distinct prices.",
    );
    const counters = result.state.events
      .filter((entry): boolean => entry.decision === "broker_counter")
      .map(
        (entry): number | undefined =>
          result.state.quotes.find((quote): boolean => quote.id === entry.quoteId)?.rateCents,
      );
    check(
      JSON.stringify(counters) === JSON.stringify([210000, 215000]),
      "Concession formula returned unexpected rates.",
    );
  }

  if (scenario.id === "03-resumption") {
    const secondCall = result.state.calls[1]?.id;
    const resumed = result.tools.find((entry): boolean => entry.callId === secondCall && entry.name === "select_load")
      ?.result as { usedRounds?: number; rateCents?: number } | undefined;
    check(
      resumed?.usedRounds === 2 && resumed.rateCents === 215000,
      "Second call did not resume two used rounds and the saved quote.",
    );
  }

  if (scenario.id === "05-carrier-restrictions") {
    check(
      result.tools.some((entry): boolean => entry.name === "verify_carrier" && entry.arguments.mcNumber === "999999"),
      "Unknown MC correction was not exercised.",
    );
    check(
      result.state.quotes.every((entry): boolean => entry.carrierId === "carrier-summit"),
      "Carrier switch changed quote ownership.",
    );
  }

  if (scenario.id === "06-browsing") {
    check(
      !result.tools.some((entry): boolean => ["select_load", "confirm_handoff"].includes(entry.name)),
      "Browsing triggered selection or confirmation.",
    );
    check(
      result.tools.some(
        (entry): boolean =>
          entry.name === "search_loads" &&
          Array.isArray((entry.result as { loads?: unknown[] })?.loads) &&
          (entry.result as { loads: unknown[] }).loads.length === 0,
      ),
      "No-match search was not exercised.",
    );
  }

  if (scenario.id === "07-confirmation-recovery") {
    check(
      result.checkpoints.filter((entry): boolean => entry.turn < 5).every((entry): boolean => !entry.agreements.length),
      "An ambiguous reply or stale readback created an agreement.",
    );
    const confirmation = result.state.confirmations.find((entry): boolean => entry.status === "applied");
    const evidence = result.state.evidence.find(
      (entry): boolean => entry.confirmationAttemptId === confirmation?.id && entry.speaker === "broker",
    );
    check(evidence?.rateCents === 210000, "Fresh confirmation did not use the corrected quote.");
  }

  if (scenario.interruption) {
    check(
      result.state.calls[0]?.finalSnapshot?.connection === "Interrupted" &&
        !result.state.calls[0]?.finalSnapshot?.transcript.complete,
      "Interruption did not preserve an explicitly partial record.",
    );
    check(
      !result.tools.some((entry): boolean => entry.name === "end_call"),
      "The model closed a conversation scripted to be interrupted.",
    );
  } else if (scenario.calls.length) {
    check(
      result.state.calls.every((call): boolean =>
        result.tools.some((entry): boolean => entry.callId === call.id && entry.name === "end_call"),
      ),
      "Closing intent did not execute end_call.",
    );
  }

  check(
    result.state.analysis.length === Math.max(1, scenario.calls.length) &&
      result.state.analysis.every((entry): boolean => entry.status === "complete"),
    "Saved analysis did not complete for every call.",
  );

  for (const analysis of result.state.analysis) {
    const source = result.analyses.find((entry): boolean => entry.callId === analysis.callId)?.input as
      | AnalysisInput
      | undefined;
    const call = result.state.calls.find((entry): boolean => entry.id === analysis.callId);
    check(source?.call.outcome === call?.outcome, "Analysis input did not use the resolved authoritative outcome.");
    check(
      JSON.stringify(source?.call.agreements) === JSON.stringify(call?.finalSnapshot?.agreements),
      "Analysis input differs from immutable final agreement facts.",
    );
    const identifiers = new Set(source?.transcript.entries.map((entry): string => entry.id));
    check(
      !!source && !!analysis.evidenceIds?.length && analysis.evidenceIds.every((id): boolean => identifiers.has(id)),
      "Analysis evidence references are absent or not in its saved input.",
    );
    const summary = analysis.result?.summary ?? "";
    const contradiction =
      scenario.id === "09-conflicting-evidence" &&
      source?.call.agreements.length === 0 &&
      /\b(?:verified|authoritative|saved)\b[^.]{0,80}\b(?:no|zero)\b[^.]{0,40}\b(?:loads?|agreements?|bookings?)\b|\b(?:no|zero)\b[^.]{0,40}\b(?:loads?|agreements?|bookings?)\b[^.]{0,40}\bverified\b/i.test(
        summary,
      );
    const knownRates = new Set([
      ...(source?.call.agreements.map((entry): number => entry.rateCents) ?? []),
      ...(source?.call.loads.flatMap((entry): number[] => [
        entry.postedRateCents,
        ...entry.negotiation.map((item): number => item.rateCents),
      ]) ?? []),
    ]);
    const callerAmounts = new Set(
      source?.transcript.entries
        .filter((entry): boolean => entry.speaker === "carrier")
        .flatMap((entry): number[] =>
          [...entry.text.matchAll(/\$([\d,]+(?:\.\d{1,2})?)/g)].map((match): number =>
            Math.round(Number(match[1].replaceAll(",", "")) * 100),
          ),
        ),
    );
    for (const statement of summary.split(/(?<=[.!?])\s+/)) {
      const discrepancy =
        contradiction &&
        /\b(?:broker|transcript|speaker)\b[^.!?]{0,20}\b(?:claimed|claims|said|alleged)\b[^.!?]{0,80}(?:\bthree\b|\b3\b|\$9,?999\b)[^.!?]{0,30}\b(?:loads|agreements|bookings|booked)\b/i.test(
          statement,
        );
      const amounts = [...statement.matchAll(/\$([\d,]+(?:\.\d{1,2})?)/g)].map((match): number =>
        Math.round(Number(match[1].replaceAll(",", "")) * 100),
      );
      const offer =
        /\b(?:carrier|caller)\b[^.!?]{0,80}\b(?:offered|proposed|tried|requested|asked)\b/i.test(statement) &&
        !/\b(?:effective|agreement|agreed|confirmed|booked|saved)\b/i.test(statement);
      check(
        amounts.every(
          (amount): boolean =>
            knownRates.has(amount) || (discrepancy && amount === 999900) || (offer && callerAmounts.has(amount)),
        ),
        "Summary contains a monetary amount absent from verified facts.",
      );

      if (scenario.id === "09-conflicting-evidence") {
        check(
          discrepancy || !/9,?999|three (?:effective |confirmed )?(?:agreements|bookings|loads)/i.test(statement),
          "Summary asserted an unsupported booking claim without an authoritative contradiction.",
        );
      }
    }
  }

  check(
    result.usage.length > 0 &&
      result.usage.every((entry): boolean => !entry.unresolved && entry.costMicrodollars !== undefined),
    "A paid request has missing or unresolved usage.",
  );

  return {
    pass: !failures.length,
    score: failures.length ? 0 : 1,
    reason: failures.length
      ? failures.join(" ")
      : "Tool, state, rate, outcome, evidence, and accounting assertions passed.",
    failures,
  };
}

export function scoreSentiment(result: EvaluationResult, scenario: Scenario): Assessment {
  const sentiment = result.state.analysis.at(-1)?.result?.sentiment;
  const pass = sentiment === scenario.sentiment;
  const reason = `Expected ${scenario.sentiment}; observed ${sentiment ?? "unavailable"}.`;
  return { pass, score: pass ? 1 : 0, reason, failures: pass ? [] : [reason] };
}
