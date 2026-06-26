/**
 * Behavior-digest cache (cache #1).
 *
 * `@medusajs/core-flows` workflows are compiled, noisy `dist` JS. Feeding that
 * raw to the proposal agent every run is expensive and gives it poor input.
 * Instead we distill each workflow ONCE into a compact, human-auditable Markdown
 * digest — guards, side effects, the success/failure discriminator — and the
 * proposal agent reads the digest, not the source.
 *
 * Invalidation is by CONTENT HASH, never a clock: core-flows is immutable until a
 * dependency bump, so a daily regen would waste agent calls AND make the agent's
 * downstream invariant proposals non-reproducible (the oracle inputs would drift
 * for no reason — ADR 0001/0005). A digest section is regenerated only when its
 * workflow source hash changes. The digest is an INPUT to proposal — never an
 * assertion — so a wrong digest produces a proposal that fails the verify gate
 * and is dropped; the anti-hallucination contract holds end to end.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { stepTitle, workflowSourceHash } from "./codebase.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
export const DIGEST_DIR = resolvePath(REPO_ROOT, "data", "endpoint-behavior");

/** Filesystem-safe slug for an endpoint, e.g.
 * "POST /store/carts/{id}/complete" -> "post__store_carts_id_complete". */
export function digestSlug(method: string, endpoint: string): string {
  return stepTitle(method, endpoint)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function digestPath(method: string, endpoint: string): string {
  return resolvePath(DIGEST_DIR, `${digestSlug(method, endpoint)}.md`);
}

export interface DigestSection {
  /** The workflow source hash this digest was generated from (frontmatter). */
  sourceHash: string;
  /** The Markdown body the agent wrote (no frontmatter). */
  body: string;
}

/** Parse `source_hash` and the body out of a digest file. Returns null when the
 * file is absent or has no frontmatter hash (treated as "must regenerate"). */
export function parseDigestFile(text: string): DigestSection | null {
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!fm) return null;
  const hashLine = /(?:^|\n)source_hash:\s*([0-9a-f]+)/.exec(fm[1]);
  if (!hashLine) return null;
  return { sourceHash: hashLine[1], body: fm[2].trim() };
}

export function loadDigestSection(method: string, endpoint: string): DigestSection | null {
  const path = digestPath(method, endpoint);
  if (!existsSync(path)) return null;
  try {
    return parseDigestFile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** A digest is stale when no file exists, or its stored source hash no longer
 * matches the workflow's current content hash (i.e. Medusa was upgraded). An
 * endpoint with no mapped workflow is never "stale" (nothing to digest). */
export function isDigestStale(method: string, endpoint: string): boolean {
  const current = workflowSourceHash(method, endpoint);
  if (current === "") return false; // unmapped — nothing to digest
  const existing = loadDigestSection(method, endpoint);
  return !existing || existing.sourceHash !== current;
}

/** The compact digest body for the proposal prompt, or null when none exists. */
export function digestBodyFor(method: string, endpoint: string): string | null {
  return loadDigestSection(method, endpoint)?.body ?? null;
}

/** Serialize a digest file: hash + provenance frontmatter, then the agent body. */
export function renderDigestFile(
  method: string,
  endpoint: string,
  workflow: string,
  sourceHash: string,
  body: string
): string {
  const fm = [
    "---",
    `endpoint: ${stepTitle(method, endpoint)}`,
    `workflow: ${workflow}`,
    `source_hash: ${sourceHash}`,
    `generated_at: ${new Date().toISOString()}`,
    "---",
  ].join("\n");
  return `${fm}\n\n${body.trim()}\n`;
}

export function saveDigestFile(method: string, endpoint: string, content: string): void {
  mkdirSync(DIGEST_DIR, { recursive: true });
  writeFileSync(digestPath(method, endpoint), content);
}

/** Build the agent prompt that distills one workflow's source into a digest.
 * Pinned to a small, behavior-focused shape so digests are uniform and the
 * proposal agent can rely on the section headings. */
export function buildDigestPrompt(method: string, endpoint: string, source: string): string {
  return `You are reading the @medusajs/core-flows workflow that backs the API endpoint
"${stepTitle(method, endpoint)}" in a Medusa v2 backend. Summarize ONLY observable
behavior that an API test could assert on the response body — not implementation detail.

Write GitHub-flavored Markdown with EXACTLY these sections (omit a bullet if it
truly does not apply, but keep the headings):

## Guards
- preconditions the workflow enforces (state the request must be in to succeed)

## Side effects
- state changes the workflow performs (e.g. decrements inventory, captures payment,
  emits an event, transitions a status field)

## Success discriminator
- the EXACT response-body shape that proves success (e.g. \`type === "order"\`,
  \`order.status === "canceled"\`) — what a 200 alone does NOT prove

## Failure shape
- how failure surfaces in the body, INCLUDING cases the endpoint returns HTTP 200
  for (e.g. \`{ type: "cart", error }\`), and the error fields present on 4xx

Be concrete about field paths and literal values. Output ONLY the Markdown, no
prose preamble, no code fences around the whole thing.

--- WORKFLOW SOURCE ---
${source.slice(0, 24_000)}`;
}
