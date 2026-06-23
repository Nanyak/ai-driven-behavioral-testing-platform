import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import {
  ESClient,
  fetchFromElasticsearch,
  readFromFile,
  type TimeWindow,
} from "./source.js";
import {
  buildSessionFlows,
  extractGoldenCandidates,
  goldenFileName,
  groupBySession,
} from "./pipeline.js";
import type { RawLogDoc } from "./types.js";

interface Args {
  from?: string;
  to?: string;
  file?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    switch (token) {
      case "--from":
        args.from = argv[++i];
        break;
      case "--to":
        args.to = argv[++i];
        break;
      case "--file":
        args.file = argv[++i];
        break;
      case "--quiet":
        args.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function resolveWindow(args: Args, windowHours: number): TimeWindow {
  const to = args.to ?? new Date().toISOString();
  const from =
    args.from ?? new Date(Date.parse(to) - windowHours * 3600_000).toISOString();
  return { from, to };
}

async function loadDocs(args: Args, window: TimeWindow): Promise<RawLogDoc[]> {
  const config = loadConfig();
  if (args.file) {
    // Resolve --file against the directory npm was invoked from (INIT_CWD),
    // not process.cwd() — the `npm --prefix` proxy runs us inside the service
    // dir, so a relative path from the repo root would otherwise miss.
    const base = process.env.INIT_CWD ?? process.cwd();
    return readFromFile(resolve(base, args.file), window);
  }
  const client = new ESClient(config.esUrl);
  if (!(await client.ping())) {
    throw new Error(
      `Elasticsearch is not reachable at ${config.esUrl}. Start the ELK stack ` +
        `(npm run elk:up) or ingest a local log file with --file <path>.`
    );
  }
  return fetchFromElasticsearch(client, config.esIndex, window);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const window = resolveWindow(args, config.windowHours);

  const log = (msg: string) => {
    if (!args.quiet) {
      console.log(msg);
    }
  };

  log(`[ingest] window ${window.from} .. ${window.to}`);
  log(`[ingest] source ${args.file ? `file:${args.file}` : `es:${config.esUrl}`}`);

  const docs = await loadDocs(args, window);
  log(`[ingest] fetched ${docs.length} raw log docs`);

  const { buckets, droppedNoSession } = groupBySession(docs);
  const { sessions, droppedSingleStep } = buildSessionFlows(buckets);
  const goldens = extractGoldenCandidates(docs, new Date().toISOString());

  mkdirSync(config.sessionsDir, { recursive: true });
  const sessionsPath = resolve(config.sessionsDir, `session-flows-${runId}.json`);
  writeFileSync(sessionsPath, `${JSON.stringify(sessions, null, 2)}\n`, "utf8");

  mkdirSync(config.goldenDir, { recursive: true });
  for (const candidate of goldens) {
    const goldenPath = resolve(config.goldenDir, goldenFileName(candidate));
    writeFileSync(goldenPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
  }

  const totalSteps = sessions.reduce((sum, s) => sum + s.steps.length, 0);
  log("");
  log("[ingest] summary");
  log(`  raw docs ............. ${docs.length}`);
  log(`  dropped (no session) . ${droppedNoSession}`);
  log(`  dropped (single step)  ${droppedSingleStep}`);
  log(`  buckets .............. ${buckets.length}`);
  log(`  session flows ........ ${sessions.length}`);
  log(`  total steps .......... ${totalSteps}`);
  log(`  golden candidates .... ${goldens.length}`);
  log("");
  log(`[ingest] wrote ${sessionsPath}`);
  log(
    goldens.length > 0
      ? `[ingest] wrote ${goldens.length} golden candidate(s) to ${config.goldenDir}`
      : `[ingest] no golden candidates (logs were bodies-off; golden service falls back to spec-only — expected)`
  );

  if (sessions.length < 50) {
    log(
      `[ingest] note: only ${sessions.length} session flows (<50). Generate more ` +
        `traffic (npm run traffic:generate) for a representative mining run.`
    );
  }
}

main().catch((err) => {
  console.error(`[ingest] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
