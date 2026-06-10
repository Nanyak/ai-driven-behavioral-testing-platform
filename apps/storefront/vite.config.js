import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
var appRoot = dirname(fileURLToPath(import.meta.url));
var repoRoot = resolve(appRoot, "../..");
var env = loadEnv("", repoRoot, "");
var medusaBackendUrl = env.MEDUSA_BACKEND_URL || "http://localhost:9000";
var publishableApiKey = env.VITE_MEDUSA_PUBLISHABLE_API_KEY || env.MEDUSA_PUBLISHABLE_API_KEY || "";
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
                rewrite: function (path) { return path.replace(/^\/medusa/, ""); },
            },
        },
    },
});
