import { MedusaClient } from "./client.js";
import { loadConfig, type TrafficConfig, type Floors } from "./config.js";
import { newSessionId, newCustomerEmail } from "./ids.js";
import { AdminSession, DEFAULT_PASSWORD, StoreSession, type StepResult } from "./actions.js";
import { RunState, type PoolAccount, type PoolOrder } from "./state.js";
import {
  SESSION_TYPES,
  STAGE_OF,
  weightedAllocation,
  splitIdentity,
  chance,
  type SessionType,
  type Identity,
} from "./sampling.js";
import { runGuestShop } from "./flows/guest.js";
import { runReturningFlow } from "./flows/returning.js";
import { runOrderStatusFlow, runProfileMgmtFlow } from "./flows/account.js";
import { runReturnFlow } from "./flows/returns.js";
import {
  runAdminFlow,
  runAdminFulfillFlow,
  runAdminRefundFlow,
  runAdminSupportFlow,
} from "./flows/admin.js";
import { runEdgeFlow } from "./flows/edge.js";
import { runCustomerCheckout } from "./personas/customer-llm.js";
import { LIGHT_NOISE } from "./noise.js";

interface SessionResult {
  type: SessionType | "signup";
  identity: Identity;
  sessionId: string;
  steps: StepResult[];
}

// Cross-role linkage tracking (plan §7). Single-threaded cooperative pool, so
// plain Set mutation needs no locking.
const returnedOrders = new Set<string>();
const refundedOrders = new Set<string>();

/** Per-type identity split for the leaves where identity isn't fixed by type (plan §4). */
const IDENTITY_SPLIT: Partial<Record<SessionType, Partial<Record<Identity, number>>>> = {
  bounce: { guest: 90, returning: 10 },
  browse: { guest: 90, returning: 10 },
  cartAbandon: { guest: 75, returning: 25 },
  checkoutAbandon: { guest: 75, returning: 25 },
};

function identityFor(type: SessionType): Identity {
  const split = IDENTITY_SPLIT[type];
  if (split) return splitIdentity(split);
  switch (type) {
    case "guestCheckout":
      return "guest";
    case "returningCheckout":
    case "orderStatus":
    case "profileMgmt":
    case "returns":
      return "returning";
    case "newCheckout":
      return "new";
    default:
      return "guest"; // admin / edge — identity is not a meaningful axis.
  }
}

// --- pool helpers ---

function synthAccount(): PoolAccount {
  return { email: newCustomerEmail(), password: DEFAULT_PASSWORD };
}

function drawOrSynth(state: RunState): PoolAccount {
  return state.drawAccount() ?? synthAccount();
}

function poolAccountFor(state: RunState, email: string): PoolAccount | undefined {
  return state.accountPool.find((a) => a.email === email);
}

/** A pooled order owned by a returning (pooled) account — for D1/E. */
function drawReturningOrder(state: RunState, returnableOnly: boolean): PoolOrder | undefined {
  const candidates = state.orderPool.filter(
    (o) =>
      (!returnableOnly || !o.returned) &&
      state.accountPool.some((a) => a.email === o.ownerEmail)
  );
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : undefined;
}

function poolOrder(state: RunState, s: StoreSession, ownerEmail: string, token?: string): void {
  if (!s.lastOrderId) return;
  state.addOrder({
    orderId: s.lastOrderId,
    ownerEmail,
    token,
    regionId: s.regionId,
    items: s.items.map((i) => ({ id: i.id, quantity: 1, variantId: i.variantId })),
  });
}

// --- dispatch: one session of the given type/identity ---

