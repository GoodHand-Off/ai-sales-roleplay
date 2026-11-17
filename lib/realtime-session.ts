import type { Persona, PersonaStage } from "@/content/personas/types";
import type { ServerConfig } from "./config";
import { buildInstructions } from "./instructions";
import type { SpendLimits } from "./spend-guard";

/**
 * Most tokens one homeowner reply may produce. The model's reasoning and the
 * reply's transcript count too, so this is roughly 30 seconds of speech. At 512,
 * a long reply was cut off mid-sentence in a live test.
 */
export const MAX_OUTPUT_TOKENS = 1_024;
/**
 * Most conversation tokens each reply may re-read after the instructions
 * (OpenAI's truncation limit). It bounds what one reply's input can cost, even if
 * a modified browser stuffs the conversation: 8,000 tokens at the dearest input
 * rate is $0.08 on gpt-realtime-2.1-mini. A 230-second honest call re-reads a few
 * thousand, so it never reaches the limit and its cache is never cut.
 */
export const MAX_REREAD_TOKENS = 8_000;

type SessionConfig = Pick<ServerConfig, "realtimeModel" | "transcribeModel">;

/**
 * The OpenAI Realtime session for one stage. The browser never sees this: the
 * server sends it to OpenAI together with the browser's WebRTC offer.
 */
export function buildRealtimeSession(persona: Persona, stage: PersonaStage, config: SessionConfig) {
  return {
    type: "realtime",
    model: config.realtimeModel,
    instructions: buildInstructions(persona, stage),
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: config.transcribeModel, language: "en" },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
          silence_duration_ms: 650,
          prefix_padding_ms: 300,
          threshold: 0.5,
        },
        noise_reduction: { type: "near_field" },
      },
      output: { voice: persona.voice, speed: 1 },
    },
    max_output_tokens: MAX_OUTPUT_TOKENS,
    truncation: { type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: MAX_REREAD_TOKENS } },
  };
}

/** What the spend guard holds this session to. */
export function spendLimits(
  session: ReturnType<typeof buildRealtimeSession>,
  config: SessionConfig & Pick<ServerConfig, "maxCallCostUsd">,
): SpendLimits {
  return {
    model: config.realtimeModel,
    transcribeModel: config.transcribeModel,
    instructions: session.instructions,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxInputTokens: MAX_REREAD_TOKENS,
    budgetUsd: config.maxCallCostUsd,
  };
}
