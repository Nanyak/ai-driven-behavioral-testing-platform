import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

const requiredPaths = [
  "apps/medusa",
  "infra/elasticsearch",
  "infra/logstash",
  "infra/kibana",
  "services/traffic-generator",
  "services/log-ingestion",
  "services/behavior-engine",
  "services/script-generator",
  "services/test-runner",
  "generated-tests",
  "golden-responses",
  "reports",
  "docs/local-development.md",
  "docs/phase-0-implementation-plan.md",
  "context/plan.md",
  "context/checklist.md",
  ".env.example",
  "package.json",
  "apps/medusa/package-lock.json"
];

const requiredEnvKeys = [
  "MEDUSA_BACKEND_URL",
  "MEDUSA_ADMIN_EMAIL",
  "MEDUSA_ADMIN_PASSWORD",
  "MEDUSA_PUBLISHABLE_API_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "ELASTICSEARCH_URL",
  "KIBANA_URL",
  "LOGSTASH_BEATS_URL",
  "LOGSTASH_HTTP_URL"
];

const requiredDocSnippets = [
  "Medusa is the selected backend system under test",
  "The MVP platform services will be written in TypeScript",
  "Medusa backend",
  "Elasticsearch",
  "Kibana"
];

const failures = [];

for (const relativePath of requiredPaths) {
  if (!existsSync(join(root, relativePath))) {
    failures.push(`Missing required path: ${relativePath}`);
  }
}

const envPath = join(root, ".env.example");
if (existsSync(envPath)) {
  const envFile = readFileSync(envPath, "utf8");
  for (const key of requiredEnvKeys) {
    if (!envFile.includes(`${key}=`)) {
      failures.push(`Missing environment key in .env.example: ${key}`);
    }
  }
}

const localDevelopmentPath = join(root, "docs/local-development.md");
if (existsSync(localDevelopmentPath)) {
  const localDevelopment = readFileSync(localDevelopmentPath, "utf8");
  for (const snippet of requiredDocSnippets) {
    if (!localDevelopment.includes(snippet)) {
      failures.push(`Missing documentation snippet: ${snippet}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Phase 0 verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Phase 0 verification passed.");
