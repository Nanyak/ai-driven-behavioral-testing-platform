import { randomUUID } from "node:crypto";

export type SessionSource =
  | "guest"
  | "admin"
  | "llm"
  | "customer"
  | "edge";

/**
 * session_id = sess-<source>-<uuid>.
 *
 * The <source> tag exists ONLY for human debugging of a generator run. It is
 * never sent as a classifier signal and the behavior engine must not parse it: persona is
 * derived from flow content, not from this label. It accepts
 * an arbitrary string so the staged orchestrator can tag by session type.
 */
export function newSessionId(source: string): string {
  return `sess-${source}-${randomUUID()}`;
}

export function newTraceId(): string {
  return randomUUID();
}

export function newCustomerEmail(): string {
  return `behavior+${randomUUID().slice(0, 12)}@example.com`;
}
