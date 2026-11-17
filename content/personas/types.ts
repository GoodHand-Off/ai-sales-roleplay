/**
 * The persona format. A persona is one homeowner with one or more stages.
 * Each stage is a separate call: a door knock, an inspection walk-through,
 * a kitchen-table price talk, and so on.
 *
 * Persona text in this folder is licensed CC BY 4.0 (see content/LICENSE).
 * Code is Apache-2.0.
 */

/** Built-in OpenAI Realtime voices. */
export const REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "cedar",
  "coral",
  "echo",
  "marin",
  "sage",
  "shimmer",
  "verse",
] as const;

/** One of the built-in Realtime voices. */
export type RealtimeVoice = (typeof REALTIME_VOICES)[number];

/** The trade a persona buys from; it steers the scorecard's coaching focus. */
export type Trade = "roofing" | "hvac" | "windows";

/** Shown to the rep before the call. */
export type Difficulty = "Beginner" | "Intermediate" | "Advanced";

/** One call with a homeowner. */
export type PersonaStage = {
  /** 1-based and contiguous within a persona. */
  number: number;
  /** Short name shown to the rep, e.g. "Door-to-door opening". */
  title: string;
  difficulty: Difficulty;
  /** One sentence for the rep: where they are and what just happened. */
  scene: string;
  /** What the rep should practice. Shown before the call and used by the scorecard. */
  goals: string[];
  /** The homeowner's first words. The call opens with this line. */
  openingLine: string;
  /**
   * Who the homeowner is in this stage and how they react. Written to the model
   * in the second person ("You are..."). Keep stage logic here; the shared
   * guardrails (stay in character, no coaching, closing marker) are added by
   * lib/instructions.ts.
   */
  prompt: string;
  /** When the homeowner should wrap up: the yes, the maybe and the no. */
  wrapUp: string;
};

/** One homeowner and their stages. */
export type Persona = {
  /** URL-safe slug, e.g. "sarah-chen". */
  id: string;
  name: string;
  age: number;
  occupation: string;
  trade: Trade;
  /** The program this persona belongs to, e.g. "Storm restoration". */
  program: string;
  /** One or two sentences for the persona card. */
  summary: string;
  voice: RealtimeVoice;
  profile: {
    home: string;
    budget: string;
    situation: string;
  };
  stages: PersonaStage[];
};
