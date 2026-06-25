import type { Plugin } from "vite";
import {
  deleteTestFile,
  listReports,
  loadFlows,
  readReportHtml,
  readReportHtmlById,
  readReportSummary,
  upsertDecision,
  type Decision,
} from "./hitl-store.js";
import { getTestRunStatus, isValidTarget, startTestRun } from "./test-run.js";

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

      server.middlewares.use("/api/decisions", (req, res, next) => {
        if (req.method !== "POST") {
          next();
          return;
        }
        void (async () => {
          try {
            const body = (await readBody(req)) as {
              flow_signature?: string;
              status?: string;
              test_path?: string | null;
              flow_name?: string;
              persona?: string;
              route_key?: string;
              status_signature?: string;
              step_count?: number;
            };
            const signature = body.flow_signature;
            const status = body.status as Decision | undefined;
            if (typeof signature !== "string" || (status !== "approved" && status !== "discarded")) {
              sendJson(res, 400, {
                error: "flow_signature (string) and status (approved|discarded) are required",
              });
              return;
            }
            const entry = upsertDecision({
              flow_signature: signature,
              status,
              test_path: body.test_path ?? null,
              flow_name: body.flow_name,
              persona: body.persona,
              route_key: body.route_key,
              status_signature: body.status_signature,
              step_count: body.step_count,
            });
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
                error: "target must be one of: all, guest, customer, admin, happy, failure",
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
    },
  };
}
