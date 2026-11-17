import { PERSONAS } from "@/content/personas";
import { buildInstructions } from "./instructions";
import { REALTIME_PRICES, TRANSCRIPTION_PRICES } from "./pricing";
import { MAX_OUTPUT_TOKENS, MAX_REREAD_TOKENS } from "./realtime-session";
import { minimumBudgetUsd, worstReplyCost } from "./spend-guard";

/** Server-only configuration, read from the environment with defaults. */

/** Defaults used when a variable is unset. */
export const DEFAULTS = {
  realtimeModel: "gpt-realtime-2.1-mini",
  transcribeModel: "gpt-transcribe",
  coachingModel: "gpt-6-luna",
  sessionMaxSeconds: 180,
  maxCallsPerDay: 100,
  maxCallCostUsd: 0.5,
} as const;

/**
 * The session route's function time limit, in seconds. It must equal
 * `maxDuration` in app/api/session/route.ts (a test checks this).
 */
export const ROUTE_MAX_DURATION_SECONDS = 300;

/**
 * After the cap, the server keeps retrying the hang-up until this many seconds
 * after the request started, staying inside ROUTE_MAX_DURATION_SECONDS.
 */
export const HANGUP_DEADLINE_SECONDS = 290;

/**
 * Allowed range for SESSION_MAX_SECONDS. The cap is counted from the moment the
 * request arrives; 230 leaves a full minute of hang-up retries before
 * HANGUP_DEADLINE_SECONDS.
 */
export const SESSION_MAX_SECONDS_RANGE = { min: 30, max: 230 } as const;

/** Everything the API routes need from the environment. */
export type ServerConfig = {
  openaiApiKey: string;
  realtimeModel: string;
  transcribeModel: string;
  coachingModel: string;
  sessionMaxSeconds: number;
  maxCallsPerDay: number;
  /** The spend guard ends a call when its estimated cost reaches this (lib/spend-guard.ts). */
  maxCallCostUsd: number;
};

/** A missing or invalid environment variable. `variable` names it; `message` says how to fix it. */
export class ConfigError extends Error {
  constructor(
    message: string,
    readonly variable: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const MODEL_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const KEY_HELP =
  "Create a key at https://platform.openai.com/api-keys, put it in .env.local (copy .env.example), and restart the server.";

function readModel(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim();
  if (!value) return fallback;
  if (!MODEL_NAME.test(value)) {
    throw new ConfigError(`${name} is not a valid model name. Remove it from .env.local to use ${fallback}.`, name);
  }
  return value;
}

/** Reads a whole number in a range. Rejects NaN, Infinity, decimals and blanks-with-junk, so a typo can't disable a limit. */
function readWholeNumber(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a whole number from ${min} to ${max}. It is "${raw}" in your environment.`, name);
  }
  return value;
}

/** Reads a dollar amount in a range, with the same strictness as readWholeNumber. */
function readDollars(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be a dollar amount from ${min} to ${max}, like 0.50. It is "${raw}" in your environment.`, name);
  }
  return value;
}

/** The spend guard can only cap a model it has prices for (lib/pricing.ts). */
function readPricedModel(env: Env, name: string, fallback: string, prices: Readonly<Record<string, unknown>>): string {
  const model = readModel(env, name, fallback);
  if (!(model in prices)) {
    throw new ConfigError(
      `${name} is "${model}", which has no price in lib/pricing.ts, so the per-call spend cap can't be enforced. Use one of ${Object.keys(prices).join(", ")}, or add its prices.`,
      name,
    );
  }
  return model;
}

/** The longest instructions any persona stage sends, so the budget check covers every call. */
function longestInstructions(): string {
  let longest = "";
  for (const persona of PERSONAS) {
    for (const stage of persona.stages) {
      const instructions = buildInstructions(persona, stage);
      if (instructions.length > longest.length) longest = instructions;
    }
  }
  return longest;
}

