import { defineConfig } from "vite-plus";
import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vinext(), tailwindcss()],
  resolve: { alias: { "@": import.meta.dirname } },
  server: {
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
