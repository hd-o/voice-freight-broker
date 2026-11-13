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
    tailwindcss(),
  ],
  resolve: { alias: { "@": import.meta.dirname } },
  server: {
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
