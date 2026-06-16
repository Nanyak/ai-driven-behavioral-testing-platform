import { MedusaClient } from "./client.js";
import { loadConfig, type TrafficConfig, type Floors } from "./config.js";
import { newSessionId } from "./ids.js";
import { AdminSession } from "./api/admin-session.js";
import { DEFAULT_PASSWORD, StoreSession } from "./api/store-session.js";
import { RunState } from "./state.js";
import {
  SESSION_TYPES,
  STAGE_OF,
  weightedAllocation,
  identityFor,
  type SessionType,
  type Identity,
} from "./taxonomy.js";
import { chance } from "./util/random.js";
import { dispatch } from "./dispatch.js";
import { printDistribution, printAcceptance, type SessionResult } from "./reporting.js";

interface Job {
  type: SessionType;
  identity: Identity;
}

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
  counts.returns = Math.max(counts.returns, floors.returns);
  counts.adminRefund = Math.max(counts.adminRefund, floors.linkedRefunds);
  counts.adminCancel = Math.max(counts.adminCancel, floors.canceledOrders);
  // Fulfillment (Stage 2a) must out-supply the return path: each F3 return
  // claims one fulfilled order (the read-only E inquiry does not). The margin
  // covers occasional fulfillment failures so the returns / linked-refund
  // floors stay reachable, and leaves fulfilled-but-unreturned orders — the
  // realistic majority that simply shipped.
  counts.adminFulfill = Math.max(counts.adminFulfill, counts.adminRefund + 3);
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

  // Stage 2 runs in two waves: fulfillment first (2a) so the return path (2b)
  // has fulfilled, returnable orders to draw from. Cancels (2b) take the
  // remaining unfulfilled orders.
  const fulfillJobs = stage2Jobs.filter((j) => j.type === "adminFulfill");
  const reversalJobs = stage2Jobs.filter((j) => j.type !== "adminFulfill");

  console.log(`\nStage 2a — fulfillment: ${fulfillJobs.length} sessions...`);
  const stage2aResults = await runJobs(fulfillJobs, cfg, state);
  const fulfilledCount = state.orderPool.filter((o) => o.fulfilled).length;
  console.log(`  ✓ Stage 2a done. fulfilled orders=${fulfilledCount}`);

  console.log(`\nStage 2b — post-purchase & reversals: ${reversalJobs.length} sessions...`);
  const stage2bResults = await runJobs(reversalJobs, cfg, state);
  console.log(
    `  ✓ Stage 2b done. returnPool=${state.returnPool.length}, canceled=${state.canceledOrderIds.size}`
  );

  const stage2Results = [...stage2aResults, ...stage2bResults];

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
