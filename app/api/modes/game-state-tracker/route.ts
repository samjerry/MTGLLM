/**
 * MTG Game State Tracker Mode API Route
 * Place at: app/api/modes/game-state-tracker/route.ts
 *
 * POST /api/modes/game-state-tracker
 * Body: {
 *   question: string,
 *   game_state: GameState | null,       -- null on first message
 *   history?: { role: "user" | "model", text: string }[]
 * }
 * Returns: {
 *   answer: string,
 *   updated_state: GameState,           -- always returned, even if unchanged
 *   state_changed: boolean,
 *   rules_used: string[]
 * }
 *
 * On first message (game_state null), the LLM structures the user's
 * natural language description into a GameState JSON.
 * On subsequent messages, it updates the state and answers the question.
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getRulesContext, retrieveRules } from "@/lib/retrieve-rules";
import {
  GameState,
  createDefaultGameState,
  validateGameState,
  summarizeGameState,
} from "@/lib/game-state";

const GEMINI_MODEL = "gemini-1.5-flash";

// ---------------------------------------------------------------------------
// Step 1: Structure natural language into a GameState JSON
// ---------------------------------------------------------------------------

async function structureInitialState(
  description: string,
  genAI: GoogleGenerativeAI
): Promise<GameState> {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: `You are a Magic: The Gathering game state parser.
The user will describe a game state in natural language. Convert it into a valid JSON object matching this TypeScript type:

interface GameState {
  players: Array<{
    name: string;
    life: number;
    poison_counters: number;
    energy_counters: number;
    mana_pool: { W: number; U: number; B: number; R: number; G: number; C: number };
    hand_count: number;
    hand_cards?: string[];
    library_count: number;
    battlefield: Array<{
      name: string;
      tapped: boolean;
      counters?: Record<string, number>;
      attached_to?: string;
      tokens?: boolean;
      notes?: string;
    }>;
    graveyard: string[];
    exile: string[];
    command_zone?: string[];
    commander_tax?: number;
    monarch?: boolean;
  }>;
  active_player: string;
  priority_player: string;
  phase: "beginning" | "precombat_main" | "combat" | "postcombat_main" | "ending";
  step: "untap" | "upkeep" | "draw" | "precombat_main" | "beginning_of_combat" | "declare_attackers" | "declare_blockers" | "combat_damage" | "end_of_combat" | "postcombat_main" | "end" | "cleanup";
  turn_number: number;
  stack: Array<{ type: "spell" | "ability"; description: string; controller: string }>;
  format?: string;
  notes?: string;
  version: number;
}

Rules:
- Default life is 20 (40 for Commander).
- Default hand_count is 7, library_count is 53 (60-card deck minus 7).
- Default version is 1.
- Use player names as given, or "Player 1", "Player 2" etc. if not specified.
- Infer format from context (Commander = 40 life, command zones present).
- Respond ONLY with the JSON object, no preamble, no markdown fences.`,
  });

  try {
    const result = await model.generateContent(description);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as GameState;

    const { valid, errors } = validateGameState(parsed);
    if (!valid) {
      console.warn("Initial state validation errors:", errors);
      // Fall back to a minimal default with 2 players
      return createDefaultGameState(["Player 1", "Player 2"]);
    }

    return parsed;
  } catch (err) {
    console.warn("Failed to parse initial game state:", err);
    return createDefaultGameState(["Player 1", "Player 2"]);
  }
}

// ---------------------------------------------------------------------------
// Step 2: Update game state based on an action
// ---------------------------------------------------------------------------

async function updateGameState(
  currentState: GameState,
  action: string,
  genAI: GoogleGenerativeAI
): Promise<{ updatedState: GameState; stateChanged: boolean }> {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: `You are a Magic: The Gathering game state updater.
You will receive a current game state as JSON and a player action or game event.
Apply the action to the state and return the updated state as JSON.

Rules:
- Increment version by 1 if any field changes.
- Update life totals, battlefield, stack, phase, step, counters, and other fields as appropriate.
- Remove resolved spells/abilities from the stack.
- Tap/untap lands and creatures as described.
- Move cards between zones (hand, battlefield, graveyard, exile) as described.
- If nothing changes, return the state unchanged with the same version.
- Respond ONLY with the updated JSON object, no preamble, no markdown fences.`,
  });

  try {
    const prompt = `Current game state:
${JSON.stringify(currentState, null, 2)}

Action/event: "${action}"

Return the updated game state JSON.`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const clean = raw.replace(/```json|```/g, "").trim();
    const updated = JSON.parse(clean) as GameState;

    const { valid } = validateGameState(updated);
    if (!valid) return { updatedState: currentState, stateChanged: false };

    const stateChanged = updated.version > currentState.version;
    return { updatedState: updated, stateChanged };
  } catch {
    return { updatedState: currentState, stateChanged: false };
  }
}

// ---------------------------------------------------------------------------
// System prompt for game state Q&A
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  stateSummary: string,
  rulesContext: string
): string {
  return `You are an expert Magic: The Gathering game state advisor.

CURRENT GAME STATE:
${stateSummary}

RELEVANT RULES:
${rulesContext || "No specific rules retrieved."}

INSTRUCTIONS:
- Answer questions about the current game state accurately.
- When resolving stack items, walk through them top to bottom.
- Explain triggered abilities that would fire as a result of the described action.
- Note state-based actions that apply (e.g. a creature with 0 toughness going to the graveyard).
- When a player takes an action, describe its full resolution including any triggers.
- Reference specific rule numbers for non-obvious interactions.
- If the game state is incomplete or ambiguous, ask for the missing information.
- Keep track of priority and who can respond at each point.
- For combat, walk through declare attackers, declare blockers, and damage assignment in order.`;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, game_state, history = [] } = body as {
      question: string;
      game_state: GameState | null;
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

    // 1. Structure initial state if none exists
    let currentState: GameState;
    if (!game_state) {
      currentState = await structureInitialState(question, genAI);
    } else {
      currentState = game_state;
    }

    // 2. If we have an existing state, update it and retrieve rules in parallel
    let updatedState = currentState;
    let stateChanged = false;
    let rulesContextRaw = "";
    let rawRuleResults: { rule_number: string }[] = [];

    if (game_state) {
      const [updateResult, rulesContext, ruleResults] = await Promise.all([
        updateGameState(currentState, question, genAI),
        getRulesContext(question, 5, true),
        retrieveRules(question, 5),
      ]);
      updatedState = updateResult.updatedState;
      stateChanged = updateResult.stateChanged;
      rulesContextRaw = rulesContext;
      rawRuleResults = ruleResults;
    } else {
      [rulesContextRaw, rawRuleResults] = await Promise.all([
        getRulesContext(question, 5, true),
        retrieveRules(question, 5),
      ]);
    }

    const rulesUsed = rawRuleResults.map((r: { rule_number: string }) => r.rule_number);
    const stateSummary = summarizeGameState(updatedState);

    // 4. Build prompt and call Gemini for the natural language answer
    const systemPrompt = buildSystemPrompt(stateSummary, rulesContextRaw);

    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: systemPrompt,
    });

    const chat = model.startChat({
      history: history.map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.text }],
      })),
    });

    // On first message, ask for confirmation of the structured state
    const userMessage =
      !game_state
        ? `${question}\n\nI've structured the game state from your description. Please confirm it looks correct and let me know if anything needs adjusting.`
        : question;

    const result = await chat.sendMessage(userMessage);
    const answer = result.response.text();

    return NextResponse.json({
      answer,
      updated_state: updatedState,
      state_changed: stateChanged,
      rules_used: rulesUsed,
    });
  } catch (err) {
    console.error("Game state tracker error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
