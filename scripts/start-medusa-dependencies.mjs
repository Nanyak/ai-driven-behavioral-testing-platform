import {
  isTcpOpen,
  loadPhase1Env,
  parsePortFromUrl,
  run,
  waitForTcp,
} from "./lib/phase1-utils.mjs";

const env = loadPhase1Env();
const postgresPort = Number(env.POSTGRES_PORT || 5432);
const redisPort = parsePortFromUrl(env.REDIS_URL || "redis://localhost:6379", 6379);

function dockerInspect(name) {
  const result = run("docker", ["inspect", "-f", "{{.State.Running}}", name], {
    stdio: "pipe",
  });
  return result.stdout.trim() === "true";
}

function ensureContainer({ name, image, port, internalPort, envVars = [] }) {
  try {
    if (dockerInspect(name)) {
      console.log(`${name} is already running.`);
      return;
    }
    run("docker", ["start", name]);
    console.log(`Started existing ${name} container.`);
    return;
  } catch {
    // The container may not exist yet. Create it below.
  }

  run("docker", [
    "run",
    "--name",
    name,
    ...envVars.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
    "-p",
    `${port}:${internalPort}`,
    "-d",
    image,
  ]);
  console.log(`Created and started ${name}.`);
}

if (await isTcpOpen("localhost", postgresPort)) {
  console.log(`PostgreSQL is reachable on localhost:${postgresPort}.`);
} else {
  ensureContainer({
    name: "behavior-medusa-postgres",
    image: "postgres:15",
    port: postgresPort,
    internalPort: 5432,
    envVars: [
      ["POSTGRES_DB", env.POSTGRES_DB || "medusa"],
      ["POSTGRES_USER", env.POSTGRES_USER || "medusa"],
      ["POSTGRES_PASSWORD", env.POSTGRES_PASSWORD || "medusa"],
    ],
  });
  await waitForTcp("localhost", postgresPort, "PostgreSQL");
}

if (await isTcpOpen("localhost", redisPort)) {
  console.log(`Redis is reachable on localhost:${redisPort}.`);
} else {
  ensureContainer({
    name: "behavior-medusa-redis",
    image: "redis:7",
    port: redisPort,
    internalPort: 6379,
  });
  await waitForTcp("localhost", redisPort, "Redis");
}

console.log("Medusa Phase 1 dependencies are ready.");
