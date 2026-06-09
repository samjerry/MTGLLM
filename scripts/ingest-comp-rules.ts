/**
 * MTG Comprehensive Rules Ingestion Script
 *
 * Fetches the latest Comp Rules from Wizards, chunks by rule number hierarchy,
 * embeds using Google Gemini, and upserts into pgvector on Railway.
 *
 * Usage:
 *   npx tsx scripts/ingest-comp-rules.ts
 *
 * Required env vars:
 *   DATABASE_URL      - Railway Postgres connection string
 *   GEMINI_API_KEY    - Google AI Studio API key
 */

import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const RULES_URL_TEMPLATE = (year: number) =>
  `https://media.wizards.com/${year}/downloads/MagicCompRules.txt`;

const EMBEDDING_MODEL = "text-embedding-004"; // Gemini free-tier embedding model
const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 50; // Gemini embedding API batch limit

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RuleChunk {
  rule_number: string;   // e.g. "100.1a"
  parent_rule: string;   // e.g. "100.1" or "100" depending on depth
  section_title: string; // e.g. "Game Concepts"
  text: string;          // full text of this rule
}

// ---------------------------------------------------------------------------
// Fetch Comp Rules text
// ---------------------------------------------------------------------------

async function fetchCompRules(): Promise<string> {
  const currentYear = new Date().getFullYear();

  for (const year of [currentYear, currentYear - 1]) {
    const url = RULES_URL_TEMPLATE(year);
    console.log(`Trying: ${url}`);

    const res = await fetch(url);
    if (res.ok) {
      console.log(`Fetched Comp Rules from ${year} URL.`);
      return await res.text();
    }

    console.warn(`  ${res.status} — trying previous year...`);
  }

  throw new Error("Could not fetch Comp Rules for current or previous year.");
}

// ---------------------------------------------------------------------------
// Parse and chunk by rule number hierarchy
// ---------------------------------------------------------------------------

function chunkRules(raw: string): RuleChunk[] {
  const chunks: RuleChunk[] = [];
  const lines = raw.split(/\r?\n/);

  // Rule lines look like: "100.1a Some rule text here."
  // Section headers look like: "1. Game Concepts" or "100. General"
  const RULE_RE = /^(\d+\.\d+[a-z]?)\s+(.+)/;
  const SECTION_RE = /^(\d+)\.\s+(.+)/;

  let currentSection = "";
  let currentSectionTitle = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect top-level section headers (e.g. "1. Game Concepts")
    const sectionMatch = trimmed.match(SECTION_RE);
    if (sectionMatch && !trimmed.match(RULE_RE)) {
      currentSection = sectionMatch[1];
      currentSectionTitle = sectionMatch[2];
      continue;
    }

    // Detect individual rule lines
    const ruleMatch = trimmed.match(RULE_RE);
    if (ruleMatch) {
      const ruleNumber = ruleMatch[1]; // e.g. "100.1a"
      const ruleText = ruleMatch[2];

      // Derive parent: "100.1a" -> "100.1", "100.1" -> "100"
      const parentRule = ruleNumber.includes(".")
        ? ruleNumber.replace(/[a-z]$/, "") === ruleNumber
          ? ruleNumber.split(".")[0]
          : ruleNumber.replace(/[a-z]$/, "")
        : ruleNumber;

      chunks.push({
        rule_number: ruleNumber,
        parent_rule: parentRule,
        section_title: currentSectionTitle,
        text: `[${currentSectionTitle}] Rule ${ruleNumber}: ${ruleText}`,
      });
    }
  }

  console.log(`Parsed ${chunks.length} rule chunks.`);
  return chunks;
}

// ---------------------------------------------------------------------------
// Embed chunks using Gemini
// ---------------------------------------------------------------------------

async function embedChunks(
  chunks: RuleChunk[],
  genAI: GoogleGenerativeAI
): Promise<Array<RuleChunk & { embedding: number[] }>> {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const results: Array<RuleChunk & { embedding: number[] }> = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    console.log(
      `Embedding batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(chunks.length / BATCH_SIZE)}...`
    );

    const embeddings = await Promise.all(
      batch.map((chunk) =>
        model
          .embedContent(chunk.text)
          .then((res) => res.embedding.values)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      results.push({ ...batch[j], embedding: embeddings[j] });
    }

    // Small delay to stay within free-tier rate limits
    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Upsert into pgvector
// ---------------------------------------------------------------------------

async function setupSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS comp_rules (
      id            SERIAL PRIMARY KEY,
      rule_number   TEXT NOT NULL UNIQUE,
      parent_rule   TEXT NOT NULL,
      section_title TEXT NOT NULL,
      text          TEXT NOT NULL,
      embedding     vector(${EMBEDDING_DIMENSIONS}),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log("Schema ready.");
}

async function createIndex(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS comp_rules_embedding_idx
    ON comp_rules
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  `);
  console.log("Index created.");
}

async function upsertChunks(
  pool: Pool,
  chunks: Array<RuleChunk & { embedding: number[] }>
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const chunk of chunks) {
      await client.query(
        `
        INSERT INTO comp_rules (rule_number, parent_rule, section_title, text, embedding, updated_at)
        VALUES ($1, $2, $3, $4, $5::vector, NOW())
        ON CONFLICT (rule_number)
        DO UPDATE SET
          parent_rule   = EXCLUDED.parent_rule,
          section_title = EXCLUDED.section_title,
          text          = EXCLUDED.text,
          embedding     = EXCLUDED.embedding,
          updated_at    = NOW();
        `,
        [
          chunk.rule_number,
          chunk.parent_rule,
          chunk.section_title,
          chunk.text,
          JSON.stringify(chunk.embedding),
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`Upserted ${chunks.length} chunks into pgvector.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!databaseUrl) throw new Error("Missing DATABASE_URL env var.");
  if (!geminiKey) throw new Error("Missing GEMINI_API_KEY env var.");

  const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
  const genAI = new GoogleGenerativeAI(geminiKey);

  try {
    // 1. Fetch
    const raw = await fetchCompRules();

    // 2. Chunk
    const chunks = chunkRules(raw);

    // 3. Setup schema
    await setupSchema(pool);

    // 4. Embed
    const embeddedChunks = await embedChunks(chunks, genAI);

    // 5. Upsert
    await upsertChunks(pool, embeddedChunks);

    // 6. Create index after data is present so IVFFlat builds meaningful lists
    await createIndex(pool);

    console.log("Ingestion complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
