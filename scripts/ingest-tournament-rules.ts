/**
 * MTG Tournament Rules Ingestion Script
 * Place at: scripts/ingest-tournament-rules.ts
 *
 * Fetches the Magic Tournament Rules (MTR) and Infraction Procedure Guide (IPG)
 * from Wizards, chunks by section hierarchy, embeds with Gemini,
 * and upserts into two pgvector tables on Railway.
 *
 * Usage:
 *   npx tsx scripts/ingest-tournament-rules.ts
 *
 * Required env vars:
 *   DATABASE_URL    - Railway Postgres connection string
 *   GEMINI_API_KEY  - Google AI Studio API key
 */

import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;
const BATCH_SIZE = 50;

// Wizards publishes the MTR and IPG as PDFs at WPN.
// We scrape the rules page to find current URLs rather than hardcoding dated filenames.
const DOCUMENT_SOURCES = [
  {
    key: "mtr",
    label: "Magic Tournament Rules",
    urlPattern: /https:\/\/media\.wizards\.com\/[^"'\s]+MTG_MTR[^"'\s]+\.pdf/i,
    table: "tournament_rules",
  },
  {
    key: "ipg",
    label: "Infraction Procedure Guide",
    urlPattern: /https:\/\/media\.wizards\.com\/[^"'\s]+MTG_IPG[^"'\s]+\.pdf/i,
    table: "infraction_guide",
  },
];

const WPN_RULES_PAGE = "https://wpn.wizards.com/en/rules-documents";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PolicyChunk {
  section_number: string;
  section_title: string;
  parent_section: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Scrape current PDF URLs from the WPN rules page
// ---------------------------------------------------------------------------

async function findDocumentUrl(
  pattern: RegExp,
  label: string
): Promise<string> {
  console.log(`Scraping WPN rules page for ${label} URL...`);
  const res = await fetch(WPN_RULES_PAGE, {
    headers: { "User-Agent": "MTG-LLM-Assistant/1.0" },
  });

  if (!res.ok) {
    throw new Error(`Could not fetch WPN rules page: ${res.status}`);
  }

  const html = await res.text();
  const match = html.match(pattern);

  if (!match) {
    throw new Error(
      `Could not find ${label} PDF URL on the WPN rules page. ` +
      `Check ${WPN_RULES_PAGE} manually and update DOCUMENT_SOURCES patterns.`
    );
  }

  console.log(`Found ${label} URL: ${match[0]}`);
  return match[0];
}

// ---------------------------------------------------------------------------
// Fetch PDF and extract text using pdf-parse
// ---------------------------------------------------------------------------

async function fetchDocumentText(url: string, label: string): Promise<string> {
  console.log(`Fetching ${label} PDF...`);
  const res = await fetch(url, {
    headers: { "User-Agent": "MTG-LLM-Assistant/1.0" },
  });

  if (!res.ok) {
    throw new Error(`Could not fetch ${label}: ${res.status}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  // Dynamically import pdf-parse to avoid issues with Next.js bundling
  const pdfParse = (await import("pdf-parse")).default;
  const parsed = await pdfParse(buffer);

  console.log(`Extracted ${parsed.text.length} characters from ${label}.`);
  return parsed.text;
}

// ---------------------------------------------------------------------------
// Parse and chunk by section hierarchy
// ---------------------------------------------------------------------------

function chunkDocument(raw: string, sourceLabel: string): PolicyChunk[] {
  const chunks: PolicyChunk[] = [];
  const lines = raw.split(/\r?\n/);

  // Section headers: "1. Introduction", "2.3 Player Responsibilities", "2.3.1 ..."
  const SECTION_RE = /^(\d+(?:\.\d+)*)\s+(.+)/;

  let currentSection = "";
  let currentTitle = "";
  let currentParent = "";
  let buffer: string[] = [];

  function flushBuffer() {
    if (!currentSection || buffer.length === 0) return;
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text.length < 20) return; // Skip trivially short sections

    chunks.push({
      section_number: currentSection,
      section_title: currentTitle,
      parent_section: currentParent,
      text: `[${sourceLabel}] Section ${currentSection} — ${currentTitle}:\n${text}`,
    });
    buffer = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sectionMatch = trimmed.match(SECTION_RE);
    if (sectionMatch) {
      flushBuffer();

      currentSection = sectionMatch[1];
      currentTitle = sectionMatch[2];

      // Derive parent: "2.3.1" -> "2.3", "2.3" -> "2", "2" -> ""
      const parts = currentSection.split(".");
      currentParent = parts.length > 1 ? parts.slice(0, -1).join(".") : "";
    } else {
      buffer.push(trimmed);
    }
  }

  flushBuffer();

  console.log(`Parsed ${chunks.length} chunks from ${sourceLabel}.`);
  return chunks;
}

// ---------------------------------------------------------------------------
// Embed chunks
// ---------------------------------------------------------------------------

async function embedChunks(
  chunks: PolicyChunk[],
  genAI: GoogleGenerativeAI,
  label: string
): Promise<Array<PolicyChunk & { embedding: number[] }>> {
  const model = genAI.getGenerativeModel({ model: EMBEDDING_MODEL });
  const results: Array<PolicyChunk & { embedding: number[] }> = [];

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    console.log(
      `[${label}] Embedding batch ${Math.floor(i / BATCH_SIZE) + 1} / ${Math.ceil(chunks.length / BATCH_SIZE)}...`
    );

    const embeddings = await Promise.all(
      batch.map((chunk) =>
        model.embedContent(chunk.text).then((res) => res.embedding.values)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      results.push({ ...batch[j], embedding: embeddings[j] });
    }

    if (i + BATCH_SIZE < chunks.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Setup schema and upsert
// ---------------------------------------------------------------------------

async function setupTable(pool: Pool, tableName: string): Promise<void> {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id              SERIAL PRIMARY KEY,
      section_number  TEXT NOT NULL UNIQUE,
      section_title   TEXT NOT NULL,
      parent_section  TEXT NOT NULL,
      text            TEXT NOT NULL,
      embedding       vector(${EMBEDDING_DIMENSIONS}),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log(`Table ${tableName} ready.`);
}

async function createIndex(pool: Pool, tableName: string): Promise<void> {
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${tableName}_embedding_idx
    ON ${tableName}
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 50);
  `);
  console.log(`Index on ${tableName} created.`);
}

async function upsertChunks(
  pool: Pool,
  tableName: string,
  chunks: Array<PolicyChunk & { embedding: number[] }>
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const chunk of chunks) {
      await client.query(
        `
        INSERT INTO ${tableName} (section_number, section_title, parent_section, text, embedding, updated_at)
        VALUES ($1, $2, $3, $4, $5::vector, NOW())
        ON CONFLICT (section_number)
        DO UPDATE SET
          section_title  = EXCLUDED.section_title,
          parent_section = EXCLUDED.parent_section,
          text           = EXCLUDED.text,
          embedding      = EXCLUDED.embedding,
          updated_at     = NOW();
        `,
        [
          chunk.section_number,
          chunk.section_title,
          chunk.parent_section,
          chunk.text,
          JSON.stringify(chunk.embedding),
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`Upserted ${chunks.length} chunks into ${tableName}.`);
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

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  const genAI = new GoogleGenerativeAI(geminiKey);

  try {
    for (const source of DOCUMENT_SOURCES) {
      console.log(`\n--- Processing ${source.label} ---`);

      const url = await findDocumentUrl(source.urlPattern, source.label);
      const raw = await fetchDocumentText(url, source.label);
      const chunks = chunkDocument(raw, source.label);

      await setupTable(pool, source.table);

      const embedded = await embedChunks(chunks, genAI, source.label);
      await upsertChunks(pool, source.table, embedded);

      // Create index after data is inserted so IVFFlat builds meaningful lists
      await createIndex(pool, source.table);
    }

    console.log("\nTournament rules ingestion complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
