import { estimateResponseCost, estimateTranscriptionCost, worstReplyUsd } from "./pricing";

/**
 * Holds one call to its budget and its session, from the server events OpenAI
 * sends on the call's sideband connection (lib/call-monitor.ts). It does no I/O:
 * it reads events and says what to do.
 *
 * A browser holds the call's event channel, so a modified one can change the
 * instructions, ask for replies back to back, or ask for several at once. The
 * server can't stop a reply from starting; it can only cancel it or end the
 * call. So the guard works with the most one reply can cost (`replyUsd`: the
 * instructions, a full input limit of conversation and a full output cap, at
 * the dearest rates):
 *
 * - Every reply OpenAI starts reserves `replyUsd` until its usage arrives.
 * - After every reply that starts and every cost that arrives, the call ends as
 *   soon as spend + reservations + one more `replyUsd` would pass the budget. So
 *   whatever starts next, including a reply that starts while the hang-up is on
 *   its way, still fits.
 * - Only one reply may run at a time; the guard cancels any extra one.
 * - A session update that changes the instructions, the model, the
 *   transcription model, the output cap or the input limit, or adds tools, ends
 *   the call. So does a reply that costs more than `replyUsd`, which only a reply
 *   carrying its own input can do.
 * - Once the call is ending (`stop`), every new reply is cancelled and automatic
 *   turns and transcription are switched off, again if the browser turns them
 *   back on, until the hang-up is confirmed.
 *
 * This follows realtime-voice-guard's approach so the two projects agree.
 */

/** What one call is held to. */
export type SpendLimits = {
  model: string;
  transcribeModel: string;
  instructions: string;
  /** The session's `max_output_tokens`. */
  maxOutputTokens: number;
  /** The session's `truncation.token_limits.post_instructions`. */
  maxInputTokens: number;
  budgetUsd: number;
};

export type GuardEndReason = "spend_cap" | "policy";

export type GuardAction =
  | { type: "cancel"; responseId: string }
  /** Switch off automatic turns and input transcription (sent while the call is ending). */
  | { type: "quiesce" }
  | { type: "end"; reason: GuardEndReason; detail: string };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** True when a reported output cap is absent or a number no higher than `cap` ("inf" fails). */
const withinCap = (value: unknown, cap: number) => value === undefined || (typeof value === "number" && value <= cap);

/** The model itself, or a dated snapshot of it such as `gpt-realtime-2.1-mini-2026-08-28`. Nothing else. */
const sameModel = (reported: unknown, expected: string) =>
  reported === undefined ||
  (typeof reported === "string" &&
    (reported === expected || (reported.startsWith(`${expected}-`) && /^\d{4}-\d{2}-\d{2}$/.test(reported.slice(expected.length + 1)))));

function truncationWithin(value: unknown, cap: number): boolean {
  if (value === undefined) return true;
  if (!isObject(value) || !isObject(value.token_limits)) return false;
  const limit = value.token_limits.post_instructions;
  return typeof limit === "number" && limit <= cap;
}

function inputAudio(session: Json): Json {
  return isObject(session.audio) && isObject(session.audio.input) ? session.audio.input : {};
}

/**
 * The most one reply can cost under these limits, in USD. A token is never
 * shorter than one byte, so the instructions' UTF-8 length bounds their tokens.
 * Infinity for a model with no prices, so such a call ends at its first reply.
 */
export function worstReplyCost(limits: Pick<SpendLimits, "model" | "instructions" | "maxInputTokens" | "maxOutputTokens">): number {
  const worst = worstReplyUsd(limits.model, {
    instructions: new TextEncoder().encode(limits.instructions).length,
    conversation: limits.maxInputTokens,
    output: limits.maxOutputTokens,
  });
  return worst ?? Number.POSITIVE_INFINITY;
}

/**
 * The smallest budget that lets a call have a reply: the reply that is running
 * plus one more that may start before the hang-up lands. Below it, a call would
 * end as its first reply starts.
 */
export function minimumBudgetUsd(limits: Parameters<typeof worstReplyCost>[0]): number {
  return 2 * worstReplyCost(limits);
}

export class SpendGuard {
  /** Estimated spend from usage OpenAI has reported. */
  spentUsd = 0;
  /** Responses that have finished. */
  responses = 0;
  /** True once anything has used the call: a reply, speech, committed audio or a transcription. */
  started = false;
  /** The most one reply can cost (worstReplyCost). */
  readonly replyUsd: number;
  private stopping = false;
  /** Responses OpenAI has started and not finished; each reserves `replyUsd`. */
  private readonly inFlight = new Set<string>();
  private readonly metered = new Set<string>();

