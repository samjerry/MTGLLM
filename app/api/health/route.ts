/**
 * Health check endpoint
 * Place at: app/api/health/route.ts
 *
 * Used by Railway's healthcheck to confirm the app is running.
 * Also verifies database connectivity so Railway catches boot failures early.
 */

import { NextResponse } from "next/server";
import { Pool } from "pg";

export async function GET() {
  const checks: Record<string, "ok" | "error"> = {
    app: "ok",
    database: "error",
  };

  try {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });

    await pool.query("SELECT 1");
    await pool.end();
    checks.database = "ok";
  } catch {
    // Database check failed -- still return 200 so Railway doesn't
    // restart the app in a loop, but flag the issue in the response body
    checks.database = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");

  return NextResponse.json(
    { status: allOk ? "ok" : "degraded", checks },
    { status: allOk ? 200 : 503 }
  );
}
