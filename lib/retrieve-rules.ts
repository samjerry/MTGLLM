/**
 * MTG Comprehensive Rules Retrieval
 *
 * Takes a natural language query, embeds it with Gemini,
 * and returns the top-k most relevant rule chunks from pgvector.
 *
 * Usage:
 *   import { retrieveRules } from "./retrieve-rules";
 *   const chunks = await retrieveRules("does deathtouch work through indestructible?");
 */

import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-004";
const DEFAULT_TOP_K = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuleResult {
  rule_number: string;
  parent_rule: string;
  section_title: string;
  text: string;
  similarity: number; // cosine similarity, 0-1
}

// ---------------------------------------------------------------------------
// Singletons -- use global to survive Next.js hot reloads in dev
// ---------------------------------------------------------------------------

const g = global as typeof global & {
  _mtgRulesPool?: Pool;
  _mtgRulesGenAI?: GoogleGenerativeAI;
};

function getPool(): Pool {
  if (!g._mtgRulesPool) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("Missing DATABASE_URL env var.");
    g._mtgRulesPool = new Pool({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    });
  }
  return g._mtgRulesPool;
}

function getGenAI(): GoogleGenerativeAI {
  if (!g._mtgRulesGenAI) {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error("Missing GEMINI_API_KEY env var.");
    g._mtgRulesGenAI = new GoogleGenerativeAI(geminiKey);
  }
  return g._mtgRulesGenAI;
}

// ---------------------------------------------------------------------------
// Embed a query string
// ---------------------------------------------------------------------------

async function embedQuery(query: string): Promise<number[]> {
  const model = getGenAI().getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent(query);
  return result.embedding.values;
}

// ---------------------------------------------------------------------------
// Retrieve top-k rule chunks by cosine similarity
// ---------------------------------------------------------------------------

export async function retrieveRules(
  query: string,
  topK: number = DEFAULT_TOP_K
): Promise<RuleResult[]> {
  const embedding = await embedQuery(query);
  const pool = getPool();

  const { rows } = await pool.query<RuleResult & { similarity: number }>(
    `
    SELECT
      rule_number,
      parent_rule,
      section_title,
      text,
      1 - (embedding <=> $1::vector) AS similarity
    FROM comp_rules
    ORDER BY embedding <=> $1::vector
    LIMIT $2;
    `,
    [JSON.stringify(embedding), topK]
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Retrieve parent rules for context expansion
//
// When a sub-rule (e.g. 702.2b) is retrieved, it often helps to also
// pull in the parent rule (702.2) for full context. Call this after
// retrieveRules to optionally expand the result set.
// ---------------------------------------------------------------------------

export async function expandWithParents(
  results: RuleResult[]
): Promise<RuleResult[]> {
  const pool = getPool();
  const parentNumbers = [
    ...new Set(results.map((r) => r.parent_rule)),
  ].filter(
    (parent) => !results.some((r) => r.rule_number === parent)
  );

  if (parentNumbers.length === 0) return results;

  const { rows } = await pool.query<RuleResult>(
    `
    SELECT
      rule_number,
      parent_rule,
      section_title,
      text,
      1.0 AS similarity
    FROM comp_rules
    WHERE rule_number = ANY($1);
    `,
    [parentNumbers]
  );

  // Return retrieved chunks first, parents appended after
  return [...results, ...rows];
}

// ---------------------------------------------------------------------------
// Format results into a context block for LLM prompts
// ---------------------------------------------------------------------------

export function formatRulesContext(results: RuleResult[]): string {
  return results
    .map(
      (r) =>
        `Rule ${r.rule_number} [${r.section_title}]:\n${r.text}`
    )
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Convenience: retrieve, expand, and format in one call
// ---------------------------------------------------------------------------

export async function getRulesContext(
  query: string,
  topK: number = DEFAULT_TOP_K,
  expandParents: boolean = true
): Promise<string> {
  const results = await retrieveRules(query, topK);
  const expanded = expandParents ? await expandWithParents(results) : results;
  return formatRulesContext(expanded);
}
