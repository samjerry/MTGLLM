#!/usr/bin/env tsx
/**
 * Railway build script
 * Place at: scripts/build.ts
 *
 * Runs as part of the Railway build process.
 * Conditionally runs ingestion scripts when INGEST_ON_DEPLOY=true.
 *
 * To trigger ingestion on next deploy:
 *   1. Set INGEST_ON_DEPLOY=true in Railway environment variables
 *   2. Push your code
 *   3. After deploy succeeds, set INGEST_ON_DEPLOY=false (or delete the var)
 */

import { execSync } from "child_process";

function run(cmd: string) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

async function main() {
  const shouldIngest = process.env.INGEST_ON_DEPLOY === "true";

  if (shouldIngest) {
    console.log("INGEST_ON_DEPLOY=true -- running ingestion scripts...\n");

    console.log("--- Ingesting Comprehensive Rules ---");
    run("npx tsx scripts/ingest-comp-rules.ts");

    console.log("\n--- Ingesting Tournament Rules (MTR + IPG) ---");
    run("npx tsx scripts/ingest-tournament-rules.ts");

    console.log("\nIngestion complete.");
  } else {
    console.log("INGEST_ON_DEPLOY not set -- skipping ingestion.");
  }
}

main().catch((err) => {
  console.error("Build script failed:", err);
  process.exit(1);
});
