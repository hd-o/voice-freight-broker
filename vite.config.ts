import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: { typeAware: true, typeCheck: true },
    ignorePatterns: [
      "**/worker-configuration.d.ts",
      "**/.vinext/**",
      ".devcontainer/**",
      ".vscode/**",
    ],
  },
  fmt: {
    printWidth: 80,
    proseWrap: "always",
    ignorePatterns: [
      "**/worker-configuration.d.ts",
      "**/.vinext/**",
      ".devcontainer/**",
      ".vscode/**",
      "AGENTS.md",
    ],
  },
});
