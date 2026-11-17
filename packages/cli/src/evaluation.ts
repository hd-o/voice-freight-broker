import type { EvaluationSuite } from "../../../evals/suites.ts";
import { CommandError, serializeJson } from "./errors.ts";

export async function runEvaluations(options: {
  suite: EvaluationSuite;
  prefix?: string;
  json: boolean;
}): Promise<void> {
  // Promptfoo reads these settings at import time, including when called directly
  // through the CLI instead of the repository shortcut.
  process.env.PROMPTFOO_DISABLE_TELEMETRY = "1";
  process.env.PROMPTFOO_LOG_TO_STDERR = "true";

  try {
    const { createEvaluationTests } = await import("../../../evals/suites.ts");
    const tests = createEvaluationTests(options.suite, options.prefix);

    if (!tests.length) {
      throw new CommandError(
        "usage_invalid",
        "No evaluation case matches the supplied suite and prefix.",
        "Check the suite and case prefix with cli eval --help.",
        2,
      );
    }

    const { runEvaluation } = await import("../../../evals/evaluation.ts");
    const { bundleWorkers, EvaluationRuntime, readCredential } = await import("../../../evals/runtime.ts");
    const runtime = new EvaluationRuntime(await bundleWorkers(), await readCredential());

    try {
      const { report, path } = await runEvaluation(runtime, {
        suite: options.suite,
        tests,
        progress: (completed, total): void => {
          process.stderr.write(`Evaluations: ${completed}/${total}\n`);
        },
      });
      const summary = {
        ...report,
        path,
        results: report.results.map(({ suite, id, assertions }) => ({ suite, id, assertions })),
      };

      process.stdout.write(`${serializeJson(summary, options.json ? undefined : 2)}\n`);

      if (!options.json) {
        process.stdout.write(`Full results: ${path}\n`);
      }

      if (report.errors || report.passed !== report.cases || report.unresolvedRequests) {
        process.exitCode = 1;
      }
    } finally {
      await runtime.dispose();
    }
  } catch (error) {
    if (error instanceof CommandError) {
      throw error;
    }

    throw new CommandError(
      "evaluation_failed",
      error instanceof Error ? error.message : "Evaluation failed.",
      "Check local migrations, the provider credential, and the shared application allowance.",
    );
  }
}
