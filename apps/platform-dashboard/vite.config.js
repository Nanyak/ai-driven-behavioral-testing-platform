import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
var appRoot = dirname(fileURLToPath(import.meta.url));
var repoRoot = resolve(appRoot, "../..");
var env = loadEnv("", repoRoot, "");
var medusaBackendUrl = env.MEDUSA_BACKEND_URL || "http://localhost:9000";
var publishableApiKey = env.VITE_MEDUSA_PUBLISHABLE_API_KEY || env.MEDUSA_PUBLISHABLE_API_KEY || "";
var adminEmail = env.VITE_MEDUSA_ADMIN_EMAIL || env.MEDUSA_ADMIN_EMAIL || "admin@example.com";
var adminPassword = env.VITE_MEDUSA_ADMIN_PASSWORD || env.MEDUSA_ADMIN_PASSWORD || "change-me";
export default defineConfig({
    envDir: repoRoot,
    plugins: [react()],
    define: {
        __MEDUSA_PUBLISHABLE_API_KEY__: JSON.stringify(publishableApiKey),
        __MEDUSA_ADMIN_EMAIL__: JSON.stringify(adminEmail),
        __MEDUSA_ADMIN_PASSWORD__: JSON.stringify(adminPassword),
    },
    server: {
        port: 5173,
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
