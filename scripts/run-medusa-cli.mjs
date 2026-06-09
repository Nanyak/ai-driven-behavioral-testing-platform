import { runMedusaCli } from "./lib/phase1-utils.mjs";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-medusa-cli.mjs <medusa-command> [...args]");
  process.exit(1);
}

runMedusaCli(args);
