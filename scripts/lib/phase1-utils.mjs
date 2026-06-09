import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

export const root = resolve(currentDir, "../..");
export const medusaRoot = join(root, "apps", "medusa");
export const backendRoot = join(medusaRoot, "apps", "backend");
export const medusaCliPath = join(
  medusaRoot,
  "node_modules",
  "@medusajs",
  "cli",
  "cli.js"
);

const medusaRequire = createRequire(join(medusaRoot, "package.json"));

export function readEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const env = {};
  const contents = readFileSync(filePath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    env[key] = value;
  }

  return env;
}

export function loadPhase1Env() {
  return {
    ...readEnvFile(join(root, ".env.example")),
    ...readEnvFile(join(root, ".env")),
    ...readEnvFile(join(backendRoot, ".env.template")),
    ...readEnvFile(join(backendRoot, ".env")),
    ...process.env,
  };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: {
      ...process.env,
      MEDUSA_TELEMETRY_DISABLED: "true",
      ...options.env,
    },
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}${output ? `\n${output}` : ""}`
    );
  }

  return result;
}

export function runMedusaCli(args, options = {}) {
  return run(process.execPath, [medusaCliPath, ...args], {
    cwd: backendRoot,
    ...options,
  });
}

export function isTcpOpen(host, port) {
  return new Promise((resolveOpen) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolveOpen(false);
    });
    socket.once("error", () => {
      resolveOpen(false);
    });
    socket.connect(port, host);
  });
}

export async function waitForTcp(host, port, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isTcpOpen(host, port)) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`${label} did not become reachable on ${host}:${port}`);
}

export async function queryPostgres(sql, parameters = []) {
  const { Client } = medusaRequire("pg");
  const env = loadPhase1Env();
  const client = new Client({
    connectionString: env.DATABASE_URL,
  });

  await client.connect();
  try {
    return await client.query(sql, parameters);
  } finally {
    await client.end();
  }
}

export async function getPublishableApiKey() {
  const result = await queryPostgres(`
    select token
    from api_key
    where type = 'publishable'
      and revoked_at is null
      and deleted_at is null
    order by created_at desc
    limit 1
  `);

  return result.rows[0]?.token ?? "";
}

export function upsertEnvValue(filePath, key, value) {
  const contents = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const lines = contents.split(/\r?\n/);
  const assignment = `${key}=${value}`;
  let replaced = false;

  const updatedLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return assignment;
    }
    return line;
  });

  if (!replaced) {
    if (updatedLines.length > 0 && updatedLines.at(-1) !== "") {
      updatedLines.push("");
    }
    updatedLines.push(assignment);
  }

  writeFileSync(filePath, updatedLines.join("\n").replace(/\n*$/, "\n"));
}

export function parsePortFromUrl(value, fallback) {
  try {
    return Number(new URL(value).port || fallback);
  } catch {
    return fallback;
  }
}
