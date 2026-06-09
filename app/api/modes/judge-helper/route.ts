/**
 * MTG Judge Helper Mode API Route
 * Place at: app/api/modes/judge-helper/route.ts
 *
 * POST /api/modes/judge-helper
 * Body: {
 *   question: string,
 *   history?: { role: "user" | "model", text: string }[]
 * }
 * Returns: {
 *   answer: string,
 *   rules_used: string[],
 *   policy_sections_used: string[],
 *   rule_context: "competitive" | "casual" | null  -- set after clarification
 * }
 *
 * On the first message in a conversation (empty history), the LLM asks
 * whether the user needs competitive/tournament rules or casual play rules
 * before retrieving from the appropriate source.
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getRulesContext, retrieveRules } from "@/lib/retrieve-rules";
import { retrievePolicyContext } from "@/lib/retrieve-tournament-rules";

const GEMINI_MODEL = "gemini-1.5-flash";

// ---------------------------------------------------------------------------
// Detect rule context from conversation history
// ---------------------------------------------------------------------------

type RuleContext = "competitive" | "casual" | null;

function detectRuleContext(
  history: { role: string; text: string }[]
): RuleContext {
  // Scan previous assistant and user messages for context signals
  const transcript = history.map((m) => m.text.toLowerCase()).join(" ");

  const competitiveSignals = [
    "tournament", "competitive", "judge", "official", "mtr", "ipg",
    "penalty", "infraction", "game loss", "match loss", "policy",
  ];

  const casualSignals = [
    "casual", "kitchen table", "friendly", "just playing", "at home",
    "no judge", "not a tournament",
  ];

  const hasCompetitive = competitiveSignals.some((s) => transcript.includes(s));
  const hasCasual = casualSignals.some((s) => transcript.includes(s));

  if (hasCompetitive && !hasCasual) return "competitive";
  if (hasCasual && !hasCompetitive) return "casual";
  return null;
}

// ---------------------------------------------------------------------------
// Clarification prompt (first message, no history)
// ---------------------------------------------------------------------------

const CLARIFICATION_SYSTEM_PROMPT = `You are an expert Magic: The Gathering judge assistant.

When a user first contacts you, before answering any rules question, you must ask them ONE clarifying question:

Ask whether they need:
1. Competitive / tournament rules (official MTR, IPG, and Comprehensive Rules -- for sanctioned play, judge calls, penalties, and formal rulings)
2. Casual play rules (Comprehensive Rules only, interpreted for friendly games without tournament policy)

Keep the question short and friendly. Do not answer their rules question yet -- just ask the clarification.`;

// ---------------------------------------------------------------------------
// System prompt for competitive context
// ---------------------------------------------------------------------------

function buildCompetitivePrompt(
  rulesContext: string,
  policyContext: string
): string {
  return `You are an expert Magic: The Gathering judge assistant operating under competitive/tournament rules.

COMPREHENSIVE RULES CONTEXT:
${rulesContext || "No specific rules retrieved."}

TOURNAMENT POLICY CONTEXT (MTR and IPG):
${policyContext || "No specific policy sections retrieved."}

INSTRUCTIONS:
- Apply the full Comprehensive Rules, Magic Tournament Rules (MTR), and Infraction Procedure Guide (IPG).
- For game rules questions, cite specific rule numbers (e.g. "Rule 702.2b").
- For policy questions, cite the relevant MTR or IPG section (e.g. "MTR 2.3", "IPG 2.1").
- When ruling on an infraction, state: the infraction category, the default penalty, and whether a fix applies.
- Use precise judge language: "game loss", "warning", "match loss", "caution", "backup", "fix".
- If a situation is ambiguous or requires a head judge ruling, say so clearly.
- Do not soften tournament penalties -- state them as written in the IPG.
- Note if a ruling differs between Regular, Competitive, and Professional Rules Enforcement Level (REL).`;
}

// ---------------------------------------------------------------------------
// System prompt for casual context
// ---------------------------------------------------------------------------

function buildCasualPrompt(rulesContext: string): string {
  return `You are a friendly Magic: The Gathering rules advisor for casual play.

COMPREHENSIVE RULES CONTEXT:
${rulesContext || "No specific rules retrieved."}

INSTRUCTIONS:
- Apply the Comprehensive Rules as the authoritative source.
- Use clear, accessible language -- avoid overly technical judge jargon.
- When tournament policy would normally apply (e.g. drawing extra cards), explain the common casual table ruling instead.
- Note when the "official" ruling might differ from common casual practice, so the user understands both.
- Cite rule numbers where helpful, but explain them in plain language.
- Keep a friendly, helpful tone -- this is for kitchen table Magic, not a tournament.`;
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

    // 1. If no history, ask the clarification question first
    if (history.length === 0) {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MODEL,
        systemInstruction: CLARIFICATION_SYSTEM_PROMPT,
      });

      const result = await model.generateContent(question);
      const answer = result.response.text();

      return NextResponse.json({
        answer,
        rules_used: [],
        policy_sections_used: [],
        rule_context: null,
        awaiting_clarification: true,
      });
    }

    // 2. Detect rule context from conversation history
    const ruleContext = detectRuleContext([
      ...history,
      { role: "user", text: question },
    ]);

    // 3. If context still unclear, default to competitive (judge helper implies tournament)
    const resolvedContext: "competitive" | "casual" =
      ruleContext ?? "competitive";

    // 4. Retrieve rules -- always fetch Comp Rules
    const [rulesContextRaw, rawRuleResults] = await Promise.all([
      getRulesContext(question, 5, true),
      retrieveRules(question, 5),
    ]);

    const rulesUsed = rawRuleResults.map((r) => r.rule_number);

    // 5. For competitive context, also retrieve MTR/IPG
    let policyContext = "";
    let policySectionsUsed: string[] = [];

    if (resolvedContext === "competitive") {
      const { context, sections_used } = await retrievePolicyContext(question, 5);
      policyContext = context;
      policySectionsUsed = sections_used;
    }

    // 6. Build prompt and call Gemini
    const systemPrompt =
      resolvedContext === "competitive"
        ? buildCompetitivePrompt(rulesContextRaw, policyContext)
        : buildCasualPrompt(rulesContextRaw);

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

    const result = await chat.sendMessage(question);
    const answer = result.response.text();

    return NextResponse.json({
      answer,
      rules_used: rulesUsed,
      policy_sections_used: policySectionsUsed,
      rule_context: resolvedContext,
      awaiting_clarification: false,
    });
  } catch (err) {
    console.error("Judge helper error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
