import { evaluate, type TestCase } from "promptfoo";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import FreightProvider from "./provider.ts";
import { suiteVersion } from "./cases.ts";
import { type EvaluationRuntime, repositoryPath } from "./runtime.ts";
import { scoreEvaluation, type EvaluationScore, type EvaluationSuite } from "./suites.ts";

type EvaluationSuiteReport = {
  cases: number;
  completed: number;
  passed: number;
  metrics: Record<string, { passes: number; total: number }>;
  falseApprovals?: number;
  conservativeRejections?: number;
};

export type EvaluationReport = {
  runId: string;
  evaluationId: string;
  suiteVersion: string;
  createdAt: string;
  cases: number;
  completed: number;
  passed: number;
  errors: number;
  suites: Record<string, EvaluationSuiteReport>;
  costMicrodollars: number;
  unresolvedRequests: number;
  requests: number;
  results: EvaluationScore[];
};

export async function runEvaluation(
  runtime: EvaluationRuntime,
  options: {
    suite: EvaluationSuite;
    tests: TestCase[];
    directory?: string;
    writeLatestResults?: boolean;
    progress?: (completed: number, total: number) => void;
  },
): Promise<{ report: EvaluationReport; path: string }> {
  const { suite, tests } = options;
  const provider = new FreightProvider(runtime);

  await runtime.verifyLedger();
  const evaluation = await evaluate(
    {
      description: `${suiteVersion} — ${suite} suites`,
      prompts: ["{{suite}}: {{caseId}}"],
      providers: [provider],
      writeLatestResults: options.writeLatestResults ?? true,
      tests,
    },
    {
      maxConcurrency: 1,
      cache: false,
      repeat: 1,
      timeoutMs: 310000,
      maxEvalTimeMs: 3000000,
      showProgressBar: false,
      progressCallback: options.progress,
    },
  );
  const results = provider.results.map(scoreEvaluation);
  const suites = Object.fromEntries(
    (["workflows", "confirmations"] as const).map((name) => {
      const entries = results.filter((entry): boolean => entry.suite === name);
      const metrics = [...new Set(entries.flatMap((entry): string[] => Object.keys(entry.assertions)))];

      return [
        name,
        {
          cases: tests.filter((test): boolean => test.vars?.suite === name).length,
          completed: entries.length,
          passed: entries.filter((entry): boolean =>
            Object.values(entry.assertions).every((score): boolean => score.pass),
          ).length,
          metrics: Object.fromEntries(
            metrics.map((metric) => [
              metric,
              {
                passes: entries.filter((entry): boolean => entry.assertions[metric].pass).length,
                total: entries.length,
              },
            ]),
          ),
          ...(name === "confirmations"
            ? {
                falseApprovals: entries.filter(
                  (entry): boolean =>
                    "fixtureId" in entry.result && entry.result.approval && !entry.assertions.Approval.pass,
                ).length,
                conservativeRejections: entries.filter(
                  (entry): boolean =>
                    "fixtureId" in entry.result &&
                    entry.result.outcome?.status === "evaluated" &&
                    !entry.result.approval &&
                    !entry.assertions.Approval.pass,
                ).length,
              }
            : {}),
        },
      ];
    }),
  );
  const report: EvaluationReport = {
    runId: runtime.runId,
    evaluationId: evaluation.id,
    suiteVersion,
    createdAt: new Date().toISOString(),
    cases: tests.length,
    completed: results.length,
    passed: results.filter((entry): boolean => Object.values(entry.assertions).every((score): boolean => score.pass))
      .length,
    errors:
      tests.length -
      results.length +
      results.filter(
        ({ result }): boolean =>
          !!result.error ||
          ("fixtureId" in result
            ? result.outcome?.status !== "evaluated"
            : result.state.analysis.some((analysis): boolean => analysis.status !== "complete")),
      ).length,
    suites,
    costMicrodollars: runtime.usage.reduce((total, entry): number => total + (entry.costMicrodollars ?? 0), 0),
    unresolvedRequests: runtime.usage.filter((entry): boolean => entry.unresolved).length,
    requests: runtime.usage.length,
    results,
  };
  const directory = options.directory ?? resolve(repositoryPath, "evals/results", runtime.runId);

  await mkdir(directory, { recursive: true });

  const path = resolve(directory, "results.json");

  await writeFile(path, JSON.stringify(report, null, 2) + "\n");

  return { report, path };
}
