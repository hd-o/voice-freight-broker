import type { TestCase } from "promptfoo";
import { confirmationFixtures } from "../packages/backend/src/confirmation-fixtures.ts";
import { scenarios } from "./cases.ts";
import type { SuiteResult, ConfirmationResult } from "./runtime.ts";
import { scoreWorkflow, scoreSentiment, type Assessment } from "./scoring.ts";

export type EvaluationSuite = "all" | "workflows" | "confirmations";
export type EvaluationScore = {
  suite: Exclude<EvaluationSuite, "all">;
  id: string;
  result: SuiteResult;
  assertions: Record<string, Assessment>;
};

function scoreConfirmation(result: ConfirmationResult, metric: "Approval" | "Readback" | "Intent"): Assessment {
  const fixture = confirmationFixtures.find((entry): boolean => entry.id === result.fixtureId);

  if (!fixture) {
    throw new Error("Unknown confirmation fixture.");
  }

  const outcome = result.outcome;
  const expectedApproval = fixture.accuracy === "matches" && fixture.intent === "accept";
  const expected = metric === "Approval" ? expectedApproval : metric === "Readback" ? fixture.accuracy : fixture.intent;
  const actual =
    metric === "Approval"
      ? result.approval
      : metric === "Readback"
        ? outcome?.answers?.readback.choice
        : outcome?.answers?.intent.choice;
  const error =
    result.error ??
    (outcome?.status !== "evaluated"
      ? `Provider did not evaluate the confirmation (${outcome?.reason ?? "missing output"}).`
      : result.usage.length !== 1 || result.usage.some((entry): boolean => entry.unresolved)
        ? "Confirmation usage is missing or unresolved."
        : undefined);
  const pass = !error && actual === expected;
  const reason = error ?? `Expected ${metric}: ${expected}; observed ${actual ?? "unavailable"}.`;

  return { pass, score: pass ? 1 : 0, reason, failures: pass ? [] : [reason] };
}

export function scoreEvaluation(result: SuiteResult): EvaluationScore {
  if ("fixtureId" in result) {
    return {
      suite: "confirmations",
      id: result.fixtureId,
      result,
      assertions: {
        Approval: scoreConfirmation(result, "Approval"),
        Readback: scoreConfirmation(result, "Readback"),
        Intent: scoreConfirmation(result, "Intent"),
      },
    };
  }

  const scenario = scenarios.find((entry): boolean => entry.id === result.scenarioId);

  if (!scenario) {
    throw new Error("Unknown workflow scenario.");
  }

  return {
    suite: "workflows",
    id: scenario.id,
    result,
    assertions: { Workflow: scoreWorkflow(result, scenario), Sentiment: scoreSentiment(result, scenario) },
  };
}

export function createEvaluationTests(suite: EvaluationSuite, prefix = ""): TestCase[] {
  const workflows: TestCase[] =
    suite === "confirmations"
      ? []
      : scenarios
          .filter((scenario): boolean => scenario.id.startsWith(prefix))
          .map((scenario) => ({
            description: scenario.name,
            vars: {
              suite: "workflows",
              caseId: scenario.id,
              scenarioId: scenario.id,
              sentiment: scenario.sentiment,
              expectedAgreements: JSON.stringify(scenario.agreements),
              expectedOutcome: scenario.outcome,
            },
            assert: createAssertions(["Workflow", "Sentiment"]),
          }));
  const confirmations: TestCase[] =
    suite === "workflows"
      ? []
      : confirmationFixtures
          .filter((fixture): boolean => fixture.id.startsWith(prefix))
          .map((fixture) => ({
            description: `Confirmation: ${fixture.id}`,
            vars: {
              suite: "confirmations",
              caseId: fixture.id,
              fixtureId: fixture.id,
              split: fixture.split,
              expectedReadback: fixture.accuracy,
              expectedIntent: fixture.intent,
              expectedApproval: fixture.accuracy === "matches" && fixture.intent === "accept",
            },
            assert: createAssertions(["Approval", "Readback", "Intent"]),
          }));

  return [...workflows, ...confirmations];
}

function createAssertions(metrics: string[]): NonNullable<TestCase["assert"]> {
  return metrics.map((metric) => ({
    type: "javascript",
    metric,
    value: (output: string): Assessment => scoreEvaluation(JSON.parse(output) as SuiteResult).assertions[metric],
  }));
}
