// Run both evaluation suites through one Promptfoo provider and report.
import { evaluate } from "promptfoo";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import FreightProvider from "../evals/provider.ts";
import { suiteVersion } from "../evals/cases.ts";
import { bundleWorkers, EvaluationRuntime, readCredential, repositoryPath } from "../evals/runtime.ts";
import { createEvaluationTests, scoreEvaluation, type EvaluationSuite } from "../evals/suites.ts";

const { values, positionals } = parseArgs({
  options: { suite: { type: "string", default: "all" }, help: { type: "boolean", short: "h" } },
  allowPositionals: true,
});

if (values.help) {
  console.log(
    "Usage: pnpm run eval [--suite all|workflows|confirmations] [case-prefix]\nDefault: both suites. Paid usage shares the application's allowance.\nResults: Promptfoo viewer and evals/results/<run-id>/results.json",
  );
  process.exit(0);
}

if (!["all", "workflows", "confirmations"].includes(values.suite) || positionals.length > 1) {
  throw new Error("Use --suite all|workflows|confirmations and at most one case prefix.");
}

const suite = values.suite as EvaluationSuite;
const tests = createEvaluationTests(suite, positionals[0]);

if (!tests.length) {
  throw new Error("No evaluation case matches the supplied suite and prefix.");
}

const runtime = new EvaluationRuntime(await bundleWorkers(), await readCredential());
const provider = new FreightProvider(runtime);

try {
  await runtime.verifyLedger();
  const evaluation = await evaluate(
    {
      description: `${suiteVersion} — ${suite} suites`,
      prompts: ["{{suite}}: {{caseId}}"],
      providers: [provider],
      writeLatestResults: true,
      tests,
    },
    {
      maxConcurrency: 1,
      cache: false,
      repeat: 1,
      timeoutMs: 310000,
      maxEvalTimeMs: 3000000,
      progressCallback: (completed, total): void => console.log(`Evaluations: ${completed}/${total}`),
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
  const report = {
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
  const directory = resolve(repositoryPath, "evals/results", runtime.runId);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "results.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify(
      { ...report, results: results.map(({ suite, id, assertions }) => ({ suite, id, assertions })) },
      null,
      2,
    ),
  );
  console.log(`Full results: ${directory}/results.json`);

  if (report.errors || report.passed !== report.cases || report.unresolvedRequests) {
    process.exitCode = 1;
  }
} finally {
  await runtime.dispose();
}
