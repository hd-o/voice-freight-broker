import { registerHooks } from "node:module";

const parents = [
  new URL("../../src/evaluation.ts", import.meta.url).href,
  new URL("../../../../evals/evaluation.ts", import.meta.url).href,
];
const runtime = new URL("../../../../evals/runtime.ts", import.meta.url).href;

// Replace only the CLI's runtime setup and report destination. The evaluation
// runner, Promptfoo provider, Workers, and accounting all execute normally.
registerHooks({
  resolve(specifier, context, next): ReturnType<typeof next> {
    const resolution = next(specifier, context);

    if (parents.includes(context.parentURL ?? "") && resolution.url === runtime) {
      return { url: new URL("./runtime.ts", import.meta.url).href, shortCircuit: true };
    }

    return resolution;
  },
});
