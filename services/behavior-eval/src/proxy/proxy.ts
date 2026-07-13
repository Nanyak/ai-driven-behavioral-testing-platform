import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { Mutant } from "../types.js";
import { applyMutation } from "./apply.js";
import { requestEndpoint } from "./endpoint.js";

export interface ProxyOptions {
  upstream: string;
  port: number;
  host?: string;
  controlEnabled?: boolean;
  log?: (line: string) => void;
}

export interface MutationProxy {
  server: http.Server;
  url: string;
  close(): Promise<void>;
}

interface HitStats {
  applied: number;
  not_applied: number;
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
  });
  res.end(bytes);
}

function isJsonResponse(headers: http.IncomingHttpHeaders): boolean {
  return String(headers["content-type"] ?? "").toLowerCase().includes("application/json");
}

function copyHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "content-length" || key.toLowerCase() === "content-encoding") continue;
    out[key] = value;
  }
  return out;
}

export function createMutationProxy(options: ProxyOptions): MutationProxy {
  const upstream = new URL(options.upstream);
  const host = options.host ?? "127.0.0.1";
  const controlEnabled = options.controlEnabled ?? process.env.EVAL_PROXY_CONTROL === "1";
  let activeMutant: Mutant | null = null;
  const hits = new Map<string, HitStats>();

  const server = http.createServer(async (req, res) => {
    try {
      if ((req.url ?? "").startsWith("/__eval/")) {
        if (!controlEnabled) {
          sendJson(res, 404, { error: "control channel disabled" });
          return;
        }
        if (req.method === "GET" && req.url === "/__eval/health") {
          try {
            const health = await fetch(new URL("/health", upstream).toString(), {
              signal: AbortSignal.timeout(4000),
            });
            sendJson(res, health.ok ? 200 : 502, { ok: health.ok, upstream_status: health.status });
          } catch (error) {
            sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }
        if (req.method === "POST" && req.url === "/__eval/mutant") {
          const body = await readRequestBody(req);
          activeMutant = body.length === 0 ? null : (JSON.parse(body.toString("utf8")) as Mutant | null);
          hits.clear();
          sendJson(res, 200, { ok: true, active_mutant_id: activeMutant?.id ?? null });
          return;
        }
        if (req.method === "GET" && req.url === "/__eval/hits") {
          sendJson(res, 200, {
            active_mutant_id: activeMutant?.id ?? null,
            hits: Object.fromEntries(hits),
          });
          return;
        }
        sendJson(res, 404, { error: "unknown eval control endpoint" });
        return;
      }

      const requestBody = await readRequestBody(req);
      const target = new URL(req.url ?? "/", upstream);
      const headers = { ...req.headers, host: upstream.host, "accept-encoding": "identity" };
      delete headers["content-length"];
      const upstreamReq = http.request(
        target,
        {
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          const chunks: Buffer[] = [];
          upstreamRes.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          upstreamRes.on("end", () => {
            const originalStatus = upstreamRes.statusCode ?? 502;
            let status = originalStatus;
            let responseBody = Buffer.concat(chunks);
            const endpoint = requestEndpoint(req.method, req.url);
            const mutant = activeMutant;
            if (
              mutant &&
              mutant.endpoint === endpoint &&
              mutant.status === originalStatus &&
              (mutant.operator === "status_change" || isJsonResponse(upstreamRes.headers))
            ) {
              const hit = hits.get(mutant.id) ?? { applied: 0, not_applied: 0 };
              try {
                const parsed =
                  mutant.operator === "status_change"
                    ? null
                    : responseBody.length > 0
                      ? JSON.parse(responseBody.toString("utf8"))
                      : null;
                const applied = applyMutation(mutant, parsed, originalStatus);
                status = applied.status;
                if (mutant.operator !== "status_change") {
                  responseBody = Buffer.from(JSON.stringify(applied.body));
                }
                if (applied.applied) hit.applied += 1;
                else hit.not_applied += 1;
              } catch {
                hit.not_applied += 1;
              }
              hits.set(mutant.id, hit);
            }

            res.writeHead(status, {
              ...copyHeaders(upstreamRes.headers),
              "content-length": String(responseBody.length),
            });
            res.end(responseBody);
          });
        }
      );
      upstreamReq.on("error", (error) => {
        sendJson(res, 502, { error: error.message });
      });
      upstreamReq.end(requestBody);
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    server,
    url: `http://${host}:${options.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function startMutationProxy(options: ProxyOptions): Promise<MutationProxy> {
  const proxy = createMutationProxy(options);
  await new Promise<void>((resolve) => proxy.server.listen(options.port, options.host ?? "127.0.0.1", resolve));
  options.log?.(`mutation proxy listening on ${proxy.url} -> ${options.upstream}`);
  return proxy;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.EVAL_PROXY_PORT ?? 9099);
  const upstream = process.env.EVAL_PROXY_UPSTREAM ?? process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000";
  await startMutationProxy({ port, upstream, controlEnabled: true, log: console.log });
}
