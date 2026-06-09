import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  backendRoot,
  getPublishableApiKey,
  isTcpOpen,
  loadPhase1Env,
  parsePortFromUrl,
  queryPostgres,
  root,
} from "./lib/phase1-utils.mjs";

const env = loadPhase1Env();
const failures = [];
const notes = [];
const backendUrl = env.MEDUSA_BACKEND_URL || "http://localhost:9000";

function requireFile(relativePath) {
  if (!existsSync(join(root, relativePath))) {
    failures.push(`Missing required file: ${relativePath}`);
  }
}

function requireSnippet(relativePath, snippet) {
  const fullPath = join(root, relativePath);
  if (!existsSync(fullPath)) {
    failures.push(`Missing required file: ${relativePath}`);
    return;
  }

  const contents = readFileSync(fullPath, "utf8");
  if (!contents.includes(snippet)) {
    failures.push(`Missing '${snippet}' in ${relativePath}`);
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(new URL(path, backendUrl), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  return { response, body };
}

requireFile("apps/medusa/package.json");
requireFile("apps/medusa/apps/backend/package.json");
requireFile("apps/medusa/apps/backend/src/migration-scripts/initial-data-seed.ts");
requireFile("docs/phase-1-implementation-plan.md");
requireSnippet("apps/medusa/apps/backend/medusa-config.ts", "databaseUrl: process.env.DATABASE_URL");
requireSnippet("apps/medusa/apps/backend/medusa-config.ts", "redisUrl: process.env.REDIS_URL");
requireSnippet("package.json", "\"medusa:setup\"");
requireSnippet("package.json", "\"check:phase1\"");

if (!env.DATABASE_URL) {
  failures.push("DATABASE_URL is not configured.");
}

if (!env.REDIS_URL) {
  failures.push("REDIS_URL is not configured.");
}

const redisPort = parsePortFromUrl(env.REDIS_URL || "redis://localhost:6379", 6379);
if (!(await isTcpOpen("localhost", redisPort))) {
  failures.push(`Redis is not reachable on localhost:${redisPort}.`);
}

try {
  const productCount = await queryPostgres("select count(*)::int as count from product");
  const regionCount = await queryPostgres("select count(*)::int as count from region");
  const shippingCount = await queryPostgres("select count(*)::int as count from shipping_option");
  const apiKeyCount = await queryPostgres(`
    select count(*)::int as count
    from api_key
    where type = 'publishable'
      and revoked_at is null
      and deleted_at is null
  `);

  if (productCount.rows[0].count < 1) {
    failures.push("No seeded products found in PostgreSQL.");
  }
  if (regionCount.rows[0].count < 1) {
    failures.push("No seeded regions found in PostgreSQL.");
  }
  if (shippingCount.rows[0].count < 1) {
    failures.push("No shipping options found in PostgreSQL.");
  }
  if (apiKeyCount.rows[0].count < 1) {
    failures.push("No publishable API key found in PostgreSQL.");
  }
} catch (error) {
  failures.push(`PostgreSQL verification failed: ${error.message}`);
}

if (!(await isTcpOpen("localhost", Number(new URL(backendUrl).port || 9000)))) {
  failures.push(`Medusa is not reachable at ${backendUrl}. Start it with npm run medusa:dev.`);
} else {
  try {
    const health = await fetch(new URL("/health", backendUrl));
    if (!health.ok) {
      notes.push(`/health returned ${health.status}; continuing with API checks.`);
    }
  } catch (error) {
    notes.push(`/health check could not be read: ${error.message}`);
  }

  try {
    const publishableApiKey =
      env.MEDUSA_PUBLISHABLE_API_KEY || (await getPublishableApiKey());

    if (!publishableApiKey) {
      failures.push("Could not retrieve a publishable API key for Store API verification.");
    } else {
      const { response, body } = await fetchJson("/store/products", {
        headers: {
          "x-publishable-api-key": publishableApiKey,
        },
      });

      if (!response.ok) {
        failures.push(`GET /store/products failed with status ${response.status}.`);
      } else if (!Array.isArray(body.products) || body.products.length < 1) {
        failures.push("GET /store/products returned no products.");
      }
    }
  } catch (error) {
    failures.push(`Store API verification failed: ${error.message}`);
  }

  try {
    const auth = await fetchJson("/auth/user/emailpass", {
      method: "POST",
      body: JSON.stringify({
        email: env.MEDUSA_ADMIN_EMAIL || "admin@example.com",
        password: env.MEDUSA_ADMIN_PASSWORD || "change-me",
      }),
    });

    const token = auth.body.token;
    if (!auth.response.ok || !token) {
      failures.push(`Admin authentication failed with status ${auth.response.status}.`);
    } else {
      const adminProducts = await fetchJson("/admin/products", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!adminProducts.response.ok) {
        failures.push(
          `GET /admin/products failed with status ${adminProducts.response.status}.`
        );
      }
    }
  } catch (error) {
    failures.push(`Admin API verification failed: ${error.message}`);
  }
}

for (const note of notes) {
  console.log(`Note: ${note}`);
}

if (failures.length > 0) {
  console.error("Phase 1 verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Phase 1 verification passed.");
