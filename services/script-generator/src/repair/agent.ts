import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RepairAgent = (prompt: string) => Promise<string>;

/** Cost-effective default; override with REPAIR_AGENT_MODEL or AgentOptions.model. */
export const DEFAULT_AGENT_MODEL = process.env.REPAIR_AGENT_MODEL || "claude-sonnet-4-6";

export interface AgentOptions {
  /** Override the model (defaults to REPAIR_AGENT_MODEL or claude-sonnet-4-6). */
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  explore?: boolean;
  maxTurns?: number;
}

/**
 * Normalize the model's text-only response into a spec source. Besides markdown
 * fences, models occasionally prepend a sentence despite the output contract;
 * the immutable generated header is the only safe start boundary.
 */
export function normalizeAgentSource(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  const unfenced = (fenced ? fenced[1] : trimmed).trim();
  const header = unfenced.indexOf("// flow_signature:");
  return (header > 0 ? unfenced.slice(header) : unfenced).trim();
}

export function makeClaudeAgent(opts: AgentOptions = {}): RepairAgent {
  return async (prompt: string): Promise<string> => {
    // Explore mode: curl-only Bash + several turns so it can probe→reason→emit.
    // Otherwise: no tools, single turn — a pure text completion. The allowlist is
    // the security boundary: in headless mode any tool not listed is denied, so the
    // explore agent can only ever run curl.
    const maxTurns = opts.maxTurns ?? (opts.explore ? 16 : 1);
    const allowedTools = opts.explore ? ["Bash(curl:*)"] : [];

    const ownsScratch = opts.cwd === undefined;
    const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "resolver-agent-"));
    const timeoutMs = opts.timeoutMs ?? (opts.explore ? 420_000 : 180_000);

    try {
      const run = query({
        prompt,
        options: {
          model: opts.model ?? DEFAULT_AGENT_MODEL,
          allowedTools,
          maxTurns,
          cwd,
        },
      });

      // Cap wall-clock the way the old spawnSync `timeout` did: abort the query
      // (which terminates the underlying process) if it runs past the budget.
      const timer = setTimeout(() => void run.interrupt?.(), timeoutMs);
      try {
        for await (const message of run) {
          if (message.type !== "result") continue;
          if (message.subtype !== "success" || message.is_error || typeof message.result !== "string") {
            throw new Error(`claude agent returned an error result (${message.subtype ?? "unknown"})`);
          }
          return normalizeAgentSource(message.result);
        }
      } finally {
        clearTimeout(timer);
      }
      throw new Error("claude agent produced no result message");
    } catch (err) {
      throw new Error(`claude agent failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (ownsScratch) rmSync(cwd, { recursive: true, force: true });
    }
  };
}
