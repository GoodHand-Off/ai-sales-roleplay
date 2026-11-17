import type { Persona, PersonaStage } from "@/content/personas/types";

/**
 * The parts of a persona the browser needs. Prompts stay on the server, so the
 * page never ships the character instructions to the client.
 */
export type PersonaView = Pick<
  Persona,
  "id" | "name" | "age" | "occupation" | "trade" | "program" | "summary"
> & { stageCount: number };

/** The parts of a stage the browser shows: no prompt text. */
export type StageView = Pick<PersonaStage, "number" | "title" | "difficulty" | "scene" | "goals">;

/** Strips a persona down to what the browser may see. */
export function toPersonaView(persona: Persona): PersonaView {
  const { id, name, age, occupation, trade, program, summary } = persona;
  return { id, name, age, occupation, trade, program, summary, stageCount: persona.stages.length };
}

/** Strips a stage down to what the browser may see. */
export function toStageView(stage: PersonaStage): StageView {
  const { number, title, difficulty, scene, goals } = stage;
  return { number, title, difficulty, scene, goals };
}

/** "3 minutes", "1 minute 30 seconds", "45 seconds". Never rounds up. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (minutes) parts.push(minutes === 1 ? "1 minute" : `${minutes} minutes`);
  if (seconds || !minutes) parts.push(seconds === 1 ? "1 second" : `${seconds} seconds`);
  return parts.join(" ");
}
