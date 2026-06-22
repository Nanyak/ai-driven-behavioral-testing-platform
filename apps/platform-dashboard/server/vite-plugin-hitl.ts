import type { Plugin } from "vite";
import {
  listReports,
  loadFlows,
  readReportHtml,
  readReportHtmlById,
  readReportSummary,
  upsertDecision,
  type Decision,
} from "./hitl-store.js";

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
    },
  };
}
