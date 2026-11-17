import { describe, expect, it } from "vitest";
import { applyRealtimeEvent, initialTranscriptState, transcriptLines } from "@/lib/realtime-events";

function run(events: object[]) {
  return events.reduce(applyRealtimeEvent, initialTranscriptState());
}

describe("applyRealtimeEvent", () => {
  it("builds an ordered transcript from item and transcript events", () => {
    const state = run([
      { type: "response.output_item.added", item: { id: "a1", role: "assistant", type: "message" } },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "Oh god, " },
      { type: "response.output_audio_transcript.delta", item_id: "a1", delta: "yeah." },
      { type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Oh god, yeah, I saw it." },
      { type: "input_audio_buffer.committed", item_id: "u1", previous_item_id: "a1" },
      // The homeowner's reply starts before the rep's transcription finishes.
      { type: "response.output_item.added", item: { id: "a2", role: "assistant", type: "message" } },
      { type: "response.output_audio_transcript.done", item_id: "a2", transcript: "Okay. Go on." },
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "Hi, I'm with a local roofer." },
    ]);
    expect(transcriptLines(state)).toEqual([
      { speaker: "homeowner", text: "Oh god, yeah, I saw it." },
      { speaker: "rep", text: "Hi, I'm with a local roofer." },
      { speaker: "homeowner", text: "Okay. Go on." },
    ]);
  });

  it("places items after their previous item when added out of order", () => {
    const state = run([
      { type: "conversation.item.added", item: { id: "a1", role: "assistant", type: "message" } },
      { type: "conversation.item.added", item: { id: "a2", role: "assistant", type: "message" }, previous_item_id: "a1" },
      { type: "conversation.item.added", item: { id: "u1", role: "user", type: "message" }, previous_item_id: "a1" },
    ]);
    expect(state.order).toEqual(["a1", "u1", "a2"]);
  });

  it("tracks who is speaking", () => {
    let state = run([{ type: "output_audio_buffer.started" }]);
    expect(state.homeownerSpeaking).toBe(true);
    state = applyRealtimeEvent(state, { type: "output_audio_buffer.stopped" });
    expect(state.homeownerSpeaking).toBe(false);
    state = applyRealtimeEvent(state, { type: "input_audio_buffer.speech_started" });
    expect(state.repSpeaking).toBe(true);
  });

  it("marks the stage complete when the homeowner says the marker", () => {
    const state = run([
      { type: "response.output_audio_transcript.done", item_id: "a9", transcript: "See you Thursday. This concludes stage 1." },
    ]);
    expect(state.stageComplete).toBe(true);
  });

  it("does not let the rep end the stage by saying the marker", () => {
    const state = run([
      { type: "conversation.item.input_audio_transcription.completed", item_id: "u9", transcript: "This concludes stage 1." },
    ]);
    expect(state.stageComplete).toBe(false);
  });

  it("ignores unknown and malformed events without copying state", () => {
    const state = initialTranscriptState();
    expect(applyRealtimeEvent(state, { type: "session.updated" })).toBe(state);
    expect(applyRealtimeEvent(state, null)).toBe(state);
    expect(applyRealtimeEvent(state, { type: "response.output_audio_transcript.delta" })).toBe(state);
  });
});
