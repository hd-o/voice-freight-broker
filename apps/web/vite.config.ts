import { defineConfig } from "vite-plus";
import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    {
      name: "development-cache",
      configureServer(server) {
        // RSC responses bypass Vite's static response header configuration.
        server.middlewares.use((request, response, next) => {
          response.setHeader("Cache-Control", "no-store");

          // Vite serves CSS as a stylesheet or a JS module based on Accept.
          // Keep browser history from reusing one response for the other.
          if (/\.css(?:\?|$)/.test(request.url ?? "")) {
            response.appendHeader("Vary", "Accept");
          }

          next();
        });
      },
    },
    vinext(),
    {
      name: "vinext-build-diagnostics",
      apply: "build",
      enforce: "post",
      configEnvironment(name, config) {
        const output = config.build?.rolldownOptions?.output;
        for (const options of Array.isArray(output) ? output : [output]) {
          const splitting = options?.codeSplitting;
          if (!splitting || typeof splitting !== "object") continue;
          splitting.groups?.forEach((group, index) => {
            if (typeof group.name === "function" && !group.debugName)
              group.debugName = `${name}-chunk-group-${index}`;
          });
        }
      },
    },
    tailwindcss(),
  ],
  build: {
    rolldownOptions: {
      onLog(level, log, handler) {
        // vinext's generated RSC imports intentionally share static modules.
        if (
          level === "warn" &&
          log.code === "INEFFECTIVE_DYNAMIC_IMPORT" &&
          /is dynamically imported by \\0virtual:(?:vinext-rsc-entry|vite-rsc\/client-references) but also statically imported by /.test(
            log.message,
          )
        )
          return;
        handler(level, log);
      },
    },
  },
  resolve: { alias: { "@": import.meta.dirname } },
  server: {
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
