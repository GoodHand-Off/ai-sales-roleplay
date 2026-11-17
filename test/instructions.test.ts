import { describe, expect, it } from "vitest";
import { findPersona, PERSONAS } from "@/content/personas";
import { buildInstructions, STAGE_END_PATTERN, stageEndMarker } from "@/lib/instructions";
import { buildRealtimeSession } from "@/lib/realtime-session";

const sarah = findPersona("sarah-chen")!;

describe("buildInstructions", () => {
  it("wraps the stage prompt in the shared guardrails", () => {
    const text = buildInstructions(sarah, sarah.stages[0]!);
    expect(text.startsWith("Role assignment")).toBe(true);
    expect(text).toContain("Character: Sarah Chen, 29");
    expect(text).toContain("Stage 1 of 5: Door-to-door opening.");
    expect(text).toContain(`Your first turn is exactly this line and nothing more: "${sarah.stages[0]!.openingLine}" Then stop and wait`);
    expect(text).toContain('say exactly "This concludes stage 1." once');
    expect(text).toContain("Do not coach, score");
    expect(text).toContain("You have no tools");
    expect(text.trim().endsWith("Stay fully in character as Sarah Chen.")).toBe(true);
  });

  it("builds every stage of every persona", () => {
    for (const persona of PERSONAS) {
      for (const stage of persona.stages) {
        const text = buildInstructions(persona, stage);
        expect(text).toContain(stage.prompt.trim());
        expect(text).toContain(stageEndMarker(stage.number));
        expect(text.length).toBeLessThan(12_000);
      }
    }
  });

  it("recognizes the stage-end marker in a spoken transcript", () => {
    expect(STAGE_END_PATTERN.test("Okay, see you Thursday. This concludes stage 1.")).toBe(true);
    expect(STAGE_END_PATTERN.test("this concludes Stage 5")).toBe(true);
    expect(STAGE_END_PATTERN.test("That concludes our talk")).toBe(false);
  });
});

describe("buildRealtimeSession", () => {
  it("uses the persona voice, the configured models and server VAD", () => {
    const session = buildRealtimeSession(sarah, sarah.stages[1]!, {
      realtimeModel: "voice-model",
      transcribeModel: "transcribe-model",
    });
    expect(session.type).toBe("realtime");
    expect(session.model).toBe("voice-model");
    expect(session.audio.output.voice).toBe("shimmer");
    expect(session.audio.input.transcription.model).toBe("transcribe-model");
    expect(session.audio.input.turn_detection.type).toBe("server_vad");
    expect(session.instructions).toContain("Stage 2 of 5");
    expect(session).not.toHaveProperty("tools");
  });
});
