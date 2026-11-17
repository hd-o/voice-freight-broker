import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next): ReturnType<typeof next> {
    if (["promptfoo", "miniflare", "esbuild"].includes(specifier) || specifier.endsWith("/evals/runtime.ts")) {
      throw new Error(`Unexpected evaluation dependency: ${specifier}`);
    }

    return next(specifier, context);
  },
});
