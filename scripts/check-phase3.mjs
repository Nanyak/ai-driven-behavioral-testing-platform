import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./lib/phase1-utils.mjs";

const failures = [];

function requireFile(relativePath) {
  if (!existsSync(join(root, relativePath))) {
    failures.push(`Missing required file: ${relativePath}`);
  }
}

function requireSnippet(relativePath, snippet, description = snippet) {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath)) {
    failures.push(`Missing required file: ${relativePath}`);
    return;
  }

  const contents = readFileSync(fullPath, "utf8");
  if (!contents.includes(snippet)) {
    failures.push(`Missing ${description} in ${relativePath}`);
  }
}

requireFile("docs/phase-3-implementation-plan.md");
requireFile("apps/storefront/package.json");
requireFile("apps/storefront/index.html");
requireFile("apps/storefront/vite.config.ts");
requireFile("apps/storefront/src/main.tsx");
requireFile("apps/storefront/src/styles.css");
requireFile("apps/platform-dashboard/package.json");
requireFile("apps/platform-dashboard/index.html");
requireFile("apps/platform-dashboard/vite.config.ts");
requireFile("apps/platform-dashboard/src/main.tsx");
requireFile("apps/platform-dashboard/src/styles.css");

requireSnippet("package.json", "\"check:phase3\"", "root check:phase3 script");
requireSnippet("package.json", "\"storefront:dev\"", "root storefront dev script");
requireSnippet("package.json", "\"dashboard:dev\"", "root dashboard dev script");
requireSnippet("apps/storefront/package.json", "\"dev\": \"vite --host 0.0.0.0 --port 8000\"");
requireSnippet("apps/platform-dashboard/package.json", "\"dev\": \"vite --host 0.0.0.0 --port 5173\"");

requireSnippet("apps/storefront/vite.config.ts", "MEDUSA_BACKEND_URL", "Medusa base URL config");
requireSnippet(
  "apps/storefront/vite.config.ts",
  "MEDUSA_PUBLISHABLE_API_KEY",
  "Storefront publishable API key config"
);
requireSnippet("apps/storefront/vite.config.ts", "proxy", "Storefront Medusa proxy");
requireSnippet("apps/storefront/src/main.tsx", "/store/products", "Storefront product listing");
requireSnippet("apps/storefront/src/main.tsx", "/store/regions", "Storefront region lookup");
requireSnippet("apps/storefront/src/main.tsx", "/store/carts", "Storefront cart creation");
requireSnippet("apps/storefront/src/main.tsx", "/line-items", "Storefront cart line item add");
requireSnippet("apps/storefront/src/main.tsx", "Cart", "Storefront cart display");
requireSnippet("apps/storefront/src/main.tsx", "selectedProduct", "Storefront detail view");
requireSnippet("apps/storefront/src/main.tsx", "/auth/customer/emailpass/register", "Storefront customer registration");
requireSnippet("apps/storefront/src/main.tsx", "/auth/customer/emailpass", "Storefront customer login");
requireSnippet("apps/storefront/src/main.tsx", "/store/customers/me", "Storefront customer profile check");
requireSnippet("apps/storefront/src/main.tsx", "/store/shipping-options", "Storefront shipping option check");
requireSnippet("apps/storefront/src/main.tsx", "/store/payment-providers", "Storefront payment provider check");
requireSnippet("apps/storefront/src/main.tsx", "/store/payment-collections", "Storefront payment collection setup");
requireSnippet("apps/storefront/src/main.tsx", "/payment-sessions", "Storefront payment session setup");
requireSnippet("apps/storefront/src/main.tsx", "/complete", "Storefront checkout completion");
requireSnippet("apps/storefront/src/main.tsx", "Checkout", "Storefront checkout UI");

requireSnippet("apps/platform-dashboard/vite.config.ts", "MEDUSA_BACKEND_URL", "Dashboard Medusa base URL config");
requireSnippet("apps/platform-dashboard/src/main.tsx", "/health", "Dashboard health status");
requireSnippet("apps/platform-dashboard/src/main.tsx", "/store/products", "Dashboard Store API status");
requireSnippet("apps/platform-dashboard/src/main.tsx", "/auth/user/emailpass", "Dashboard Admin auth status");
requireSnippet("apps/platform-dashboard/src/main.tsx", "http://localhost:9000/app", "Medusa Admin link");
requireSnippet("apps/platform-dashboard/src/main.tsx", "http://localhost:8000", "Storefront link");
requireSnippet("apps/platform-dashboard/src/main.tsx", "Logs", "Logs placeholder");
requireSnippet("apps/platform-dashboard/src/main.tsx", "Traffic generation", "Traffic placeholder");
requireSnippet("apps/platform-dashboard/src/main.tsx", "Behavior flows", "Behavior flows placeholder");
requireSnippet("apps/platform-dashboard/src/main.tsx", "Generated tests", "Generated tests placeholder");
requireSnippet("apps/platform-dashboard/src/main.tsx", "Reports", "Reports placeholder");

if (failures.length > 0) {
  console.error("Phase 3 verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Phase 3 verification passed.");