async function dispatch(
  type: SessionType,
  identity: Identity,
  client: MedusaClient,
  state: RunState,
  cfg: TrafficConfig
): Promise<StepResult[]> {
  const promo = state.validPromoCode;
  const returning = identity === "returning";

  switch (type) {
    case "bounce":
      return returning
        ? (await runReturningFlow(client, drawOrSynth(state), "bounce", promo)).steps
        : (await runGuestShop(client, "bounce", promo)).steps;

    case "browse":
      return returning
        ? (await runReturningFlow(client, drawOrSynth(state), "browse", promo)).steps
        : (await runGuestShop(client, "browse", promo)).steps;

    case "cartAbandon":
      return returning
        ? (await runReturningFlow(client, drawOrSynth(state), "cartAbandon", promo)).steps
        : (await runGuestShop(client, "cartAbandon", promo)).steps;

    case "checkoutAbandon":
      return returning
        ? (await runReturningFlow(client, drawOrSynth(state), "checkoutAbandon", promo)).steps
        : (await runGuestShop(client, "checkoutAbandon", promo)).steps;

    case "guestCheckout": {
      const s = await runGuestShop(client, "buy", promo);
      if (s.email) poolOrder(state, s, s.email, s.token);
      return s.steps;
    }

    case "returningCheckout": {
      const acct = drawOrSynth(state);
      const s = await runReturningFlow(client, acct, "buy", promo);
      poolOrder(state, s, acct.email, acct.token);
      return s.steps;
    }

    case "newCheckout": {
      // HOLDOUT — register→login→checkout, LLM-varied (personas/), never scripted.
      const { session } = await runCustomerCheckout(client, cfg);
      if (session.email) poolOrder(state, session, session.email, session.token);
      return session.steps;
    }

    case "profileMgmt":
      return (await runProfileMgmtFlow(client, drawOrSynth(state))).steps;

    case "adminCatalog":
      return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;

    case "edge":
      return runEdgeFlow(client);

    case "orderStatus": {
      const order = drawReturningOrder(state, false);
      if (!order) return (await runGuestShop(client, "browse", promo)).steps; // degrade
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      return (
        await runOrderStatusFlow(client, acct, order, cfg.eventProbs.reorderDuringStatus)
      ).steps;
    }

    case "returns": {
      const order = drawReturningOrder(state, true);
      if (!order) return (await runGuestShop(client, "browse", promo)).steps; // degrade
      const acct = poolAccountFor(state, order.ownerEmail) ?? synthAccount();
      const { session, returnId, filed } = await runReturnFlow(client, acct, order);
      if (filed) {
        state.addReturn({ orderId: order.orderId, returnId: returnId ?? "unknown", ownerEmail: order.ownerEmail });
        returnedOrders.add(order.orderId);
      }
      return session.steps;
    }

    case "adminFulfill": {
      const order = state.drawOrder();
      if (!order) {
        return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;
      }
      return (await runAdminFulfillFlow(client, cfg.adminEmail, cfg.adminPassword, order.orderId)).steps;
    }

    case "adminRefund": {
      const pending = state.drawReturn();
      const orderId = pending?.orderId ?? state.drawOrder()?.orderId;
      if (!orderId) {
        return (await runAdminFlow(client, cfg.adminEmail, cfg.adminPassword, LIGHT_NOISE)).steps;
      }
      const session = await runAdminRefundFlow(
        client,
        cfg.adminEmail,
        cfg.adminPassword,
        orderId,
        pending?.returnId && pending.returnId !== "unknown" ? pending.returnId : undefined
      );
      if (session.steps.some((s) => s.action === "admin_refund" && s.ok)) {
        refundedOrders.add(orderId);
      }
      return session.steps;
    }

    case "adminSupport": {
      const query = state.drawAccount()?.email ?? "behavior";
      return (await runAdminSupportFlow(client, cfg.adminEmail, cfg.adminPassword, query)).steps;
    }
  }
}

// --- staging ---

