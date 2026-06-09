/**
 * Runtime startup script
 * Place at: scripts/start.ts
 *
 * Runs when Railway starts the container -- at this point internal
 * networking is available so the database is reachable.
 *
 * Conditionally runs ingestion when INGEST_ON_DEPLOY=true,
 * then hands off to Next.js.
 */

import { execSync } from "child_process";
import { resolve } from "path";

function run(cmd: string) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", env: { ...process.env } });
}

async function main() {
  const shouldIngest = process.env.INGEST_ON_DEPLOY === "true";

  if (shouldIngest) {
    console.log("INGEST_ON_DEPLOY=true -- running ingestion before startup...\n");

    const tsxRegister = resolve("node_modules/tsx/dist/esm/index.cjs");
    const compRules = resolve("scripts/ingest-comp-rules.ts");
    const tournamentRules = resolve("scripts/ingest-tournament-rules.ts");

    console.log("--- Ingesting Comprehensive Rules ---");
    run(`node --import ${tsxRegister} ${compRules}`);

    console.log("\n--- Ingesting Tournament Rules (MTR + IPG) ---");
    run(`node --import ${tsxRegister} ${tournamentRules}`);

    console.log("\nIngestion complete. Starting Next.js...\n");
  } else {
    console.log("INGEST_ON_DEPLOY not set -- skipping ingestion. Starting Next.js...\n");
  }

  // Hand off to Next.js
  run("node node_modules/next/dist/bin/next start");
}

main().catch((err) => {
  console.error("Startup failed:", err);
  process.exit(1);
});
