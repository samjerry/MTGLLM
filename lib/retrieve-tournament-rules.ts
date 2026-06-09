/**
 * Tournament Rules Retrieval
 * Place at: lib/retrieve-tournament-rules.ts
 *
 * Retrieves relevant chunks from the MTR and IPG pgvector tables.
 * Mirrors the pattern from lib/retrieve-rules.ts for the Comp Rules.
 */

import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

const EMBEDDING_MODEL = "text-embedding-004";
const DEFAULT_TOP_K = 5;

export interface PolicyResult {
  section_number: string;
  section_title: string;
  parent_section: string;
  text: string;
  similarity: number;
  source: "mtr" | "ipg";
}

// Singletons -- use global to survive Next.js hot reloads in dev
const g = global as typeof global & {
  _mtgPolicyPool?: Pool;
  _mtgPolicyGenAI?: GoogleGenerativeAI;
};

function getPool(): Pool {
  if (!g._mtgPolicyPool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("Missing DATABASE_URL env var.");
    g._mtgPolicyPool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  }
  return g._mtgPolicyPool;
}

function getGenAI(): GoogleGenerativeAI {
  if (!g._mtgPolicyGenAI) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("Missing GEMINI_API_KEY env var.");
    g._mtgPolicyGenAI = new GoogleGenerativeAI(geminiKey);
  }
  return g._mtgPolicyGenAI;
}

async function embedQuery(query: string): Promise<number[]> {
  const model = getGenAI().getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent(query);
  return result.embedding.values;
}

export async function retrieveFromTable(
  query: string,
  table: "tournament_rules" | "infraction_guide",
  topK = DEFAULT_TOP_K
): Promise<PolicyResult[]> {
  const embedding = await embedQuery(query);
  const pool = getPool();
  const source = table === "tournament_rules" ? "mtr" : "ipg";

  const { rows } = await pool.query(
    `
    SELECT
      section_number,
      section_title,
      parent_section,
      text,
      1 - (embedding <=> $1::vector) AS similarity
    FROM ${table}
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
    `,
    [JSON.stringify(embedding), topK]
  );

  return rows.map((r: PolicyResult) => ({ ...r, source }));
}

// Retrieve from both MTR and IPG, merge and sort by similarity
export async function retrievePolicyContext(
  query: string,
  topK = DEFAULT_TOP_K
): Promise<{ context: string; sections_used: string[] }> {
  const [mtrResults, ipgResults] = await Promise.all([
    retrieveFromTable(query, "tournament_rules", topK),
    retrieveFromTable(query, "infraction_guide", topK),
  ]);

  const merged = [...mtrResults, ...ipgResults]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK * 2);

  const context = merged
    .map(
      (r) =>
        `[${r.source.toUpperCase()}] Section ${r.section_number} — ${r.section_title}:\n${r.text}`
    )
    .join("\n\n");

  const sections_used = merged.map(
    (r) => `${r.source.toUpperCase()} ${r.section_number}`
  );

  return { context, sections_used };
}
