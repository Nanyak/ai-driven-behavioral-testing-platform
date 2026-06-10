import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  backendRoot,
  getPublishableApiKey,
  loadPhase1Env,
  medusaCliPath,
  root,
  run,
  runMedusaCli,
  upsertEnvValue,
} from "./lib/phase1-utils.mjs";

const env = loadPhase1Env();
const rootEnvPath = join(root, ".env");
const backendEnvPath = join(backendRoot, ".env");

console.log("Starting Medusa PostgreSQL and Redis dependencies...");
run(process.execPath, [join(root, "scripts", "start-medusa-dependencies.mjs")]);

console.log("Syncing Medusa backend environment...");
function localServiceUrl(value) {
  if (!value) {
    return value;
  }

  try {
    const url = new URL(value);
    if (url.hostname === "postgres" || url.hostname === "redis") {
      url.hostname = "localhost";
    }
    return url.toString();
  } catch {
    return value;
  }
}

for (const key of [
  "DATABASE_URL",
  "REDIS_URL",
  "STORE_CORS",
  "ADMIN_CORS",
  "AUTH_CORS",
  "JWT_SECRET",
  "COOKIE_SECRET",
]) {
  if (env[key]) {
    upsertEnvValue(
      backendEnvPath,
      key,
      key === "DATABASE_URL" || key === "REDIS_URL" ? localServiceUrl(env[key]) : env[key]
    );
  }
}

console.log("Running Medusa database setup...");
runMedusaCli(["db:setup", "--db", env.POSTGRES_DB || "medusa", "--no-interactive", "--execute-safe-links"]);

console.log("Running Medusa migration scripts and seed data...");
runMedusaCli(["db:migrate:scripts"]);

console.log("Creating or confirming the Medusa admin user...");
const userResult = spawnSync(
  process.execPath,
  [
    medusaCliPath,
    "user",
    "-e",
    env.MEDUSA_ADMIN_EMAIL || "admin@example.com",
    "-p",
    env.MEDUSA_ADMIN_PASSWORD || "change-me",
  ],
  {
    cwd: backendRoot,
    env: {
      ...process.env,
      MEDUSA_TELEMETRY_DISABLED: "true",
    },
    encoding: "utf8",
  }
);

const userOutput = [userResult.stdout, userResult.stderr].filter(Boolean).join("\n");
if (userResult.status !== 0 && !/exist|already/i.test(userOutput)) {
  throw new Error(`Admin user creation failed:\n${userOutput}`);
}
if (userResult.status === 0) {
  console.log("Admin user is ready.");
} else {
  console.log("Admin user already exists.");
}

console.log("Retrieving the publishable API key...");
const publishableApiKey = await getPublishableApiKey();
if (!publishableApiKey) {
  throw new Error("No publishable API key found after seeding.");
}

upsertEnvValue(rootEnvPath, "MEDUSA_PUBLISHABLE_API_KEY", publishableApiKey);
console.log("Stored MEDUSA_PUBLISHABLE_API_KEY in root .env.");
console.log("Medusa Phase 1 setup completed.");
