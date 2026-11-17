import { garyLindqvist } from "./gary-lindqvist";
import { priyaRaman } from "./priya-raman";
import { sarahChen } from "./sarah-chen";
import type { Persona, PersonaStage } from "./types";

export type { Persona, PersonaStage } from "./types";

/** Add your own persona file here to make it appear in the app. */
export const PERSONAS: readonly Persona[] = [sarahChen, garyLindqvist, priyaRaman];

/** The persona with this ID, or undefined. */
export function findPersona(id: string): Persona | undefined {
  return PERSONAS.find((persona) => persona.id === id);
}

/** The stage with this number, or undefined. */
export function findStage(persona: Persona, stageNumber: number): PersonaStage | undefined {
  return persona.stages.find((stage) => stage.number === stageNumber);
}
