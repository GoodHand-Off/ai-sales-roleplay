import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findPersona, findStage, PERSONAS } from "@/content/personas";
import { REALTIME_VOICES } from "@/content/personas/types";
import { formatDuration, toPersonaView, toStageView } from "@/lib/persona-view";

describe("personas", () => {
  it("ships the three documented personas", () => {
    expect(PERSONAS.map((persona) => persona.id)).toEqual(["sarah-chen", "gary-lindqvist", "priya-raman"]);
    expect(findPersona("sarah-chen")?.stages).toHaveLength(5);
    expect(findPersona("gary-lindqvist")?.trade).toBe("hvac");
    expect(findPersona("priya-raman")?.trade).toBe("windows");
  });

  it.each(PERSONAS.map((persona) => [persona.id, persona] as const))("%s is well formed", (_id, persona) => {
    expect(persona.id).toMatch(/^[a-z0-9-]+$/);
    expect(REALTIME_VOICES).toContain(persona.voice);
    persona.stages.forEach((stage, index) => {
      expect(stage.number).toBe(index + 1);
      expect(stage.openingLine.trim()).not.toBe("");
      expect(stage.prompt.trim().length).toBeGreaterThan(200);
      expect(stage.wrapUp.trim()).not.toBe("");
      expect(stage.goals.length).toBeGreaterThan(0);
      // Coaching happens in the written scorecard, never on the call.
      expect(stage.prompt).not.toMatch(/coaching mode|end_call|call end_call_tool/i);
    });
  });

  it("finds stages by number", () => {
    const sarah = findPersona("sarah-chen")!;
    expect(findStage(sarah, 3)?.title).toBe("Budget and insurance worries");
    expect(findStage(sarah, 6)).toBeUndefined();
    expect(findPersona("nobody")).toBeUndefined();
  });

  it("carries no fields from older voice platforms", () => {
    const dir = join(process.cwd(), "content", "personas");
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      expect(text).not.toMatch(/assistantId|faceId|simli|cartesia|serverMessages|voiceId|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i);
    }
  });

  it("puts a licence attribution header on every persona file", () => {
    const dir = join(process.cwd(), "content", "personas");
    for (const file of readdirSync(dir).filter((name) => !["index.ts", "types.ts"].includes(name))) {
      expect(readFileSync(join(dir, file), "utf8")).toContain("CC BY 4.0");
    }
  });

  it("sends the browser no prompt text", () => {
    const sarah = findPersona("sarah-chen")!;
    const view = { persona: toPersonaView(sarah), stage: toStageView(sarah.stages[0]!) };
    expect(view.persona).toMatchObject({ id: "sarah-chen", stageCount: 5 });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(sarah.stages[0]!.prompt.slice(0, 40));
    expect(serialized).not.toContain("wrapUp");
    expect(formatDuration(60)).toBe("1 minute");
    expect(formatDuration(230)).toBe("3 minutes 50 seconds");
    expect(formatDuration(45)).toBe("45 seconds");
    expect(formatDuration(180)).toBe("3 minutes");
  });
});