/**
 * The spend guard can only hold a budget that covers the reply that is running
 * plus one more that may start while the hang-up is on its way
 * (lib/spend-guard.ts minimumBudgetUsd). A smaller one would end every call as
 * its first reply starts, so the server refuses it.
 */
function checkBudget(model: string, budgetUsd: number): void {
  const limits = { model, instructions: longestInstructions(), maxInputTokens: MAX_REREAD_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS };
  const minimum = Math.ceil(minimumBudgetUsd(limits) * 100) / 100;
  if (budgetUsd >= minimum) return;
  const reply = worstReplyCost(limits).toFixed(4);
  throw new ConfigError(
    `MAX_CALL_COST_USD is ${budgetUsd}, but one reply on ${model} can cost up to $${reply}, and the server needs room for two: the one running and one more that may start while it hangs up. Set MAX_CALL_COST_USD to at least ${minimum.toFixed(2)}.`,
    "MAX_CALL_COST_USD",
  );
}

function checkAppOrigin(env: Env): void {
  const raw = env.APP_ORIGIN?.trim();
  if (!raw) return;
  for (const part of raw.split(",")) {
    let valid = false;
    try {
      const url = new URL(part.trim());
      valid = (url.protocol === "https:" || url.protocol === "http:") && url.pathname === "/" && !url.search;
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new ConfigError(
        `APP_ORIGIN must be a comma-separated list of origins like https://practice.example.com. "${part.trim()}" is not one.`,
        "APP_ORIGIN",
      );
    }
  }
}

function readSessionMaxSeconds(env: Env): number {
  const { min, max } = SESSION_MAX_SECONDS_RANGE;
  return readWholeNumber(env, "SESSION_MAX_SECONDS", DEFAULTS.sessionMaxSeconds, min, max);
}

/** For display: the configured cap in seconds, or the default if it is unset or invalid. */
export function displayedSessionSeconds(env: Env = process.env): number {
  try {
    return readSessionMaxSeconds(env);
  } catch {
    // The setup notice and the API routes report the invalid value.
    return DEFAULTS.sessionMaxSeconds;
  }
}

/**
 * Reads and validates the server configuration.
 * @throws {ConfigError} when OPENAI_API_KEY is missing or another variable is invalid.
 */
export function readServerConfig(env: Env = process.env): ServerConfig {
  const openaiApiKey = env.OPENAI_API_KEY?.trim();
  if (!openaiApiKey) throw new ConfigError(`OPENAI_API_KEY is not set. ${KEY_HELP}`, "OPENAI_API_KEY");
  checkAppOrigin(env);
  const realtimeModel = readPricedModel(env, "OPENAI_REALTIME_MODEL", DEFAULTS.realtimeModel, REALTIME_PRICES);
  const maxCallCostUsd = readDollars(env, "MAX_CALL_COST_USD", DEFAULTS.maxCallCostUsd, 0.05, 20);
  checkBudget(realtimeModel, maxCallCostUsd);
  return {
    openaiApiKey,
    realtimeModel,
    transcribeModel: readPricedModel(env, "OPENAI_TRANSCRIBE_MODEL", DEFAULTS.transcribeModel, TRANSCRIPTION_PRICES),
    coachingModel: readModel(env, "OPENAI_COACHING_MODEL", DEFAULTS.coachingModel),
    sessionMaxSeconds: readSessionMaxSeconds(env),
    maxCallsPerDay: readWholeNumber(env, "MAX_CALLS_PER_DAY", DEFAULTS.maxCallsPerDay, 1, 100_000),
    maxCallCostUsd,
  };
}

/** The configuration problem to show on the page, or null when the server is ready. Never includes the key. */
export function configProblem(env: Env = process.env): { variable: string; message: string } | null {
  try {
    readServerConfig(env);
    return null;
  } catch (error) {
    if (error instanceof ConfigError) return { variable: error.variable, message: error.message };
    return { variable: "environment", message: "The server configuration could not be read." };
  }
}