  constructor(readonly limits: SpendLimits) {
    this.replyUsd = worstReplyCost(limits);
  }

  /** Spend plus the reservation of every running response. */
  get projectedUsd(): number {
    return this.spentUsd + this.inFlight.size * this.replyUsd;
  }

  /** Responses still running. */
  get running(): string[] {
    return [...this.inFlight];
  }

  /**
   * The call is ending. From now on every new reply is cancelled and session
   * changes are answered with `quiesce`; nothing ends the call again. Returns
   * what to send now: quiesce, and a cancel for every running reply.
   */
  stop(): GuardAction[] {
    if (this.stopping) return [];
    this.stopping = true;
    return [{ type: "quiesce" }, ...this.running.map((responseId): GuardAction => ({ type: "cancel", responseId }))];
  }

  /** Reads one server event and returns what the monitor should do. Metering continues after `stop`. */
  onEvent(event: unknown): GuardAction[] {
    if (!isObject(event)) return [];
    switch (event.type) {
      case "session.updated":
        return isObject(event.session) ? this.onSession(event.session) : [];
      case "response.created":
        return isObject(event.response) ? this.onResponseCreated(event.response) : [];
      case "response.done":
        return this.onResponseDone(event);
      case "conversation.item.input_audio_transcription.completed": {
        this.started = true;
        const id = `transcription:${String(event.item_id)}:${String(event.content_index ?? 0)}`;
        if (this.metered.has(id)) return [];
        this.metered.add(id);
        this.spentUsd += estimateTranscriptionCost(this.limits.transcribeModel, event.usage) ?? 0;
        return this.checkBudget();
      }
      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.committed":
        this.started = true;
        return [];
      default:
        return [];
    }
  }

  private onSession(session: Json): GuardAction[] {
    if (this.stopping) {
      const input = inputAudio(session);
      const listening = (input.turn_detection ?? null) !== null || (input.transcription ?? null) !== null;
      return listening ? [{ type: "quiesce" }] : [];
    }
    const { limits } = this;
    const breach = (detail: string): GuardAction[] => [{ type: "end", reason: "policy", detail }];
    if (session.instructions !== undefined && session.instructions !== limits.instructions) return breach("instructions changed");
    if (!sameModel(session.model, limits.model)) return breach("model changed");
    const transcription = inputAudio(session).transcription;
    const asr = isObject(transcription) ? transcription.model : undefined;
    if (asr !== undefined && !sameModel(asr, limits.transcribeModel)) return breach("transcription model changed");
    if (!withinCap(session.max_output_tokens, limits.maxOutputTokens)) return breach("output cap raised");
    if (!truncationWithin(session.truncation, limits.maxInputTokens)) return breach("input limit raised");
    if (Array.isArray(session.tools) && session.tools.length > 0) return breach("tools added");
    return [];
  }

  private onResponseCreated(response: Json): GuardAction[] {
    this.started = true;
    const id = typeof response.id === "string" ? response.id : undefined;
    if (id !== undefined) this.inFlight.add(id);
    if (this.stopping) return id === undefined ? [] : [{ type: "cancel", responseId: id }];
    if (!withinCap(response.max_output_tokens, this.limits.maxOutputTokens)) {
      return [{ type: "end", reason: "policy", detail: "response output cap raised" }];
    }
    const extra = id !== undefined && this.inFlight.size > 1;
    const actions: GuardAction[] = extra ? [{ type: "cancel", responseId: id }] : [];
    return [...actions, ...this.checkBudget()];
  }

  private onResponseDone(event: Json): GuardAction[] {
    const response = isObject(event.response) ? event.response : {};
    const id = typeof response.id === "string" ? response.id : `event:${String(event.event_id)}`;
    this.inFlight.delete(id);
    if (this.metered.has(id)) return [];
    this.metered.add(id);
    this.started = true;
    this.responses += 1;
    const cost = estimateResponseCost(this.limits.model, response.usage);
    this.spentUsd += cost;
    if (this.stopping) return [];
    if (cost > this.replyUsd) {
      return [{ type: "end", reason: "policy", detail: "a reply cost more than the session's limits allow" }];
    }
    return this.checkBudget();
  }

  private checkBudget(): GuardAction[] {
    if (this.stopping || this.projectedUsd + this.replyUsd <= this.limits.budgetUsd) return [];
    const detail = `spent $${this.spentUsd.toFixed(4)}, ${this.inFlight.size} running, next reply up to $${this.replyUsd.toFixed(4)}`;
    return [{ type: "end", reason: "spend_cap", detail }];
  }
}
