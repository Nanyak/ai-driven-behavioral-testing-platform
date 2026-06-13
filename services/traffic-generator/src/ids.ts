import { randomUUID } from "node:crypto";

export type SessionSource =
  | "guest"
  | "admin"
  | "llm"
  | "customer"
  | "edge"
  | "noise";

/**
 * session_id = sess-<source>-<uuid>.
 *
 * The <source> tag exists ONLY for human debugging of a generator run. It is
 * never sent as a classifier signal and Phase 7 must not parse it: persona is
 * derived from flow content, not from this label (plan §8 / §10.3). It accepts
 * an arbitrary string so the staged orchestrator can tag by session type.
 */
export function newSessionId(source: string): string {
  return `sess-${source}-${randomUUID()}`;
}

/** trace_id = fresh uuid per request. */
export function newTraceId(): string {
  return randomUUID();
}

/** Unique throwaway customer email for registration flows. */
export function newCustomerEmail(): string {
  return `behavior+${randomUUID().slice(0, 12)}@example.com`;
}