/** Bounded-concurrency task pool. */
async function runPool<T>(items: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await items[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}

/** Stage 0 — seed a valid promotion and the returning-customer account pool. */
async function stage0(cfg: TrafficConfig, state: RunState): Promise<SessionResult[]> {
  state.validPromoCode = cfg.validPromoCode;

  const adminClient = new MedusaClient(cfg, newSessionId("seed-admin"));
  const admin = new AdminSession(adminClient, cfg.adminEmail, cfg.adminPassword);
  const login = await admin.login();
  if (login.ok) {
    const promo = await admin.createPromotion(cfg.validPromoCode);
    if (promo.ok) {
      console.log(`  ✓ Seeded promotion ${cfg.validPromoCode} (deal-seeker conversions enabled)`);
    } else {
      console.warn(
        `  ! Promo seed returned ${promo.status} — deal-seeker conversions may not apply. ` +
          `VERIFY POST /admin/promotions shape against this Medusa build.`
      );
    }
  } else {
    console.warn(
      `  ! Admin login failed (${login.status}) — skipping promo seed; admin stages will 401.`
    );
  }

  // K signup-only sessions: register (+ maybe profile), NO checkout. Populates
  // the pool AND provides the register-without-checkout decoupling evidence.
  const seedTasks = Array.from({ length: cfg.accountPoolSize }, () => async (): Promise<SessionResult> => {
    const sessionId = newSessionId("signup");
    const client = new MedusaClient(cfg, sessionId);
    const s = new StoreSession(client);
    await s.register();
    if (chance(0.4)) await s.updateProfile();
    if (s.email && s.token) {
      state.addAccount({ email: s.email, password: DEFAULT_PASSWORD, token: s.token });
    }
    return { type: "signup", identity: "new", sessionId, steps: s.steps };
  });
  const seedResults = await runPool(seedTasks, cfg.concurrency);
  console.log(`  ✓ Stage 0: ${state.accountPool.length}/${cfg.accountPoolSize} accounts seeded.`);
  return seedResults;
}

/** Top up the count-controllable leaves to their floors (plan §7). */
function applyFloors(counts: Record<SessionType, number>, floors: Floors): void {
  counts.newCheckout = Math.max(counts.newCheckout, floors.holdout);
  counts.returningCheckout = Math.max(counts.returningCheckout, floors.returningCheckout);
  counts.guestCheckout = Math.max(counts.guestCheckout, floors.guestCheckout);
  counts.returns = Math.max(counts.returns, floors.returns);
  counts.adminRefund = Math.max(counts.adminRefund, floors.linkedRefunds);
}

interface Job {
  type: SessionType;
  identity: Identity;
}

async function runJobs(jobs: Job[], cfg: TrafficConfig, state: RunState): Promise<SessionResult[]> {
  const tasks = jobs.map((job) => async (): Promise<SessionResult> => {
    const sessionId = newSessionId(job.type);
    const client = new MedusaClient(cfg, sessionId);
    const steps = await dispatch(job.type, job.identity, client, state, cfg);
    return { type: job.type, identity: job.identity, sessionId, steps };
  });
  return runPool(tasks, cfg.concurrency);
}

// --- reporting ---

function bucket(status: number): "2xx" | "3xx" | "4xx" | "5xx" | "err" {
  if (status === 0) return "err";
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "err";
}

function printDistribution(targets: Record<SessionType, number>, results: SessionResult[]): void {
  const header = ["session type", "stg", "target", "real", "reqs", "2xx", "3xx", "4xx", "5xx", "err"];
  const rows: string[][] = [];
  const totals = { target: 0, real: 0, reqs: 0, "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, err: 0 };

  for (const type of SESSION_TYPES) {
    const group = results.filter((r) => r.type === type);
    const counts = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, err: 0 };
    let reqs = 0;
    for (const r of group) {
      for (const step of r.steps) {
        reqs++;
        counts[bucket(step.status)]++;
      }
    }
    rows.push([
      type,
      String(STAGE_OF[type]),
      String(targets[type]),
      String(group.length),
      String(reqs),
      String(counts["2xx"]),
      String(counts["3xx"]),
      String(counts["4xx"]),
      String(counts["5xx"]),
      String(counts.err),
    ]);
    totals.target += targets[type];
    totals.real += group.length;
    totals.reqs += reqs;
    totals["2xx"] += counts["2xx"];
    totals["3xx"] += counts["3xx"];
    totals["4xx"] += counts["4xx"];
    totals["5xx"] += counts["5xx"];
    totals.err += counts.err;
  }

  const totalRow = [
    "TOTAL",
    "-",
    String(totals.target),
    String(totals.real),
    String(totals.reqs),
    String(totals["2xx"]),
    String(totals["3xx"]),
    String(totals["4xx"]),
    String(totals["5xx"]),
    String(totals.err),
  ];

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length), totalRow[i].length)
  );
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log("\nObserved vs target distribution (plan §4)");
  console.log("  " + fmt(header));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log("  " + fmt(row));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  console.log("  " + fmt(totalRow));
}

function countOk(results: SessionResult[], type: SessionType, action: string): number {
  return results.filter(
    (r) => r.type === type && r.steps.some((s) => s.action === action && s.ok)
  ).length;
}

function printAcceptance(all: SessionResult[], state: RunState, floors: Floors): void {
  const holdout = countOk(all, "newCheckout", "complete_checkout");
  const guestCheckouts = countOk(all, "guestCheckout", "complete_checkout");
  const returningCheckouts = countOk(all, "returningCheckout", "complete_checkout");
  const returnsFiled = all.filter((r) => r.steps.some((s) => s.action === "request_return" && s.ok)).length;
  const linkedRefunds = [...refundedOrders].filter((id) => returnedOrders.has(id)).length;
  const promoSuccess = all.reduce(
    (n, r) => n + (r.steps.some((s) => s.action === "apply_promo" && s.ok) ? 1 : 0),
    0
  );

  const registerNoCheckout = all.filter(
    (r) =>
      r.steps.some((s) => s.action === "register") &&
      !r.steps.some((s) => s.action === "complete_checkout" && s.ok)
  ).length;
  const loginNoRegister = all.filter(
    (r) => r.steps.some((s) => s.action === "login") && !r.steps.some((s) => s.action === "register")
  ).length;

  const flag = (value: number, floor: number) => (value >= floor ? "✓" : "✗");

  console.log("\nAcceptance gates (plan §7)");
  console.log(`  ${flag(holdout, floors.holdout)} holdout (new-customer checkout):   ${holdout} / ≥${floors.holdout}`);
  console.log(`  ${flag(guestCheckouts, floors.guestCheckout)} guest checkouts:               ${guestCheckouts} / ≥${floors.guestCheckout}`);
  console.log(`  ${flag(returningCheckouts, floors.returningCheckout)} returning checkouts:           ${returningCheckouts} / ≥${floors.returningCheckout}`);
  console.log(`  ${flag(returnsFiled, floors.returns)} returns filed:                 ${returnsFiled} / ≥${floors.returns}`);
  console.log(`  ${flag(linkedRefunds, floors.linkedRefunds)} cross-role linked refunds:     ${linkedRefunds} / ≥${floors.linkedRefunds}`);
  console.log(`  ${flag(promoSuccess, floors.promoSuccess)} promo applications (ok):       ${promoSuccess} / ≥${floors.promoSuccess}`);
  console.log("\nIdentity decoupling (plan §1.4)");
  console.log(`  register-without-checkout sessions: ${registerNoCheckout}`);
  console.log(`  login-without-register sessions:    ${loginNoRegister}`);
  console.log(`  pools: ${JSON.stringify(state.summary)}`);
}

