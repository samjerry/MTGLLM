/**
 * MTG Combo & Synergy Mode API Route
 * Place at: app/api/modes/combo-synergy/route.ts
 *
 * POST /api/modes/combo-synergy
 * Body: {
 *   question: string,
 *   history?: { role: "user" | "model", text: string }[]
 * }
 * Returns: {
 *   answer: string,
 *   cards_fetched: string[],
 *   rules_used: string[]
 * }
 *
 * Supports:
 *   - [[Card Name]] bracket syntax for explicit card lookups
 *   - [[UB]] bracket syntax for exact color identity searches
 *   - LLM-based card name extraction for naturally mentioned cards
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getRulesContext, retrieveRules } from "@/lib/retrieve-rules";
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
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  cardContext: string,
  rulesContext: string
): string {
  return `You are an expert Magic: The Gathering combo and synergy advisor.

Your job is to explain how cards interact, identify combo lines, and suggest synergistic cards.

CARD DATA (fetched live from Scryfall):
${cardContext || "No specific cards were fetched. Use your knowledge of Magic cards."}

RULES CONTEXT (from the Comprehensive Rules):
${rulesContext || "No specific rules were retrieved."}

INSTRUCTIONS:
- Explain combos step by step, in the order they happen on the stack and battlefield.
- Always reference the oracle text of cards when explaining why an interaction works.
- Cite rule numbers when a rules interaction is non-obvious (e.g. state-based actions, replacement effects, triggered abilities).
- If a combo requires specific conditions (e.g. a third card, a specific mana cost), state them clearly.
- If the user asks for color identity suggestions, draw on the sample cards provided and suggest a coherent strategy.
- If a combo is not viable in a specific format, note the format restriction.
- Be precise about infinite loops: state what the loop produces (infinite mana, infinite tokens, etc.) and what ends it.
- Do not invent card text. If unsure about oracle text, say so.`;
}

// ---------------------------------------------------------------------------
// Card context builder
// ---------------------------------------------------------------------------

async function buildCardContext(
  message: string,
  genAI: GoogleGenerativeAI
): Promise<{ context: string; cardNames: string[] }> {
  const brackets = parseBrackets(message);
  const cardNames: string[] = [];
  const contextBlocks: string[] = [];

  // 1. Handle bracket tokens
  const bracketCardNames = brackets
    .filter((b) => b.type === "card")
    .map((b) => b.value);

  const bracketColorIdentities = brackets.filter(
    (b) => b.type === "color_identity"
  );

  // 2. Extract additional card names from natural language
  // Strip bracket tokens from message before extracting to avoid duplication
  const strippedMessage = message.replace(/\[\[[^\]]+\]\]/g, "").trim();
  const extractedNames =
    strippedMessage.length > 3
      ? await extractCardNamesGemini(strippedMessage, genAI)
      : [];

  // Merge and deduplicate card names
  const allCardNames = [
    ...new Set([...bracketCardNames, ...extractedNames]),
  ];

  // 3. Fetch named cards from Scryfall
  if (allCardNames.length > 0) {
    const fetched = await fetchCardsByName(allCardNames);

    for (const [name, card] of Object.entries(fetched)) {
      if (card) {
        cardNames.push(card.name);
        contextBlocks.push(formatCardContext(card));
      } else {
        contextBlocks.push(`**${name}**: Card not found on Scryfall.`);
      }
    }
  }

  // 4. Fetch color identity samples
  for (const bracket of bracketColorIdentities) {
    const cards = await fetchCardsByColorIdentity(bracket.value, 10);
    contextBlocks.push(formatColorIdentityContext(bracket.value, cards));
    cardNames.push(...cards.map((c: ScryfallCard) => c.name));
  }

  return {
    context: contextBlocks.join("\n\n---\n\n"),
    cardNames: [...new Set(cardNames)],
  };
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

    // Run card context building and rules retrieval in parallel
    const [{ context: cardContext, cardNames }, rulesContextRaw, rawRuleResults] =
      await Promise.all([
        buildCardContext(question, genAI),
        getRulesContext(question, 5, true),
        retrieveRules(question, 5),
      ]);

    const rulesUsed = rawRuleResults.map((r) => r.rule_number);
    const systemPrompt = buildSystemPrompt(cardContext, rulesContextRaw);

    // Build chat with history
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
      cards_fetched: cardNames,
      rules_used: rulesUsed,
    });
  } catch (err) {
    console.error("Combo/Synergy error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
