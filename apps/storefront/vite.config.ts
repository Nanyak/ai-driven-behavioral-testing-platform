import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const env = loadEnv("", repoRoot, "");
const medusaBackendUrl = env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const publishableApiKey =
  env.VITE_MEDUSA_PUBLISHABLE_API_KEY || env.MEDUSA_PUBLISHABLE_API_KEY || "";

export default defineConfig({
  envDir: repoRoot,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(appRoot, "src"),
    },
  },
  define: {
    __MEDUSA_PUBLISHABLE_API_KEY__: JSON.stringify(publishableApiKey),
  },
  server: {
    port: 8000,
    strictPort: true,
    proxy: {
      "/medusa": {
        target: medusaBackendUrl,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/medusa/, ""),
      },
    },
  },
});
