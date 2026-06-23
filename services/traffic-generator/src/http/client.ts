import type { TrafficConfig } from "../config/config.js";
import { newTraceId } from "../config/ids.js";

export interface ApiResponse<T = any> {
  status: number;
  ok: boolean;
  body: T;
}

interface RequestOptions {
  body?: unknown;
  token?: string;
  publishable?: boolean;
}

/**
 * Surfaces 4xx/5xx as values instead of throwing so the noise/retry logic can
 * react to failures.
 *
 * It deliberately attaches NO persona or role header — role is established by
 * which auth endpoints a session hits, recorded by the Medusa logging
 * middleware from the JWT actor_type.
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
    // Store + auth use the publishable key; admin uses the JWT instead.
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
