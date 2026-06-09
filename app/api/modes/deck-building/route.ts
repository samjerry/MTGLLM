/**
 * MTG Deck Building Mode API Route
 * Place at: app/api/modes/deck-building/route.ts
 *
 * POST /api/modes/deck-building
 * Body: {
 *   question: string,
 *   history?: { role: "user" | "model", text: string }[]
 * }
 * Returns: {
 *   answer: string,
 *   cards_fetched: string[],
 *   unverified_cards: string[]   // suggested by LLM but not found on Scryfall
 * }
 *
 * Supports:
 *   - Free-form deck requests ("build me a [[Atraxa]] commander deck")
 *   - Pasted card lists for improvement
 *   - [[Card Name]] and [[UB]] bracket syntax
 *   - Format legality checks via Scryfall data
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  parseBrackets,
  fetchCardsByName,
  fetchCardsByColorIdentity,
  extractCardNamesGemini,
  formatCardContext,
  formatColorIdentityContext,
  ScryfallCard,
} from "@/lib/scryfall";

const GEMINI_MODEL = "gemini-1.5-flash";

// ---------------------------------------------------------------------------
// Step 1: Extract deck building intent from the message
// ---------------------------------------------------------------------------

interface DeckIntent {
  commander?: string;
  format?: string;
  colors?: string;
  strategy?: string;
  card_list?: string[];
}

async function extractDeckIntent(
  message: string,
  genAI: GoogleGenerativeAI
): Promise<DeckIntent> {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: `You are a Magic: The Gathering deck intent extractor.
Extract the following from the user message and respond ONLY with a JSON object, no preamble, no markdown:
{
  "commander": "<commander card name if mentioned, else null>",
  "format": "<format if mentioned (Standard, Modern, Legacy, Vintage, Commander, Pioneer, Pauper, etc.), else null>",
  "colors": "<color identity string in WUBRG order if mentioned or inferable, e.g. 'UB', else null>",
  "strategy": "<short description of the deck strategy or theme, else null>",
  "card_list": ["<card names if the user pasted a list, else empty array>"]
}`,
    });

    const result = await model.generateContent(message);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as DeckIntent;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Step 2: First LLM pass -- get card suggestions
// ---------------------------------------------------------------------------

async function getSuggestedCards(
  message: string,
  intent: DeckIntent,
  seedCardContext: string,
  genAI: GoogleGenerativeAI
): Promise<string[]> {
  try {
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: `You are a Magic: The Gathering deck building expert.
Given a deck building request, output a JSON array of card names to suggest or include in the deck.
Respond ONLY with a JSON array of strings, no preamble, no markdown.
Include: key synergy pieces, ramp, removal, draw, win conditions.
Limit to 30 cards maximum. Use exact card names.
Example: ["Sol Ring", "Arcane Signet", "Cyclonic Rift"]`,
    });

    const prompt = `Deck request: ${message}

${intent.commander ? `Commander: ${intent.commander}` : ""}
${intent.format ? `Format: ${intent.format}` : ""}
${intent.colors ? `Colors: ${intent.colors}` : ""}
${intent.strategy ? `Strategy: ${intent.strategy}` : ""}
${seedCardContext ? `Known cards in the deck:\n${seedCardContext}` : ""}

Suggest cards for this deck.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as string[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Step 3: Verify suggestions against Scryfall and build final context
// ---------------------------------------------------------------------------

interface VerificationResult {
  verifiedCards: ScryfallCard[];
  unverifiedCards: string[];
  cardContext: string;
}

async function verifySuggestions(
  suggestedNames: string[],
  existingCardNames: string[]
): Promise<VerificationResult> {
  // Only verify cards not already fetched
  const toVerify = suggestedNames.filter(
    (n) => !existingCardNames.includes(n)
  );

  if (toVerify.length === 0) {
    return { verifiedCards: [], unverifiedCards: [], cardContext: "" };
  }

  const fetched = await fetchCardsByName(toVerify);
  const verifiedCards: ScryfallCard[] = [];
  const unverifiedCards: string[] = [];

  for (const [name, card] of Object.entries(fetched)) {
    if (card) {
      verifiedCards.push(card);
    } else {
      unverifiedCards.push(name);
    }
  }

  const cardContext = verifiedCards
    .map(formatCardContext)
    .join("\n\n---\n\n");

  return { verifiedCards, unverifiedCards, cardContext };
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  seedContext: string,
  suggestedContext: string,
  intent: DeckIntent,
  unverifiedCards: string[]
): string {
  const unverifiedNote =
    unverifiedCards.length > 0
      ? `\nNOTE: The following suggested card names could not be verified on Scryfall and should be treated with caution or omitted: ${unverifiedCards.join(", ")}`
      : "";

  return `You are an expert Magic: The Gathering deck builder.

Your job is to help build, improve, and evaluate decks with concrete, actionable advice.

${intent.commander ? `COMMANDER: ${intent.commander}` : ""}
${intent.format ? `FORMAT: ${intent.format}` : ""}
${intent.colors ? `COLOR IDENTITY: ${intent.colors}` : ""}
${intent.strategy ? `STRATEGY: ${intent.strategy}` : ""}

KNOWN CARDS IN THE DECK (fetched from Scryfall):
${seedContext || "None provided."}

SUGGESTED CARDS (verified against Scryfall):
${suggestedContext || "None."}
${unverifiedNote}

INSTRUCTIONS:
- Recommend cards by name and explain why they fit the deck's strategy.
- Group suggestions by role: ramp, card draw, removal, win conditions, synergy pieces.
- Note format legality issues if a format was specified.
- For Commander decks, flag cards that fall outside the commander's color identity.
- If the user pasted a card list, identify weaknesses and suggest targeted improvements.
- Be specific about why each card is good in context -- avoid generic "good stuff" lists.
- If a card was unverified, do not include it in your final recommendations.
- Suggest a mana curve target appropriate for the format and strategy.`;
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

    // 1. Extract intent and bracket tokens in parallel
    const brackets = parseBrackets(question);
    const bracketCardNames = brackets
      .filter((b) => b.type === "card")
      .map((b) => b.value);
    const bracketColors = brackets.filter((b) => b.type === "color_identity");

    const strippedMessage = question.replace(/\[\[[^\]]+\]\]/g, "").trim();

    const [intent, extractedNames] = await Promise.all([
      extractDeckIntent(question, genAI),
      strippedMessage.length > 3
        ? extractCardNamesGemini(strippedMessage, genAI)
        : Promise.resolve([]),
    ]);

    // 2. Fetch seed cards (explicitly mentioned)
    const allSeedNames = [
      ...new Set([
        ...bracketCardNames,
        ...extractedNames,
        ...(intent.card_list ?? []),
        ...(intent.commander ? [intent.commander] : []),
      ]),
    ];

    const seedColorPromises = bracketColors.map((b) =>
      fetchCardsByColorIdentity(b.value, 10)
    );

    const [seedFetched, ...colorResults] = await Promise.all([
      allSeedNames.length > 0 ? fetchCardsByName(allSeedNames) : Promise.resolve({}),
      ...seedColorPromises,
    ]);

    const seedCards = Object.values(seedFetched).filter(Boolean) as ScryfallCard[];
    const seedCardNames = seedCards.map((c) => c.name);

    const seedContext = [
      ...seedCards.map(formatCardContext),
      ...bracketColors.map((b, i) =>
        formatColorIdentityContext(b.value, colorResults[i])
      ),
    ].join("\n\n---\n\n");

    // 3. Get LLM card suggestions
    const suggestedNames = await getSuggestedCards(
      question,
      intent,
      seedContext,
      genAI
    );

    // 4. Verify suggestions against Scryfall
    const { verifiedCards, unverifiedCards, cardContext: suggestedContext } =
      await verifySuggestions(suggestedNames, seedCardNames);

    const allFetchedNames = [
      ...seedCardNames,
      ...verifiedCards.map((c) => c.name),
    ];

    // 5. Build final prompt and call Gemini
    const systemPrompt = buildSystemPrompt(
      seedContext,
      suggestedContext,
      intent,
      unverifiedCards
    );

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
      unverified_cards: unverifiedCards,
    });
  } catch (err) {
    console.error("Deck building error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
