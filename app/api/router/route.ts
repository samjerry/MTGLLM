/**
 * MTG Mode Router
 * Place at: app/api/router/route.ts
 *
 * POST /api/router
 * Body: { message: string, selected_mode: Mode }
 * Returns: { mode: Mode, confidence: number, reason: string }
 *
 * The router confirms the user-selected mode or overrides it
 * if the message clearly belongs to a different mode.
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Mode =
  | "rules_qa"
  | "deck_building"
  | "draft_advisor"
  | "judge_helper"
  | "game_state_tracker"
  | "combo_synergy";

export interface RouterResult {
  mode: Mode;
  confidence: number; // 0-1
  reason: string;
  overridden: boolean; // true if router disagreed with selected_mode
}

// ---------------------------------------------------------------------------
// Mode descriptions (used in the classification prompt)
// ---------------------------------------------------------------------------

const MODE_DESCRIPTIONS: Record<Mode, string> = {
  rules_qa:
    "General rules questions about how Magic mechanics work, what happens in a given situation, or how two effects interact under the rules.",
  deck_building:
    "Help building, improving, or evaluating a deck. Includes card suggestions, mana curve advice, win condition analysis, and format legality.",
  draft_advisor:
    "Advice about which card to pick in a draft, how to evaluate cards in limited, or how to build a deck from a draft pool.",
  judge_helper:
    "Formal judge-level rulings, tournament policy, priority and stack questions, or situations where a judge would be called.",
  game_state_tracker:
    "Tracking or updating an active game state: life totals, battlefield, stack, graveyard, turn structure, or resolving a specific in-game situation.",
  combo_synergy:
    "Explaining how a specific combo works, whether two or more cards synergize, or what cards work well with a given card.",
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ROUTER_SYSTEM_PROMPT = `You are a routing classifier for a Magic: The Gathering assistant.

Your job is to classify a user message into exactly one of these modes:

${Object.entries(MODE_DESCRIPTIONS)
  .map(([mode, desc]) => `- ${mode}: ${desc}`)
  .join("\n")}

The user has already selected a mode. You should confirm it unless the message clearly and unambiguously belongs to a different mode. When in doubt, defer to the user's selected mode.

Respond ONLY with a valid JSON object in this exact shape, no preamble, no markdown:
{
  "mode": "<one of the mode keys above>",
  "confidence": <number between 0 and 1>,
  "reason": "<one sentence explaining your classification>"
}`;

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { message, selected_mode } = body as {
      message: string;
      selected_mode: Mode;
    };

    if (!message || typeof message !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid message." },
        { status: 400 }
      );
    }

    if (!selected_mode || !(selected_mode in MODE_DESCRIPTIONS)) {
      return NextResponse.json(
        { error: "Missing or invalid selected_mode." },
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
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: ROUTER_SYSTEM_PROMPT,
    });

    const prompt = `User selected mode: ${selected_mode}
User message: "${message}"

Classify this message.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();

    // Strip markdown fences if Gemini adds them despite instructions
    const clean = raw.replace(/^```json\s*/i, "").replace(/```$/, "").trim();

    let parsed: { mode: Mode; confidence: number; reason: string };
    try {
      parsed = JSON.parse(clean);
    } catch {
      // If parsing fails, fall back to the user's selected mode
      console.warn("Router failed to parse Gemini response, defaulting to selected mode.", raw);
      return NextResponse.json({
        mode: selected_mode,
        confidence: 1.0,
        reason: "Router parse error — defaulting to user-selected mode.",
        overridden: false,
      } satisfies RouterResult);
    }

    // Validate the returned mode is a known value
    if (!(parsed.mode in MODE_DESCRIPTIONS)) {
      parsed.mode = selected_mode;
      parsed.confidence = 1.0;
      parsed.reason = "Router returned unknown mode — defaulting to user-selected mode.";
    }

    const overridden = parsed.mode !== selected_mode;

    // Only override if confidence is high enough
    const finalMode =
      overridden && parsed.confidence >= 0.85 ? parsed.mode : selected_mode;

    return NextResponse.json({
      mode: finalMode,
      confidence: parsed.confidence,
      reason: parsed.reason,
      overridden: finalMode !== selected_mode,
    } satisfies RouterResult);
  } catch (err) {
    console.error("Router error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
