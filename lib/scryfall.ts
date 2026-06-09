/**
 * Scryfall Utilities
 * Place at: lib/scryfall.ts
 *
 * Handles card lookups, color identity searches, and oracle text fetching.
 * All requests respect Scryfall's rate limit guidance (50-100ms delay between calls).
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScryfallCard {
  id: string;
  name: string;
  mana_cost?: string;
  type_line: string;
  oracle_text?: string;
  colors?: string[];
  color_identity: string[];
  keywords: string[];
  legalities: Record<string, string>;
  set: string;
  rarity: string;
  edhrec_rank?: number;
}

export interface ParsedBracket {
  raw: string;         // e.g. "[[Doubling Season]]" or "[[UB]]"
  type: "card" | "color_identity";
  value: string;       // e.g. "Doubling Season" or "UB"
}

// Recognized color identity strings (WUBRG order)
const COLOR_IDENTITY_RE = /^[WUBRGwubrg]{1,5}$/;

// ---------------------------------------------------------------------------
// Bracket parser
// ---------------------------------------------------------------------------

export function parseBrackets(message: string): ParsedBracket[] {
  const matches = [...message.matchAll(/\[\[([^\]]+)\]\]/g)];

  return matches.map((m) => {
    const value = m[1].trim();
    const isColor = COLOR_IDENTITY_RE.test(value);
    return {
      raw: m[0],
      type: isColor ? "color_identity" : "card",
      value: isColor ? value.toUpperCase() : value,
    };
  });
}

// ---------------------------------------------------------------------------
// Rate-limit helper
// ---------------------------------------------------------------------------

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Fetch a single card by fuzzy name
// ---------------------------------------------------------------------------

export async function fetchCardByName(
  name: string
): Promise<ScryfallCard | null> {
  try {
    const url = `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "MTG-LLM-Assistant/1.0" },
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data as ScryfallCard;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch multiple cards by name (with rate limiting)
// ---------------------------------------------------------------------------

export async function fetchCardsByName(
  names: string[]
): Promise<Record<string, ScryfallCard | null>> {
  const results: Record<string, ScryfallCard | null> = {};

  for (let i = 0; i < names.length; i++) {
    results[names[i]] = await fetchCardByName(names[i]);
    if (i < names.length - 1) await delay(80);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Fetch cards by exact color identity from Scryfall search
// e.g. "UB" -> cards with color_identity exactly {U, B}
// ---------------------------------------------------------------------------

export async function fetchCardsByColorIdentity(
  colors: string,
  limit = 10
): Promise<ScryfallCard[]> {
  try {
    // Scryfall query: exact color identity using id: syntax
    const colorChars = colors.toUpperCase().split("").join("");
    const query = `id:${colorChars}`;

    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=edhrec`;
    const res = await fetch(url, {
      headers: { "User-Agent": "MTG-LLM-Assistant/1.0" },
    });

    if (!res.ok) return [];
    const data = await res.json();
    return (data.data ?? []).slice(0, limit) as ScryfallCard[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Format a card into a compact context string for LLM prompts
// ---------------------------------------------------------------------------

export function formatCardContext(card: ScryfallCard): string {
  const lines = [
    `**${card.name}** [${card.mana_cost ?? "no cost"}]`,
    `Type: ${card.type_line}`,
  ];

  if (card.oracle_text) {
    lines.push(`Oracle: ${card.oracle_text}`);
  }

  if (card.keywords.length > 0) {
    lines.push(`Keywords: ${card.keywords.join(", ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Format a color identity sample into a context block
// ---------------------------------------------------------------------------

export function formatColorIdentityContext(
  colors: string,
  cards: ScryfallCard[]
): string {
  if (cards.length === 0) {
    return `Color identity ${colors}: No sample cards fetched.`;
  }

  const cardLines = cards.map((c) => `- ${c.name} (${c.type_line})`).join("\n");
  return `Color identity ${colors} sample cards (by EDHRec rank):\n${cardLines}`;
}

// ---------------------------------------------------------------------------
// Extract card names from a message using Gemini
// (for cards mentioned in natural language, not in [[ ]] brackets)
// ---------------------------------------------------------------------------

export async function extractCardNamesGemini(
  message: string,
  genAI: GoogleGenerativeAI
): Promise<string[]> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction:
        'You are a Magic: The Gathering card name extractor. Extract all MTG card names explicitly mentioned in the user message. Respond ONLY with a JSON array of strings, no preamble, no markdown. If no card names are found, respond with [].',
    });

    const result = await model.generateContent(message);
    const text = result.response.text().trim();
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean) as string[];
  } catch {
    return [];
  }
}
