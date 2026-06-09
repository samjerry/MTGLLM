"use client";

/**
 * MTG LLM Assistant - Main Chat UI
 * Place at: app/page.tsx
 *
 * Requires these dependencies:
 *   npm install lucide-react
 *
 * Fonts (add to app/layout.tsx):
 *   import { Cinzel, Crimson_Text } from "next/font/google";
 *   const cinzel = Cinzel({ subsets: ["latin"], variable: "--font-cinzel" });
 *   const crimson = Crimson_Text({ weight: ["400","600"], subsets: ["latin"], variable: "--font-crimson" });
 */

import { useState, useRef, useEffect } from "react";
import {
  BookOpen,
  Swords,
  Layers,
  Scale,
  Cpu,
  Zap,
  Send,
  AlertTriangle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Mode =
  | "rules_qa"
  | "deck_building"
  | "draft_advisor"
  | "judge_helper"
  | "game_state_tracker"
  | "combo_synergy";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  mode: Mode;
  rules_used?: string[];
  overridden?: boolean;
  overridden_to?: Mode;
}

// ---------------------------------------------------------------------------
// Mode config
// ---------------------------------------------------------------------------

const MODES: {
  key: Mode;
  label: string;
  icon: React.ReactNode;
  color: string;
  accent: string;
  description: string;
}[] = [
  {
    key: "rules_qa",
    label: "Rules Q&A",
    icon: <BookOpen size={15} />,
    color: "#7eb8f7",
    accent: "rgba(126,184,247,0.12)",
    description: "Ask how mechanics and rules interactions work",
  },
  {
    key: "deck_building",
    label: "Deck Building",
    icon: <Layers size={15} />,
    color: "#7dd87d",
    accent: "rgba(125,216,125,0.12)",
    description: "Build, improve, and evaluate decks",
  },
  {
    key: "draft_advisor",
    label: "Draft Advisor",
    icon: <Swords size={15} />,
    color: "#f7c26b",
    accent: "rgba(247,194,107,0.12)",
    description: "Pick advice and limited deck construction",
  },
  {
    key: "judge_helper",
    label: "Judge Helper",
    icon: <Scale size={15} />,
    color: "#e07bf0",
    accent: "rgba(224,123,240,0.12)",
    description: "Tournament policy and judge-level rulings",
  },
  {
    key: "game_state_tracker",
    label: "Game State",
    icon: <Cpu size={15} />,
    color: "#f07070",
    accent: "rgba(240,112,112,0.12)",
    description: "Track and resolve active game situations",
  },
  {
    key: "combo_synergy",
    label: "Combo & Synergy",
    icon: <Zap size={15} />,
    color: "#ffb347",
    accent: "rgba(255,179,71,0.12)",
    description: "Explore combos and card interactions",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModeConfig(key: Mode) {
  return MODES.find((m) => m.key === key)!;
}

function uid() {
  return Math.random().toString(36).slice(2);
}

// ---------------------------------------------------------------------------
// Component: Mode Selector
// ---------------------------------------------------------------------------

function ModeSelector({
  selected,
  onChange,
}: {
  selected: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div className="mode-selector">
      {MODES.map((m) => (
        <button
          key={m.key}
          className={`mode-btn ${selected === m.key ? "active" : ""}`}
          style={
            {
              "--mode-color": m.color,
              "--mode-accent": m.accent,
            } as React.CSSProperties
          }
          onClick={() => onChange(m.key)}
          title={m.description}
        >
          <span className="mode-icon">{m.icon}</span>
          <span className="mode-label">{m.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: Message Bubble
// ---------------------------------------------------------------------------

function MessageBubble({ msg }: { msg: Message }) {
  const mode = getModeConfig(msg.mode);
  const isUser = msg.role === "user";

  return (
    <div className={`message ${isUser ? "message-user" : "message-assistant"}`}>
      {!isUser && (
        <div
          className="message-mode-tag"
          style={{ color: mode.color, borderColor: mode.color }}
        >
          <span>{mode.icon}</span>
          <span>{mode.label}</span>
          {msg.overridden && msg.overridden_to && (
            <span className="override-badge" title="Router switched mode">
              <AlertTriangle size={10} />
              routed to {getModeConfig(msg.overridden_to).label}
            </span>
          )}
        </div>
      )}
      <div
        className="message-body"
        style={
          !isUser
            ? {
                borderColor: `${mode.color}30`,
                background: mode.accent,
              }
            : {}
        }
      >
        <p className="message-text">{msg.text}</p>
        {msg.rules_used && msg.rules_used.length > 0 && (
          <div className="rules-used">
            <span className="rules-label">Rules cited:</span>
            {msg.rules_used.map((r) => (
              <span key={r} className="rule-pill">
                {r}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: Typing indicator
// ---------------------------------------------------------------------------

function TypingIndicator({ mode }: { mode: Mode }) {
  const m = getModeConfig(mode);
  return (
    <div className="message message-assistant">
      <div
        className="message-body typing"
        style={{ borderColor: `${m.color}30`, background: m.accent }}
      >
        <span style={{ color: m.color }}>{m.icon}</span>
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function MTGAssistant() {
  const [mode, setMode] = useState<Mode>("rules_qa");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { id: uid(), role: "user", text, mode };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      // 1. Route
      const routerRes = await fetch("/api/router", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, selected_mode: mode }),
      }).then((r) => r.json());

      const resolvedMode: Mode = routerRes.mode ?? mode;
      const overridden = routerRes.overridden ?? false;

      // 2. Call mode endpoint
      const history = messages
        .filter((m) => m.mode === resolvedMode)
        .map((m) => ({ role: m.role === "user" ? "user" : "model", text: m.text }));

      const modeEndpoint = resolvedMode.replace(/_/g, "-");
      const modeRes = await fetch(`/api/modes/${modeEndpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, history }),
      }).then((r) => r.json());

      const assistantMsg: Message = {
        id: uid(),
        role: "assistant",
        text: modeRes.answer ?? modeRes.error ?? "No response.",
        mode: resolvedMode,
        rules_used: modeRes.rules_used,
        overridden,
        overridden_to: overridden ? resolvedMode : undefined,
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: uid(),
          role: "assistant",
          text: "Something went wrong. Please try again.",
          mode,
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const currentMode = getModeConfig(mode);

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #0a0a0f;
          --surface: #111118;
          --surface2: #16161f;
          --border: #2a2a3a;
          --text: #e8e4d8;
          --text-muted: #6b6880;
          --font-display: 'Cinzel', Georgia, serif;
          --font-body: 'Crimson Text', Georgia, serif;
        }

        html, body, #__next { height: 100%; }

        body {
          background: var(--bg);
          color: var(--text);
          font-family: var(--font-body);
          font-size: 17px;
          line-height: 1.6;
        }

        .app {
          display: flex;
          flex-direction: column;
          height: 100vh;
          max-width: 860px;
          margin: 0 auto;
        }

        /* Header */
        .header {
          padding: 20px 24px 0;
          border-bottom: 1px solid var(--border);
        }

        .header-title {
          font-family: var(--font-display);
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--text-muted);
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .header-title::before {
          content: '';
          display: block;
          width: 20px;
          height: 1px;
          background: var(--border);
        }

        /* Mode selector */
        .mode-selector {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
          padding-bottom: 1px;
        }

        .mode-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 8px 13px;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--text-muted);
          font-family: var(--font-display);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          transition: color 0.15s, border-color 0.15s, background 0.15s;
          border-radius: 4px 4px 0 0;
          white-space: nowrap;
          margin-bottom: -1px;
        }

        .mode-btn:hover {
          color: var(--mode-color);
          background: var(--mode-accent);
        }

        .mode-btn.active {
          color: var(--mode-color);
          border-bottom-color: var(--mode-color);
          background: var(--mode-accent);
        }

        .mode-icon { display: flex; align-items: center; }

        /* Messages */
        .messages {
          flex: 1;
          overflow-y: auto;
          padding: 28px 24px;
          display: flex;
          flex-direction: column;
          gap: 20px;
          scrollbar-width: thin;
          scrollbar-color: var(--border) transparent;
        }

        .empty-state {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          color: var(--text-muted);
          text-align: center;
          padding: 40px;
        }

        .empty-glyph {
          font-family: var(--font-display);
          font-size: 48px;
          opacity: 0.15;
          line-height: 1;
        }

        .empty-title {
          font-family: var(--font-display);
          font-size: 13px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--text-muted);
        }

        .empty-desc {
          font-size: 15px;
          color: var(--text-muted);
          max-width: 320px;
        }

        /* Message bubbles */
        .message { display: flex; flex-direction: column; gap: 6px; }

        .message-user { align-items: flex-end; }
        .message-assistant { align-items: flex-start; }

        .message-mode-tag {
          display: flex;
          align-items: center;
          gap: 5px;
          font-family: var(--font-display);
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          border: 1px solid;
          border-radius: 3px;
          padding: 2px 8px;
          opacity: 0.7;
        }

        .override-badge {
          display: flex;
          align-items: center;
          gap: 3px;
          margin-left: 6px;
          padding-left: 6px;
          border-left: 1px solid currentColor;
          opacity: 0.6;
          font-size: 9px;
        }

        .message-body {
          max-width: 680px;
          padding: 14px 18px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--surface);
        }

        .message-user .message-body {
          background: var(--surface2);
          border-color: var(--border);
        }

        .message-text {
          white-space: pre-wrap;
          word-break: break-word;
        }

        .rules-used {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 5px;
          margin-top: 10px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
        }

        .rules-label {
          font-family: var(--font-display);
          font-size: 10px;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--text-muted);
        }

        .rule-pill {
          font-family: var(--font-display);
          font-size: 10px;
          padding: 2px 7px;
          border: 1px solid var(--border);
          border-radius: 2px;
          color: var(--text-muted);
          letter-spacing: 0.05em;
        }

        /* Typing indicator */
        .typing {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
        }

        .dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--text-muted);
          animation: pulse 1.2s ease-in-out infinite;
        }

        .dot:nth-child(3) { animation-delay: 0.2s; }
        .dot:nth-child(4) { animation-delay: 0.4s; }

        @keyframes pulse {
          0%, 100% { opacity: 0.3; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }

        /* Input area */
        .input-area {
          padding: 16px 24px 24px;
          border-top: 1px solid var(--border);
          background: var(--bg);
        }

        .input-row {
          display: flex;
          gap: 10px;
          align-items: flex-end;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 10px 10px 10px 16px;
          transition: border-color 0.15s;
        }

        .input-row:focus-within {
          border-color: var(--mode-color, var(--border));
        }

        textarea {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          resize: none;
          color: var(--text);
          font-family: var(--font-body);
          font-size: 17px;
          line-height: 1.5;
          min-height: 26px;
          max-height: 160px;
        }

        textarea::placeholder { color: var(--text-muted); }

        .send-btn {
          flex-shrink: 0;
          width: 34px;
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--mode-color, #555);
          border: none;
          border-radius: 3px;
          color: #0a0a0f;
          cursor: pointer;
          transition: opacity 0.15s, transform 0.1s;
        }

        .send-btn:hover:not(:disabled) { opacity: 0.85; }
        .send-btn:active:not(:disabled) { transform: scale(0.94); }
        .send-btn:disabled { opacity: 0.3; cursor: not-allowed; }

        .input-hint {
          margin-top: 8px;
          font-family: var(--font-display);
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-muted);
          text-align: right;
        }
      `}</style>

      <div
        className="app"
        style={
          {
            "--mode-color": currentMode.color,
            "--mode-accent": currentMode.accent,
          } as React.CSSProperties
        }
      >
        {/* Header */}
        <header className="header">
          <div className="header-title">MTG Assistant</div>
          <ModeSelector selected={mode} onChange={setMode} />
        </header>

        {/* Messages */}
        <div className="messages">
          {messages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-glyph">⟁</div>
              <div className="empty-title">{currentMode.label}</div>
              <div className="empty-desc">{currentMode.description}</div>
            </div>
          ) : (
            messages.map((msg) => <MessageBubble key={msg.id} msg={msg} />)
          )}
          {loading && <TypingIndicator mode={mode} />}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="input-area">
          <div className="input-row">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Ask about ${currentMode.label.toLowerCase()}...`}
              rows={1}
              disabled={loading}
            />
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim() || loading}
              style={{ background: currentMode.color }}
            >
              <Send size={15} />
            </button>
          </div>
          <div className="input-hint">Enter to send · Shift+Enter for newline</div>
        </div>
      </div>
    </>
  );
}
