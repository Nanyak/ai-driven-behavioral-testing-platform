/**
 * Agent invocation (plan §New module #4). Default backend is the local `claude`
 * CLI in headless mode — it is installed and already authenticated, so no
 * ANTHROPIC_API_KEY is required (the repo's traffic-generator uses the SDK path
 * instead, which CI can swap in by implementing this same `RepairAgent` interface).
 *
 * Tools are disabled (`--allowedTools ""`) and turns capped at 1 so the model
 * produces a single TEXT completion (the rewritten spec) rather than acting
 * agentically and editing files itself — we want a value we can run through the
 * oracle-guard before anything touches disk.
 */
import { spawnSync } from "node:child_process";

export type RepairAgent = (prompt: string) => string;

export interface AgentOptions {
  /** Override the model (defaults to the CLI's configured model). */
  model?: string;
  timeoutMs?: number;
  cwd?: string;
  /**
   * Allow READ-ONLY live API exploration: the agent may call `curl` (and only
   * curl) so it can discover entity state — e.g. list orders and find one that is
   * genuinely cancelable — before writing the arrange. `Bash(curl:*)` permits the
   * curl command prefix ONLY, so the agent still cannot touch the filesystem (no
   * `echo >`, `rm`, Write, or Edit). The returned spec is still oracle-guarded.
   */
  explore?: boolean;
}

/** Strip a leading ```lang fence and trailing ``` the model may add despite instructions. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

export function makeClaudeCliAgent(opts: AgentOptions = {}): RepairAgent {
  return (prompt: string): string => {
    // Explore mode: curl-only Bash + several turns so it can probe→reason→emit.
    // Otherwise: no tools, single turn — a pure text completion.
    const args = opts.explore
      ? ["-p", "--output-format", "json", "--allowedTools", "Bash(curl:*)", "--max-turns", "16"]
      : ["-p", "--output-format", "json", "--allowedTools", "", "--max-turns", "1"];
    if (opts.model) args.push("--model", opts.model);

    const proc = spawnSync("claude", args, {
      input: prompt,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? (opts.explore ? 420_000 : 180_000),
      maxBuffer: 32 * 1024 * 1024,
      cwd: opts.cwd,
    });

    if (proc.error) throw new Error(`claude CLI failed to start: ${proc.error.message}`);
    if (proc.status !== 0) {
      throw new Error(`claude CLI exited ${proc.status}: ${(proc.stderr || proc.stdout || "").slice(0, 800)}`);
    }

    let parsed: { result?: string; is_error?: boolean; subtype?: string };
    try {
      parsed = JSON.parse(proc.stdout) as typeof parsed;
    } catch {
      throw new Error(`claude CLI returned non-JSON output: ${proc.stdout.slice(0, 400)}`);
    }
    if (parsed.is_error || typeof parsed.result !== "string") {
      throw new Error(`claude CLI returned an error result (${parsed.subtype ?? "unknown"})`);
    }
    return stripFences(parsed.result);
  };
}
