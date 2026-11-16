import type { ApiProvider, CallApiContextParams, ProviderResponse } from "promptfoo";
import { scenarios } from "./cases.ts";
import { confirmationFixtures } from "../packages/backend/src/confirmation-fixtures.ts";
import { runScenario, runConfirmation, type SuiteResult, type EvaluationRuntime } from "./runtime.ts";

export default class FreightProvider implements ApiProvider {
  readonly #runtime: EvaluationRuntime;
  readonly results: SuiteResult[] = [];

  constructor(runtime: EvaluationRuntime) {
    this.#runtime = runtime;
  }

  readonly id = (): string => "freight-application-v1";

  async callApi(_prompt: string, context?: CallApiContextParams): Promise<ProviderResponse> {
    const scenario = scenarios.find((entry): boolean => entry.id === context?.vars.scenarioId);
    const fixture = confirmationFixtures.find((entry): boolean => entry.id === context?.vars.fixtureId);

    if (scenario && fixture) {
      return { error: "Unknown freight evaluation scenario." };
    }

    let result: SuiteResult;

    if (scenario) {
      result = await runScenario(this.#runtime, scenario);
    } else if (fixture) {
      result = await runConfirmation(this.#runtime, fixture.id);
    } else {
      return { error: "Unknown freight evaluation scenario." };
    }

    this.results.push(result);
    return {
      output: JSON.stringify(result, null, 2),
      cost: result.usage.reduce((total, entry): number => total + (entry.costMicrodollars ?? 0), 0) / 1_000_000,
    };
  }
}
