/**
 * Dedicated resolver-agent repair CLI.
 *
 * Unlike the deterministic generator, this command operates only on specs that
 * already exist in generated-tests/. A scoped repair therefore cannot regenerate
 * or overwrite unrelated artifacts before verification.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasBlockingRepairOutcomes,
  printRepairSummary,
  runRepair,
  type EmittedSpec,
} from "./repair.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "..", "..", "..", "..");
const GENERATED_TESTS_DIR = resolvePath(REPO_ROOT, "generated-tests");
const ARTIFACT_MANIFEST = resolvePath(GENERATED_TESTS_DIR, ".artifacts.json");
const HITL_STORE = resolvePath(REPO_ROOT, "data", "hitl", "approvals.json");

interface ManifestEntry {
  flow_signature?: string;
  test_path?: string;
}

interface ApprovalEntry {
  flow_signature?: string;
  status?: string;
}

function entriesFromJson<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: T[] } | T[];
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

function parseJsonString(match: RegExpMatchArray | null): string | null {
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return null;
  }
}

function flowNameFromSource(source: string, relPath: string): string {
  const annotation = source.match(
    /type:\s*"flow_name",\s*description:\s*("(?:\\.|[^"\\])*")/
  );
  const annotatedName = parseJsonString(annotation);
  if (annotatedName) return annotatedName;

  const title = parseJsonString(source.match(/test\(\s*("(?:\\.|[^"\\])*")/));
  if (title) {
    const separator = " — ";
    const index = title.indexOf(separator);
    return index >= 0 ? title.slice(index + separator.length) : title;
  }
  return relPath;
}

function loadExistingSpecs(): EmittedSpec[] {
  const entries = entriesFromJson<ManifestEntry>(ARTIFACT_MANIFEST);
  const specs: EmittedSpec[] = [];

  for (const entry of entries) {
    const signature = entry.flow_signature?.toLowerCase();
    const relPath = entry.test_path;
    if (!signature || !/^[0-9a-f]{64}$/.test(signature) || !relPath) continue;
    if (
      relPath.includes("\\") ||
      relPath.startsWith("/") ||
      relPath.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !/^(guest|customer|admin)\/.+\.spec\.ts$/.test(relPath)
    ) {
      continue;
    }

    const absPath = resolvePath(GENERATED_TESTS_DIR, relPath);
    if (!existsSync(absPath)) continue;
    const source = readFileSync(absPath, "utf8");
    specs.push({
      relPath,
      flowName: flowNameFromSource(source, relPath),
      signature,
      fixme: source.includes("test.fixme("),
    });
  }

  return specs.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function approvedSignatures(): Set<string> {
  return new Set(
    entriesFromJson<ApprovalEntry>(HITL_STORE)
      .filter(
        (entry) =>
          entry.status === "approved" &&
          typeof entry.flow_signature === "string"
      )
      .map((entry) => entry.flow_signature!.toLowerCase())
  );
}

function onlyArgs(args: string[]): string[] | undefined {
  const index = args.indexOf("--only");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("--only requires a spec hash or path fragment");
  const only = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (only.length === 0) throw new Error("--only requires a spec hash or path fragment");
  return only;
}

async function main(): Promise<void> {
  let only: string[] | undefined;
  try {
    only = onlyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const specs = loadExistingSpecs();
  if (specs.length === 0) {
    console.error(`No generated specs found in ${ARTIFACT_MANIFEST}. Run the generator first.`);
    process.exitCode = 1;
    return;
  }

  const selected = only
    ? specs.filter((spec) => only!.some((fragment) => spec.relPath.includes(fragment)))
    : specs;
  if (selected.length === 0) {
    console.error(`No generated specs matched --only ${only!.join(",")}.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Resolver-agent repair: verifying ${selected.length} existing spec(s) against the live SUT…`
  );
  const outcomes = await runRepair(specs, {
    approvedSignatures: approvedSignatures(),
    only,
  });
  printRepairSummary(outcomes);
  if (hasBlockingRepairOutcomes(outcomes)) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