async function preflight(cfg: TrafficConfig): Promise<boolean> {
  const client = new MedusaClient(cfg, newSessionId("preflight"));
  const health = await client.request("GET", "/health", { publishable: false });
  if (health.status === 0) {
    console.error(`\n✗ Cannot reach Medusa at ${cfg.backendUrl}. Is it running? (npm run compose:up)`);
    return false;
  }
  console.log(`  ✓ Medusa reachable at ${cfg.backendUrl} (/health -> ${health.status})`);
  if (!cfg.publishableKey) {
    console.warn("  ! MEDUSA_PUBLISHABLE_API_KEY is empty — store calls will 400. Set it in .env.");
  }
  return true;
}

async function main() {
  const cfg = loadConfig();

  console.log("Phase 5: Synthetic Traffic Generator (staged taxonomy)");
  console.log(`  Backend:     ${cfg.backendUrl}`);
  console.log(`  Profile:     ${cfg.profile}  (N=${cfg.totalSessions}, pool=${cfg.accountPoolSize})`);
  console.log(`  LLM model:   ${cfg.llmModel}${cfg.anthropicApiKey ? "" : " (no key — local fallback)"}`);
  console.log(`  Concurrency: ${cfg.concurrency}\n`);

  if (!(await preflight(cfg))) {
    process.exit(1);
  }

  const state = new RunState();
  const start = Date.now();

  // Stage 0 — seed.
  const seedResults = await stage0(cfg, state);

  // Build the weighted mix and partition by stage.
  const targets = weightedAllocation(cfg.weights, cfg.totalSessions);
  applyFloors(targets, cfg.floors);
  const stage1Jobs: Job[] = [];
  const stage2Jobs: Job[] = [];
  for (const type of SESSION_TYPES) {
    for (let i = 0; i < targets[type]; i++) {
      const job: Job = { type, identity: identityFor(type) };
      (STAGE_OF[type] === 1 ? stage1Jobs : stage2Jobs).push(job);
    }
  }

  console.log(`\nStage 1 — browse & buy: ${stage1Jobs.length} sessions...`);
  const stage1Results = await runJobs(stage1Jobs, cfg, state);
  console.log(`  ✓ Stage 1 done. orderPool=${state.orderPool.length}`);

  // Stage 2 must hard-fail loudly on empty pools (plan §5).
  if (stage2Jobs.length > 0 && state.orderPool.length === 0) {
    console.error(
      "\n✗ Stage 2 has post-purchase sessions but orderPool is EMPTY — Stage 1 produced no orders.\n" +
        "  Likely the backend rejected checkout (seed data / publishable key / payment provider).\n" +
        "  Refusing to emit 0 returns/refunds silently. Fix Stage 1, then re-run."
    );
    process.exit(1);
  }

  console.log(`\nStage 2 — post-purchase: ${stage2Jobs.length} sessions...`);
  const stage2Results = await runJobs(stage2Jobs, cfg, state);
  console.log(`  ✓ Stage 2 done. returnPool=${state.returnPool.length}`);

  const all = [...stage1Results, ...stage2Results];
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  printDistribution(targets, all);
  printAcceptance([...seedResults, ...all], state, cfg.floors);

  const uniqueSessions = new Set([...seedResults, ...all].map((r) => r.sessionId)).size;
  console.log(`\nUnique session_id values: ${uniqueSessions}`);
  console.log(`Done in ${elapsed}s.`);
  console.log("\nNext: verify logs reached Elasticsearch with `npm run check:phase5`.");
}

main().catch((error) => {
  console.error("Unexpected error:", error instanceof Error ? error.stack : error);
  process.exit(1);
});
