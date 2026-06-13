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
// The storefront checkout flow was refactored out of main.tsx into a Medusa
// service layer (services/medusa.ts), a shared context, and per-page UI under
// pages/ and components/. Point each capability check at the file that now
// owns it.
const storefrontApi = "apps/storefront/src/services/medusa.ts";
requireSnippet(storefrontApi, "/store/products", "Storefront product listing");
requireSnippet(storefrontApi, "/store/regions", "Storefront region lookup");
requireSnippet(storefrontApi, "/store/carts", "Storefront cart creation");
requireSnippet(storefrontApi, "/line-items", "Storefront cart line item add");
requireSnippet("apps/storefront/src/components/CartSummary.tsx", "Cart", "Storefront cart display");
requireSnippet("apps/storefront/src/components/ProductDetail.tsx", "ProductDetail", "Storefront detail view");
requireSnippet(storefrontApi, "/auth/customer/emailpass/register", "Storefront customer registration");
requireSnippet(storefrontApi, "/auth/customer/emailpass", "Storefront customer login");
requireSnippet(storefrontApi, "/store/customers/me", "Storefront customer profile check");
requireSnippet(storefrontApi, "/store/shipping-options", "Storefront shipping option check");
requireSnippet(storefrontApi, "/store/payment-providers", "Storefront payment provider check");
requireSnippet(storefrontApi, "/store/payment-collections", "Storefront payment collection setup");
requireSnippet(storefrontApi, "/payment-sessions", "Storefront payment session setup");
requireSnippet(storefrontApi, "/complete", "Storefront checkout completion");
requireSnippet("apps/storefront/src/pages/CartPage.tsx", "Checkout", "Storefront checkout UI");

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
