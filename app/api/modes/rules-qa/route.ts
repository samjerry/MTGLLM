/**
 * MTG Rules Q&A API Route
 * Place at: app/api/modes/rules-qa/route.ts
 *
 * POST /api/modes/rules-qa
 * Body: { question: string, history?: { role: "user" | "model", text: string }[] }
 * Returns: { answer: string, rules_used: string[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getRulesContext, retrieveRules } from "@/lib/retrieve-rules";

const GEMINI_MODEL = "gemini-1.5-flash";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(rulesContext: string): string {
  return `You are an expert Magic: The Gathering rules advisor with deep knowledge of the Comprehensive Rules.

Your job is to answer rules questions accurately and clearly, citing specific rule numbers where relevant.

RULES CONTEXT (retrieved from the official Comprehensive Rules):
${rulesContext}

INSTRUCTIONS:
- Base your answer primarily on the rules context provided above.
- Always cite the specific rule number(s) that support your answer (e.g. "Rule 702.2b states...").
- If the context does not contain enough information to answer confidently, say so clearly and suggest the player consult a judge.
- Do not speculate or invent rule interactions not supported by the context.
- Keep answers concise but complete. Use plain language where possible, but preserve technical MTG terminology where it matters.
- If the question involves a specific card, note that card-specific rulings may apply beyond the Comprehensive Rules.
- Format rule citations inline, not as footnotes.`;
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

    // 1. Retrieve relevant rules
    const [rulesContext, rawResults] = await Promise.all([
      getRulesContext(question, 5, true),
      retrieveRules(question, 5),
    ]);

    const rulesUsed = rawResults.map((r) => r.rule_number);

    // 2. Build prompt
    const systemPrompt = buildSystemPrompt(rulesContext);

    // 3. Build conversation history for multi-turn support
    const genAI = new GoogleGenerativeAI(geminiKey);
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

    // 4. Send question
    const result = await chat.sendMessage(question);
    const answer = result.response.text();

    return NextResponse.json({ answer, rules_used: rulesUsed });
  } catch (err) {
    console.error("Rules Q&A error:", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 }
    );
  }
}
