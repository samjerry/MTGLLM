/**
 * MTG Draft Advisor Mode API Route
 * Place at: app/api/modes/draft-advisor/route.ts
 *
 * POST /api/modes/draft-advisor
 * Body: {
 *   question: string,
 *   history?: { role: "user" | "model", text: string }[]
 * }
 * Returns: {
 *   answer: string,
 *   cards_fetched: string[],
 *   draft_context: {
 *     set: string | null,
 *     is_mixed: boolean,
 *     pack_cards: string[],
 *     pool_cards: string[]
 *   }
 * }
 *
 * Supports:
 *   - Single set drafts ("I'm drafting Bloomburrow, pack 1 pick 3")
 *   - Mixed/cube drafts ("this is a cube draft")
 *   - [[Card Name]] bracket syntax for explicit card references
 *   - Free-form pick questions
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  parseBrackets,
  fetchCardsByName,
  extractCardNamesGemini,
  formatCardContext,
  ScryfallCard,
} from "@/lib/scryfall";

const GEMINI_MODEL = "gemini-1.5-flash";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DraftContext {
  set: string | null;
  is_mixed: boolean;
  pack_number?: number;
  pick_number?: number;
  pack_cards: string[];
  pool_cards: string[];
  pool_colors?: string;
}

// ---------------------------------------------------------------------------
// Step 1: Extract draft context from message
// ---------------------------------------------------------------------------

async function extractDraftContext(
  message: string,
  genAI: GoogleGenerativeAI
): Promise<DraftContext> {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: `You are a Magic: The Gathering draft context extractor.
Extract the following from the user message and respond ONLY with a JSON object, no preamble, no markdown:
{
  "set": "<MTG set name if mentioned (e.g. 'Bloomburrow', 'Duskmourn'), else null>",
  "is_mixed": <true if the user mentions cube, mixed set, or multiple sets, else false>,
  "pack_number": <pack number as integer if mentioned, else null>,
  "pick_number": <pick number as integer if mentioned, else null>,
  "pack_cards": ["<card names currently in the pack/on offer, else empty array>"],
  "pool_cards": ["<card names already in the drafter's pool, else empty array>"],
  "pool_colors": "<color identity of current pool if mentioned or inferable, e.g. 'UW', else null>"
}`,
    });

    const result = await model.generateContent(message);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as DraftContext;
  } catch {
    return {
      set: null,
      is_mixed: false,
      pack_cards: [],
      pool_cards: [],
    };
  }
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  draftCtx: DraftContext,
  packCardContext: string,
  poolCardContext: string
): string {
  const setLine = draftCtx.is_mixed
    ? "FORMAT: Cube / Mixed set draft"
    : draftCtx.set
    ? `SET: ${draftCtx.set}`
    : "SET: Unknown (advise generally)";

  const positionLine =
    draftCtx.pack_number && draftCtx.pick_number
      ? `POSITION: Pack ${draftCtx.pack_number}, Pick ${draftCtx.pick_number}`
      : "";

  const poolColorsLine = draftCtx.pool_colors
    ? `CURRENT POOL COLORS: ${draftCtx.pool_colors}`
    : "";

  return `You are an expert Magic: The Gathering draft advisor.

Your job is to help drafters make optimal pick decisions and build strong limited decks.

${setLine}
${positionLine}
${poolColorsLine}

CARDS IN THE CURRENT PACK (fetched from Scryfall):
${packCardContext || "No pack cards specified. Answer based on the question."}

CARDS IN THE DRAFTER'S CURRENT POOL (fetched from Scryfall):
${poolCardContext || "No pool cards specified."}

INSTRUCTIONS:
- Recommend the best pick and explain why, considering:
  * Raw card power level in limited
  * Synergy with the current pool
  * Signals from the pack (what's been passed, what's missing)
  * Pack and pick position (early picks favor power and signals, late picks favor synergy and fixing)
  * Color commitment -- flag if a pick requires a hard color commitment
- For set-specific advice, reference the set's known archetypes and draft format speed.
- For cube drafts, evaluate on raw power and synergy without set-specific context.
- If the pool colors are established, prioritize staying on-color over splashing unless the card is exceptional.
- When comparing multiple cards in a pack, rank them clearly with brief justifications for each.
- Note any cards that are traps in limited despite being strong in constructed.
- If the user asks about building from a pool, group cards by role and suggest a 23-card deck configuration.`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, history = [] } = body as {
      question: string;
      history?: { role: "user" | "model"; text: string }[];
    };

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid question." },
        { status: 400 }
      );
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return NextResponse.json(
        { error: "Server misconfiguration: missing GEMINI_API_KEY." },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(geminiKey);

    // 1. Parse brackets and extract draft context in parallel
    const brackets = parseBrackets(question);
    const bracketCardNames = brackets
      .filter((b) => b.type === "card")
      .map((b) => b.value);

    const strippedMessage = question.replace(/\[\[[^\]]+\]\]/g, "").trim();

    const [draftCtx, extractedNames] = await Promise.all([
      extractDraftContext(question, genAI),
      strippedMessage.length > 3
        ? extractCardNamesGemini(strippedMessage, genAI)
        : Promise.resolve([]),
    ]);

    // 2. Merge all card names -- deduplicate across bracket, extracted, and context sources
    const allPackCards = [
      ...new Set([
        ...bracketCardNames,
        ...extractedNames,
        ...draftCtx.pack_cards,
      ]),
    ];

    const allPoolCards = [
      ...new Set(draftCtx.pool_cards),
    ].filter((c) => !allPackCards.includes(c));

    // 3. Fetch all cards in parallel
    const [packFetched, poolFetched] = await Promise.all([
      allPackCards.length > 0 ? fetchCardsByName(allPackCards) : Promise.resolve({}),
      allPoolCards.length > 0 ? fetchCardsByName(allPoolCards) : Promise.resolve({}),
    ]);

    const packCards = Object.values(packFetched).filter(Boolean) as ScryfallCard[];
    const poolCards = Object.values(poolFetched).filter(Boolean) as ScryfallCard[];

    const packCardContext = packCards.map(formatCardContext).join("\n\n---\n\n");
    const poolCardContext = poolCards.map(formatCardContext).join("\n\n---\n\n");

    const allFetchedNames = [
      ...packCards.map((c) => c.name),
      ...poolCards.map((c) => c.name),
    ];

    // 4. Build prompt and call Gemini
    const systemPrompt = buildSystemPrompt(draftCtx, packCardContext, poolCardContext);

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
      history: history.map((msg) => ({
        role: msg.role,
        parts: [{ text: msg.text }],
      })),
    });

    const result = await chat.sendMessage(question);
    const answer = result.response.text();

    return NextResponse.json({
      answer,
      cards_fetched: [...new Set(allFetchedNames)],
      draft_context: {
        set: draftCtx.set,
        is_mixed: draftCtx.is_mixed,
        pack_cards: packCards.map((c) => c.name),
        pool_cards: poolCards.map((c) => c.name),
      },
    });
  } catch (err) {
    console.error("Draft advisor error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
