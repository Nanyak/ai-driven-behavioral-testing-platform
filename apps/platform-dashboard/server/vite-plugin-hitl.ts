import type { Plugin } from "vite";
import {
  artifactReview,
  deleteDecision,
  deleteTestFile,
  dismissRelationship,
  listReports,
  loadFlows,
  readDecisionHistory,
  readReportHtml,
  readReportHtmlById,
  readReportSummary,
  repairDiff,
  upsertDecision,
  type Decision,
} from "./hitl-store.js";
import { getTestRunStatus, isValidTarget, startTestRun } from "./test-run.js";
import { getJobStatus, isJobId, startJob, type JobParams } from "./jobs.js";

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(payload);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function hitlApiPlugin(): Plugin {
  return {
    name: "hitl-review-api",
    configureServer(server) {
      server.middlewares.use("/api/flows", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        try {
          sendJson(res, 200, loadFlows());
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : "load failed" });
        }
      });

      // Lazy artifact payload: source can be large, so keep it out of /api/flows.
      // The response also carries the redacted body plan and exact approval hashes.
      server.middlewares.use("/api/artifacts/review", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const signature = new URL(req.url ?? "", "http://localhost").searchParams.get("signature");
        const statusSignature =
          new URL(req.url ?? "", "http://localhost").searchParams.get("status_signature") ?? "";
        if (!signature) {
          sendJson(res, 400, { error: "signature query param is required" });
          return;
        }
        const artifact = artifactReview(signature, statusSignature);
        if (!artifact) {
          sendJson(res, 404, { error: "generated artifact not found for this flow" });
          return;
        }
        sendJson(res, 200, artifact);
      });

      // The before/after sources for a resolver-agent-repaired flow, so the review
      // panel can show what the agent changed in the arrange/setup.
      server.middlewares.use("/api/repair/diff", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const signature = new URL(req.url ?? "", "http://localhost").searchParams.get("signature");
        if (!signature) {
          sendJson(res, 400, { error: "signature query param is required" });
          return;
        }
        const diff = repairDiff(signature);
        if (!diff) {
          sendJson(res, 404, { error: "no agent repair recorded for this flow" });
          return;
        }
        sendJson(res, 200, diff);
      });

      server.middlewares.use("/api/summary", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        try {
          const flows = loadFlows();
          sendJson(res, 200, { flows: flows.counts, report: readReportSummary() });
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : "summary failed" });
        }
      });

      // Registered before /api/reports because /api/reports's prefix match would
      // otherwise shadow this more specific route.
      server.middlewares.use("/api/reports/view", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const run = new URL(req.url ?? "", "http://localhost").searchParams.get("run");
        const html = run ? readReportHtmlById(run) : null;
        if (html === null) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/html");
          res.end("<h1>Report not found</h1>");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });

      server.middlewares.use("/api/reports", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        try {
          sendJson(res, 200, { reports: listReports() });
        } catch (error) {
          sendJson(res, 500, { error: error instanceof Error ? error.message : "list failed" });
        }
      });

      server.middlewares.use("/api/report", (req, res, next) => {
        if (req.method !== "GET") {
          next();
          return;
        }
        const html = readReportHtml();
        if (html === null) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/html");
          res.end("<h1>No report yet</h1><p>Run <code>npm run test:all</code> to generate <code>reports/report.html</code>.</p>");
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html");
        res.end(html);
      });

      // Registered before /api/decisions because that prefix would otherwise
      // shadow this more specific route (same pattern as /api/reports/view).
      // Delete a decision (typically an approval) AND its generated spec — the
      // "delete the approved flow" action. Distinct from /api/tests/delete (which
      // removes only a draft file) and from discarding (which records a judgment).
      server.middlewares.use("/api/decisions/delete", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = (await readBody(req)) as { review_id?: string };
            if (typeof body.review_id !== "string" || body.review_id.trim().length === 0) {
              sendJson(res, 400, { error: "review_id (string) is required" });
              return;
            }
            const result = deleteDecision(body.review_id);
            if (result.deleted) {
              sendJson(res, 200, result);
              return;
            }
            const status = result.reason === "not_found" ? 404 : 400;
            sendJson(res, status, {
              error:
                result.reason === "not_found"
                  ? "no decision found for this review_id (already deleted?)"
                  : "review_id is invalid",
            });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : "delete failed" });
          }
        })();
      });

      server.middlewares.use("/api/decisions", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = (await readBody(req)) as {
              flow_signature?: string;
              review_id?: string;
              status?: string;
              test_path?: string | null;
              flow_name?: string;
              persona?: string;
              route_key?: string;
              status_signature?: string;
              step_count?: number;
              scenario_key?: string;
              /** Opt-in "Replace <baseline>": the approved baseline review id to supersede + delete. */
              supersede_review_id?: string;
              /**
               * "Approve as new": the related baseline review id this flow is being
               * approved as DISTINCT from. Recorded as a distinct-pairing verdict so
               * future mines stop flagging the pairing. Ignored when superseding.
               */
              distinct_from_review_id?: string;
            };
            const signature = body.flow_signature;
            const status = body.status as Decision | undefined;
            if (typeof signature !== "string" || (status !== "approved" && status !== "discarded")) {
              sendJson(res, 400, {
                error: "flow_signature (string) and status (approved|discarded) are required",
              });
              return;
            }
            const outcome = body.status_signature ?? "";
            const artifact = artifactReview(signature, outcome);
            if (status === "approved" && (!artifact || !artifact.body_plan_hash)) {
              sendJson(res, 409, {
                error:
                  "Approval requires a generated spec and body-plan manifest. Regenerate the test, then review it again.",
              });
              return;
            }
            // Supersession is now EXPLICIT and non-destructive-by-default. A plain
            // Approve (approve-as-new) coexists with any related approved baseline —
            // both stay approved, both keep their specs. Only "Replace <baseline>"
            // names a baseline to retire, and it does so opt-in. Skipping a flow that
            // relates to a baseline is allowed (the UI confirms intent); the baseline
            // stays hash-pinned, so run-time regression detection is unaffected.
            const supersedeId =
              status === "approved" &&
              typeof body.supersede_review_id === "string" &&
              body.supersede_review_id.trim().length > 0
                ? body.supersede_review_id.trim()
                : null;
            // Read the baseline's recorded spec BEFORE the upsert marks it superseded,
            // so we can delete exactly that runnable source afterward.
            const baselineToReplace = supersedeId
              ? readDecisionHistory().get(supersedeId) ?? null
              : null;
            const entry = upsertDecision({
              review_id: body.review_id,
              flow_signature: signature,
              status,
              test_path: artifact?.test_path ?? body.test_path ?? null,
              flow_name: body.flow_name,
              persona: body.persona,
              route_key: body.route_key,
              status_signature: body.status_signature,
              step_count: body.step_count,
              spec_hash: status === "approved" ? artifact?.spec_hash : undefined,
              body_plan_hash: status === "approved" ? artifact?.body_plan_hash ?? undefined : undefined,
              body_rule_sources: status === "approved" ? artifact?.body_rule_sources : undefined,
              scenario_key: body.scenario_key,
              supersede_review_ids: supersedeId ? [supersedeId] : undefined,
            });
            // Retire the explicitly-named baseline's runnable source only AFTER the new
            // artifact is bound as the approval — never on a plain Approve.
            if (
              supersedeId &&
              baselineToReplace?.test_path &&
              baselineToReplace.test_path !== artifact?.test_path
            ) {
              deleteTestFile(baselineToReplace.test_path);
            }
            // "Approve as new" (not a Replace): record that this approved outcome and the
            // named baseline are DISTINCT scenarios, so future mines stop flagging the
            // pairing as related/override. This is the folded-in "distinct" verdict — no
            // separate action. Touches no spec and no approval, only the sidecar store.
            if (
              status === "approved" &&
              !supersedeId &&
              typeof body.distinct_from_review_id === "string" &&
              body.distinct_from_review_id.trim().length > 0
            ) {
              dismissRelationship({
                review_id: entry.review_id ?? "",
                baseline_review_id: body.distinct_from_review_id.trim(),
              });
            }
            // "Skip" (discarded) records the skip-gate decision only — it does NOT
            // delete the draft file. File removal is the separate "Delete test" action.
            // The next generate reconciles a skipped draft (a discarded decision is not
            // a pending draft, so cleanPersonaFolderPreservingApproved drops it).
            sendJson(res, 200, { entry });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : "write failed" });
          }
        })();
      });

      // Delete a generated spec from the browser. The server does the unlink on the
      // operator's behalf (the browser has no filesystem access); deleteTestFile path-scopes
      // the target to generated-tests/ so only specs can be removed, never arbitrary files.
      server.middlewares.use("/api/tests/delete", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = (await readBody(req)) as { test_path?: string };
            if (typeof body.test_path !== "string" || body.test_path.trim().length === 0) {
              sendJson(res, 400, { error: "test_path (string) is required" });
              return;
            }
            const result = deleteTestFile(body.test_path);
            if (result.deleted) {
              sendJson(res, 200, { deleted: true, test_path: body.test_path });
              return;
            }
            const status = result.reason === "not_found" ? 404 : 400;
            const message =
              result.reason === "not_found"
                ? "test file not found (already deleted?)"
                : result.reason === "out_of_scope"
                  ? "test_path must point inside generated-tests/"
                  : "test_path is invalid";
            sendJson(res, status, { error: message });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : "delete failed" });
          }
        })();
      });

      // Run the Playwright suite from the browser. GET returns a poll-able snapshot; POST starts
      // a run (one at a time — 409 if already running). The server spawns the npm script on the
      // operator's behalf; the report endpoints surface the result once it finishes.
      server.middlewares.use("/api/tests/run", (req, res, next) => {
        if (req.method === "GET") {
          sendJson(res, 200, getTestRunStatus());
          return;
        }
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = (await readBody(req)) as { target?: string };
            const target = body.target ?? "all";
            if (!isValidTarget(target)) {
              sendJson(res, 400, {
                error: "target must be one of: all, guest, customer, admin, happy, failure, drafts",
              });
              return;
            }
            const result = startTestRun(target);
            if (!result.started) {
              sendJson(res, 409, { error: result.reason ?? "busy", status: getTestRunStatus() });
              return;
            }
            sendJson(res, 202, { started: true, status: getTestRunStatus() });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : "run failed" });
          }
        })();
      });

      // Run an authoring-pipeline stage (mine/generate/repair/triage) from the browser.
      // GET returns the SAME poll-able job snapshot as /api/tests/run (one global lock);
      // POST starts a job (409 if one is already going, 400 on a bad job id / params).
      // The server spawns the allowlisted npm script on the operator's behalf.
      server.middlewares.use("/api/pipeline/run", (req, res, next) => {
        if (req.method === "GET") {
          sendJson(res, 200, getJobStatus());
          return;
        }
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = (await readBody(req)) as { job?: string; params?: JobParams };
            if (!isJobId(body.job)) {
              sendJson(res, 400, {
                error: "job must be one of: mine, generate, repair, triage, test:<target>",
              });
              return;
            }
            const result = startJob(body.job, body.params ?? {});
            if (!result.started) {
              sendJson(res, result.code, { error: result.reason, status: getJobStatus() });
              return;
            }
            sendJson(res, 202, { started: true, status: getJobStatus() });
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : "run failed" });
          }
        })();
      });
    },
  };
}
