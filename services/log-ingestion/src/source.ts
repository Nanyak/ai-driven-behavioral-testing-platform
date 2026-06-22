import { readFileSync } from "node:fs";
import type { RawLogDoc } from "./types.js";

interface ESHit<T> {
  _source: T;
  sort?: unknown[];
}

interface ESSearchResponse<T> {
  hits: {
    hits: ESHit<T>[];
  };
}

export class ESClient {
  constructor(private readonly baseUrl: string) {}

  private async request<T>(path: string, method: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ES ${method} ${path} -> HTTP ${res.status}${text ? `: ${text}` : ""}`);
    }
    return res.json() as Promise<T>;
  }

  /** Liveness probe so the CLI can fail fast with a clear message. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async openPit(index: string, keepAlive = "1m"): Promise<string> {
    const r = await this.request<{ id: string }>(
      `/${encodeURIComponent(index)}/_pit?keep_alive=${keepAlive}`,
      "POST"
    );
    return r.id;
  }

  /** Close a point-in-time. Best-effort: a leaked PIT expires on keep_alive. */
  async closePit(id: string): Promise<void> {
    await this.request("/_pit", "DELETE", { id }).catch(() => undefined);
  }

  async search<T>(body: unknown): Promise<ESSearchResponse<T>> {
    return this.request<ESSearchResponse<T>>("/_search", "POST", body);
  }
}

const SOURCE_FIELDS = [
  "timestamp",
  "session_id",
  "trace_id",
  "request_id",
  "method",
  "endpoint",
  "event",
  "status",
  "user_role",
  "user_id",
  "source",
  "request_payload",
  "response_body",
];

const PAGE_SIZE = 1000;

export interface TimeWindow {
  from: string;
  to: string;
}

function rangeFilter(window: TimeWindow): unknown {
  return { range: { timestamp: { gte: window.from, lte: window.to } } };
}

export async function fetchFromElasticsearch(
  client: ESClient,
  index: string,
  window: TimeWindow
): Promise<RawLogDoc[]> {
  const pit = await client.openPit(index);
  const docs: RawLogDoc[] = [];
  try {
    let searchAfter: unknown[] | undefined;
    // _shard_doc as tiebreaker is required for stable search_after paging with a PIT.
    const sort = [{ timestamp: "asc" }, { _shard_doc: "asc" }];

    while (true) {
      const body: Record<string, unknown> = {
        size: PAGE_SIZE,
        track_total_hits: false,
        _source: SOURCE_FIELDS,
        pit: { id: pit, keep_alive: "1m" },
        sort,
        query: {
          bool: {
            filter: [{ term: { source: "medusa" } }, rangeFilter(window)],
          },
        },
      };
      if (searchAfter) {
        body.search_after = searchAfter;
      }

      const res = await client.search<RawLogDoc>(body);
      const hits: ESHit<RawLogDoc>[] = res.hits.hits;
      if (hits.length === 0) {
        break;
      }
      for (const hit of hits) {
        docs.push(hit._source);
      }
      const last = hits[hits.length - 1];
      if (!last.sort || hits.length < PAGE_SIZE) {
        break;
      }
      searchAfter = last.sort;
    }
  } finally {
    await client.closePit(pit);
  }
  return docs;
}

export function readFromFile(path: string, window: TimeWindow): RawLogDoc[] {
  const docs: RawLogDoc[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let doc: RawLogDoc;
    try {
      doc = JSON.parse(trimmed) as RawLogDoc;
    } catch {
      continue;
    }
    if (doc.source !== "medusa" || !doc.timestamp) {
      continue;
    }
    if (doc.timestamp < window.from || doc.timestamp > window.to) {
      continue;
    }
    docs.push(doc);
  }
  return docs;
}
