// Validation harness (manual, networked): for each read endpoint, resolve the
// @medusajs/types-derived schema and diff it against the LIVE 2.15.5 response,
// so we can quantify residual types-vs-runtime drift before wiring types-source
// into the pipeline. Not part of the offline build.
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTypesExtractor } from "./extract.js";
import { responseTypeFor } from "./endpoint-types.js";
import { compareResponse } from "../compare/compare.js";
import { GLOBAL_IGNORE_FIELDS } from "../ignore-fields.js";
import type { GoldenResponse, SchemaNode } from "../types.js";

// Mirror buildGolden's applyIgnorePolicy so the harness compares what the real
// pipeline would emit (global-ignore fields -> "ignored" at any depth).
const IGNORE = new Set<string>(GLOBAL_IGNORE_FIELDS);
function applyIgnore(node: SchemaNode): SchemaNode {
  if (typeof node !== "object") return node;
  const out: { [k: string]: SchemaNode } = {};
  for (const [k, v] of Object.entries(node)) out[k] = IGNORE.has(k) ? "ignored" : applyIgnore(v);
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
const BACKEND = resolvePath(REPO_ROOT, "apps", "medusa", "apps", "backend");
const BASE = process.env.MEDUSA_BACKEND_URL || "http://localhost:9000";
const PK = process.env.MEDUSA_PUBLISHABLE_API_KEY || "";

const READS: Array<{ method: string; path: string; url: string; admin?: boolean }> = [
  { method: "GET", path: "/store/products", url: "/store/products?limit=2" },
  { method: "GET", path: "/store/products/{id}", url: "__pdp__" },
  { method: "GET", path: "/store/regions", url: "/store/regions" },
  { method: "GET", path: "/store/product-categories", url: "/store/product-categories" },
  { method: "GET", path: "/store/payment-providers", url: "__pp__" },
  { method: "GET", path: "/admin/orders", url: "/admin/orders?limit=2", admin: true },
  { method: "GET", path: "/admin/products", url: "/admin/products?limit=2", admin: true },
  { method: "GET", path: "/admin/customers", url: "/admin/customers?limit=2", admin: true },
  { method: "GET", path: "/admin/stock-locations", url: "/admin/stock-locations", admin: true },
];

async function adminToken(): Promise<string> {
  const r = await fetch(`${BASE}/auth/user/emailpass`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: process.env.MEDUSA_ADMIN_EMAIL,
      password: process.env.MEDUSA_ADMIN_PASSWORD,
    }),
  });
  if (!r.ok) throw new Error(`admin auth failed: ${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

function diffCount(typesSchema: SchemaNode, liveBody: unknown, endpoint: string) {
  const golden: GoldenResponse = {
    endpoint,
    expected_status: 200,
    expected_schema: typesSchema,
    ignore_fields: [],
    schema_source: "openapi",
    oas_operation_id: null,
    oas_ref: null,
    oas_version: null,
    value_rules: [],
    captured_at: "",
    source_sessions: [],
  };
  const res = compareResponse(golden, 200, liveBody);
  const miss = res.schemaDiff.filter((d) => d.kind === "missing_field");
  const unexp = res.schemaDiff.filter((d) => d.kind === "unexpected_field");
  const tc = res.schemaDiff.filter((d) => d.kind === "type_changed");
  return { miss, unexp, tc };
}

async function main() {
  const ex = createTypesExtractor(BACKEND);
  console.log(`@medusajs/types version: ${ex.version}\n`);
  const token = await adminToken().catch((e) => {
    console.log("(admin auth unavailable: " + e.message + ")");
    return null;
  });

  // Resolve a product id for the PDP / a payment-collection probe needs a cart; skip __pp__.
  const pdp = await fetch(`${BASE}/store/products?limit=1`, { headers: { "x-publishable-api-key": PK } });
  const pid = ((await pdp.json()) as any).products?.[0]?.id;

  for (const r of READS) {
    const typeName = responseTypeFor(r.method, r.path);
    if (!typeName) { console.log(`${r.path}: no type mapping`); continue; }
    const raw = ex.resolve(typeName);
    if (!raw) { console.log(`${r.path}: type ${typeName} not found`); continue; }
    const schema = applyIgnore(raw);
    let url = r.url;
    if (url === "__pdp__") url = `/store/products/${pid}`;
    if (url === "__pp__") { console.log(`${r.path.padEnd(34)} (skipped: needs cart context)`); continue; }
    if (r.admin && !token) { console.log(`${r.path.padEnd(34)} (skipped: no admin token)`); continue; }
    const headers: Record<string, string> = r.admin
      ? { authorization: `Bearer ${token}` }
      : { "x-publishable-api-key": PK };
    const resp = await fetch(`${BASE}${url}`, { headers });
    if (!resp.ok) { console.log(`${r.path.padEnd(34)} LIVE ${resp.status} (skipped)`); continue; }
    const body = await resp.json();
    const { miss, unexp, tc } = diffCount(schema, body, `${r.method} ${r.path}`);
    const flag = miss.length || tc.length ? "  <-- types over-asserts / mismatch" : unexp.length ? "  (live adds undocumented)" : "  OK";
    console.log(
      `${(`${r.method} ${r.path}`).padEnd(40)} type=${typeName.padEnd(34)} miss=${miss.length} unexp=${unexp.length} typeDiff=${tc.length}${flag}`
    );
    if (miss.length) console.log("    miss:", miss.map((d) => d.path).join(", "));
    if (tc.length) console.log("    typeDiff:", tc.map((d) => `${d.path}(${JSON.stringify(d.expected)}->${JSON.stringify(d.actual)})`).join(", "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
