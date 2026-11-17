/**
 * OpenAI prices for the models this app can use, and cost estimates from the
 * usage OpenAI reports during a call. The spend guard (lib/spend-guard.ts) uses
 * them to end a call at its budget. The estimator follows realtime-voice-guard's,
 * so the two projects agree on what a call costs.
 *
 * Source: https://developers.openai.com/api/docs/pricing ("Realtime & Audio"),
 * checked 2026-11-17. Prices change; update this table when they do.
 */

/** USD per 1M tokens. */
type Rates = { input: number; cachedInput: number; output: number };

type RealtimePrices = { text: Rates; audio: Rates; image: Omit<Rates, "output"> };

/** USD per 1M tokens, or per minute of audio. */
type TranscriptionPrices = { input?: number; output?: number; perMinute?: number };

export const PRICES_CHECKED = "2026-11-17";

const MINI: RealtimePrices = {
  text: { input: 0.6, cachedInput: 0.06, output: 2.4 },
  audio: { input: 10, cachedInput: 0.3, output: 20 },
  image: { input: 0.8, cachedInput: 0.08 },
};
const FULL: RealtimePrices = {
  text: { input: 4, cachedInput: 0.4, output: 24 },
  audio: { input: 32, cachedInput: 0.4, output: 64 },
  image: { input: 5, cachedInput: 0.5 },
};

export const REALTIME_PRICES: Readonly<Record<string, RealtimePrices>> = {
  "gpt-realtime-2.1-mini": MINI,
  "gpt-realtime-2.1": FULL,
  "gpt-realtime-2": FULL,
  "gpt-realtime-1.5": { ...FULL, text: { ...FULL.text, output: 16 } },
};

export const TRANSCRIPTION_PRICES: Readonly<Record<string, TranscriptionPrices>> = {
  "gpt-transcribe": { perMinute: 0.0045 },
  "gpt-4o-mini-transcribe": { input: 1.25, output: 5, perMinute: 0.003 },
  "gpt-4o-transcribe": { input: 2.5, output: 10, perMinute: 0.006 },
  "whisper-1": { perMinute: 0.006 },
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** The token counts that bound one reply: what a session's limits allow it to read and write. */
export type ReplyTokens = {
  /** The instructions, at most. */
  instructions: number;
  /** Conversation re-read after the instructions: the session's truncation limit. */
  conversation: number;
  /** The session's `max_output_tokens`. */
  output: number;
};

/**
 * The most one reply can cost on `model`: the instructions at the uncached text
 * rate, a full truncation limit of conversation at the dearest uncached input
 * rate, and a full output cap at the dearest output rate. Null when the model
 * has no prices.
 */
export function worstReplyUsd(model: string, tokens: ReplyTokens): number | null {
  const prices = REALTIME_PRICES[model];
  if (!prices) return null;
  const input = Math.max(prices.text.input, prices.audio.input, prices.image.input);
  const output = Math.max(prices.text.output, prices.audio.output);
  return (tokens.instructions * prices.text.input + tokens.conversation * input + tokens.output * output) / 1_000_000;
}

/**
 * Prices one `response.done` usage object in USD. Tokens the details don't
 * explain are charged at the dearest rate in that direction, so the estimate
 * errs high. Zero for a model with no prices (the server refuses those).
 */
export function estimateResponseCost(model: string, usage: unknown): number {
  const prices = REALTIME_PRICES[model];
  if (!prices || !isObject(usage)) return 0;
  const inDetails = isObject(usage.input_token_details) ? usage.input_token_details : {};
  const cachedDetails = isObject(inDetails.cached_tokens_details) ? inDetails.cached_tokens_details : {};
  const outDetails = isObject(usage.output_token_details) ? usage.output_token_details : {};

  let micro = 0; // USD per 1M tokens, summed
  let explained = 0;
  for (const [key, rates] of [
    ["text_tokens", prices.text],
    ["audio_tokens", prices.audio],
    ["image_tokens", prices.image],
  ] as const) {
    const tokens = count(inDetails[key]);
    const cached = Math.min(count(cachedDetails[key]), tokens);
    micro += (tokens - cached) * rates.input + cached * rates.cachedInput;
    explained += tokens;
  }
  micro += Math.max(0, count(usage.input_tokens) - explained) * Math.max(prices.text.input, prices.audio.input);

  const outText = count(outDetails.text_tokens);
  const outAudio = count(outDetails.audio_tokens);
  micro += outText * prices.text.output + outAudio * prices.audio.output;
  micro += Math.max(0, count(usage.output_tokens) - outText - outAudio) * Math.max(prices.text.output, prices.audio.output);
  return micro / 1_000_000;
}

/**
 * Prices one input-transcription usage object, which OpenAI reports either as
 * tokens or as seconds of audio. Returns null when this model has no price for
 * the reported unit.
 */
export function estimateTranscriptionCost(model: string, usage: unknown): number | null {
  const prices = TRANSCRIPTION_PRICES[model];
  if (!prices || !isObject(usage)) return null;
  if (usage.type === "duration") {
    return prices.perMinute === undefined ? null : (count(usage.seconds) / 60) * prices.perMinute;
  }
  if (prices.input === undefined || prices.output === undefined) return null;
  return (count(usage.input_tokens) * prices.input + count(usage.output_tokens) * prices.output) / 1_000_000;
}
