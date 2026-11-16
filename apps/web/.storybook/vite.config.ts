import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";
import tailwindcss from "@tailwindcss/vite";

// Keep Storybook's client renderer separate from vinext's RSC environments.
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "next/link": fileURLToPath(new URL("./link.tsx", import.meta.url)),
      "@": fileURLToPath(new URL("../", import.meta.url)),
    },
  },
});
