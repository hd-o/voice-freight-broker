import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: ["**/worker-configuration.d.ts", "**/.vinext/**", ".devcontainer/**", ".vscode/**"],
    rules: {
      curly: "error",
      "typescript/explicit-function-return-type": "error",
    },
  },
  fmt: {
    printWidth: 120,
    proseWrap: "always",
    ignorePatterns: ["**/worker-configuration.d.ts", "**/.vinext/**", ".devcontainer/**", ".vscode/**", "AGENTS.md"],
  },
});
