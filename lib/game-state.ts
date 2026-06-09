/**
 * MTG Game State Types and Utilities
 * Place at: lib/game-state.ts
 *
 * Defines the canonical game state JSON shape used across
 * the game state tracker mode and UI.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Zone =
  | "battlefield"
  | "hand"
  | "graveyard"
  | "exile"
  | "library"
  | "stack"
  | "command";

export type Phase =
  | "beginning"
  | "precombat_main"
  | "combat"
  | "postcombat_main"
  | "ending";

export type Step =
  | "untap"
  | "upkeep"
  | "draw"
  | "precombat_main"
  | "beginning_of_combat"
  | "declare_attackers"
  | "declare_blockers"
  | "combat_damage"
  | "end_of_combat"
  | "postcombat_main"
  | "end"
  | "cleanup";

export interface CardOnBattlefield {
  name: string;
  tapped: boolean;
  counters?: Record<string, number>; // e.g. { "+1/+1": 3, "loyalty": 5 }
  attached_to?: string;              // name of card this is attached to
  tokens?: boolean;                  // true if this is a token
  notes?: string;                    // e.g. "has summoning sickness"
}

export interface StackEntry {
  type: "spell" | "ability";
  description: string;               // e.g. "Lightning Bolt targeting Player 2"
  controller: string;                // player name
}

export interface PlayerState {
  name: string;
  life: number;
  poison_counters: number;
  energy_counters: number;
  mana_pool: Record<string, number>; // e.g. { W: 0, U: 2, B: 0, R: 0, G: 0, C: 0 }
  hand_count: number;                // number of cards in hand (not revealed)
  hand_cards?: string[];             // revealed card names if known
  library_count: number;
  battlefield: CardOnBattlefield[];
  graveyard: string[];
  exile: string[];
  command_zone?: string[];           // commander(s) if applicable
  commander_tax?: number;            // additional commander cost
  monarch?: boolean;
  initiative?: boolean;
}

export interface GameState {
  players: PlayerState[];            // 2-4 players
  active_player: string;            // player name whose turn it is
  priority_player: string;          // player name who currently has priority
  phase: Phase;
  step: Step;
  turn_number: number;
  stack: StackEntry[];
  format?: string;                  // e.g. "Commander", "Standard"
  notes?: string;                   // any extra context
  version: number;                  // increments on each state update
}

// ---------------------------------------------------------------------------
// Default state factory
// ---------------------------------------------------------------------------

export function createDefaultPlayerState(name: string): PlayerState {
  return {
    name,
    life: 20,
    poison_counters: 0,
    energy_counters: 0,
    mana_pool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    hand_count: 7,
    library_count: 53,
    battlefield: [],
    graveyard: [],
    exile: [],
  };
}

export function createCommanderPlayerState(name: string): PlayerState {
  return {
    ...createDefaultPlayerState(name),
    life: 40,
    command_zone: [],
    commander_tax: 0,
  };
}

export function createDefaultGameState(
  playerNames: string[],
  format: "Commander" | "Standard" | "Modern" | "Other" = "Commander"
): GameState {
  const isCommander = format === "Commander";

  return {
    players: playerNames.map((name) =>
      isCommander
        ? createCommanderPlayerState(name)
        : createDefaultPlayerState(name)
    ),
    active_player: playerNames[0],
    priority_player: playerNames[0],
    phase: "precombat_main",
    step: "precombat_main",
    turn_number: 1,
    stack: [],
    format,
    notes: "",
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateGameState(state: unknown): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!state || typeof state !== "object") {
    return { valid: false, errors: ["Game state must be an object."] };
  }

  const s = state as Partial<GameState>;

  if (!Array.isArray(s.players) || s.players.length < 2 || s.players.length > 4) {
    errors.push("Game state must have 2-4 players.");
  }

  if (s.players) {
    for (const player of s.players) {
      if (typeof player.name !== "string") errors.push("Each player must have a name.");
      if (typeof player.life !== "number") errors.push(`Player ${player.name}: life must be a number.`);
      if (!Array.isArray(player.battlefield)) errors.push(`Player ${player.name}: battlefield must be an array.`);
    }
  }

  if (!s.active_player) errors.push("Game state must have an active_player.");
  if (!s.phase) errors.push("Game state must have a phase.");
  if (!s.step) errors.push("Game state must have a step.");
  if (typeof s.turn_number !== "number") errors.push("Game state must have a turn_number.");
  if (!Array.isArray(s.stack)) errors.push("Game state must have a stack array.");

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Compact summary for LLM context (avoids bloating the prompt)
// ---------------------------------------------------------------------------

export function summarizeGameState(state: GameState): string {
  const lines: string[] = [
    `Turn ${state.turn_number} | ${state.format ?? "Unknown format"}`,
    `Active player: ${state.active_player} | Priority: ${state.priority_player}`,
    `Phase: ${state.phase} / Step: ${state.step}`,
    "",
  ];

  for (const player of state.players) {
    lines.push(`--- ${player.name} ---`);
    lines.push(`Life: ${player.life} | Poison: ${player.poison_counters} | Hand: ${player.hand_count} cards | Library: ${player.library_count} cards`);

    if (player.command_zone?.length) {
      lines.push(`Command zone: ${player.command_zone.join(", ")} (tax: ${player.commander_tax ?? 0})`);
    }

    if (player.battlefield.length > 0) {
      const bf = player.battlefield
        .map(
          (c) =>
            `${c.name}${c.tapped ? " [tapped]" : ""}${c.counters ? ` [${Object.entries(c.counters).map(([k, v]) => `${v} ${k}`).join(", ")}]` : ""}${c.notes ? ` (${c.notes})` : ""}`
        )
        .join(", ");
      lines.push(`Battlefield: ${bf}`);
    } else {
      lines.push("Battlefield: empty");
    }

    if (player.graveyard.length > 0) {
      lines.push(`Graveyard: ${player.graveyard.join(", ")}`);
    }

    if (player.exile.length > 0) {
      lines.push(`Exile: ${player.exile.join(", ")}`);
    }

    lines.push("");
  }

  if (state.stack.length > 0) {
    lines.push("--- Stack (top to bottom) ---");
    state.stack.forEach((entry, i) => {
      lines.push(`${i + 1}. [${entry.type}] ${entry.description} (controller: ${entry.controller})`);
    });
    lines.push("");
  }

  if (state.notes) {
    lines.push(`Notes: ${state.notes}`);
  }

  return lines.join("\n");
}
