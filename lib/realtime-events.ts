import { STAGE_END_PATTERN } from "./stage-end";
import type { Speaker, TranscriptLine } from "./transcript";

/**
 * Turns OpenAI Realtime events from the WebRTC data channel into an ordered
 * transcript and speaking indicators. Pure and framework-free, so it is easy to
 * test and to reuse.
 */

type Item = { speaker: Speaker; text: string; final: boolean };

/** The live transcript and speaking indicators for one call. */
export type CallTranscriptState = {
  /** Conversation item IDs in conversation order. */
  order: string[];
  items: Record<string, Item>;
  homeownerSpeaking: boolean;
  repSpeaking: boolean;
  /** The homeowner said the stage-end marker. */
  stageComplete: boolean;
};

/** An empty transcript: nobody has spoken yet. */
export function initialTranscriptState(): CallTranscriptState {
  return { order: [], items: {}, homeownerSpeaking: false, repSpeaking: false, stageComplete: false };
}

type EventRecord = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function speakerForRole(role: unknown): Speaker | null {
  if (role === "user") return "rep";
  if (role === "assistant") return "homeowner";
  return null;
}

function ensureItem(
  state: CallTranscriptState,
  id: string,
  speaker: Speaker,
  previousId: string | null,
): CallTranscriptState {
  if (state.items[id]) return state;
  const order = [...state.order];
  const previousIndex = previousId ? order.indexOf(previousId) : -1;
  if (previousIndex >= 0) order.splice(previousIndex + 1, 0, id);
  else order.push(id);
  return { ...state, order, items: { ...state.items, [id]: { speaker, text: "", final: false } } };
}

function appendDelta(state: CallTranscriptState, id: string, speaker: Speaker, delta: string) {
  const next = ensureItem(state, id, speaker, null);
  const item = next.items[id];
  if (!item || item.final) return next;
  return { ...next, items: { ...next.items, [id]: { ...item, text: item.text + delta } } };
}

function finalize(state: CallTranscriptState, id: string, speaker: Speaker, text: string) {
  const next = ensureItem(state, id, speaker, null);
  const finalText = text.trim() || (next.items[id]?.text ?? "").trim();
  const updated = { ...next, items: { ...next.items, [id]: { speaker, text: finalText, final: true } } };
  if (speaker === "homeowner" && STAGE_END_PATTERN.test(finalText)) updated.stageComplete = true;
  return updated;
}

/**
 * Applies one Realtime event from the data channel. Returns the same object when
 * the event changes nothing, so React can skip a render.
 */
export function applyRealtimeEvent(state: CallTranscriptState, event: unknown): CallTranscriptState {
  if (!event || typeof event !== "object") return state;
  const record = event as EventRecord;
  const itemId = str(record.item_id);

  switch (record.type) {
    case "conversation.item.added":
    case "conversation.item.created": {
      const item = record.item as EventRecord | undefined;
      const id = str(item?.id);
      const speaker = speakerForRole(item?.role);
      if (!id || !speaker || item?.type !== "message") return state;
      return ensureItem(state, id, speaker, str(record.previous_item_id));
    }
    case "input_audio_buffer.committed":
      return itemId ? ensureItem(state, itemId, "rep", str(record.previous_item_id)) : state;
    case "response.output_item.added": {
      const item = record.item as EventRecord | undefined;
      const id = str(item?.id);
      return id && item?.role === "assistant" ? ensureItem(state, id, "homeowner", null) : state;
    }
    case "conversation.item.input_audio_transcription.delta": {
      const delta = str(record.delta);
      return itemId && delta ? appendDelta(state, itemId, "rep", delta) : state;
    }
    case "conversation.item.input_audio_transcription.completed":
      return itemId ? finalize(state, itemId, "rep", str(record.transcript) ?? "") : state;
    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta": {
      const delta = str(record.delta);
      return itemId && delta ? appendDelta(state, itemId, "homeowner", delta) : state;
    }
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      return itemId ? finalize(state, itemId, "homeowner", str(record.transcript) ?? "") : state;
    case "output_audio_buffer.started":
      return state.homeownerSpeaking ? state : { ...state, homeownerSpeaking: true };
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared":
      return state.homeownerSpeaking ? { ...state, homeownerSpeaking: false } : state;
    case "input_audio_buffer.speech_started":
      return state.repSpeaking ? state : { ...state, repSpeaking: true };
    case "input_audio_buffer.speech_stopped":
      return state.repSpeaking ? { ...state, repSpeaking: false } : state;
    default:
      return state;
  }
}

/** The homeowner's most recent finished line, for a screen-reader announcement. */
export function lastFinishedLine(state: CallTranscriptState, speaker: Speaker): string | null {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.items[state.order[index] ?? ""];
    if (item && item.speaker === speaker && item.final && item.text.trim()) return item.text.trim();
  }
  return null;
}

/** The transcript so far, in order, without empty items. */
export function transcriptLines(state: CallTranscriptState): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const id of state.order) {
    const item = state.items[id];
    const text = item?.text.trim();
    if (item && text) lines.push({ speaker: item.speaker, text });
  }
  return lines;
}
