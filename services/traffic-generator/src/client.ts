import type { TrafficConfig } from "./config.js";
import { newTraceId } from "./ids.js";

export interface ApiResponse<T = any> {
  status: number;
  ok: boolean;
  body: T;
}

interface RequestOptions {
  body?: unknown;
  token?: string;
  /** Force-enable/disable the publishable key. Defaults to auto by path. */
  publishable?: boolean;
}

/**
 * Thin HTTP wrapper bound to a single session_id. It injects the behavior
 * headers (x-session-id, fresh x-trace-id per request) and the store
 * publishable key, and surfaces 4xx/5xx as values instead of throwing so the
 * noise/retry logic can react to failures (plan §5 step 1).
 *
 * It deliberately attaches NO persona or role header — role is established by
 * which auth endpoints a session hits, recorded by the Medusa logging
 * middleware from the JWT actor_type (plan §7, §10.3).
 */
export class MedusaClient {
  constructor(
    private readonly cfg: TrafficConfig,
    public readonly sessionId: string
  ) {}

  private usePublishable(path: string, override?: boolean): boolean {
    if (typeof override === "boolean") {
      return override;
    }
    // Store + auth endpoints expect the publishable key; admin does not.
    return path.startsWith("/store") || path.startsWith("/auth");
  }

  async request<T = any>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-session-id": this.sessionId,
      "x-trace-id": newTraceId(),
    };

    if (this.usePublishable(path, options.publishable) && this.cfg.publishableKey) {
      headers["x-publishable-api-key"] = this.cfg.publishableKey;
    }
    if (options.token) {
      headers["authorization"] = `Bearer ${options.token}`;
    }

    let response: Response;
    try {
      response = await fetch(`${this.cfg.backendUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      // Network failure / timeout — treat as a non-throwing 0 status.
      return {
        status: 0,
        ok: false,
        body: { error: error instanceof Error ? error.message : String(error) } as T,
      };
    }

    const text = await response.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    } else {
      body = null;
    }

    return { status: response.status, ok: response.ok, body: body as T };
  }
}
