import { readServerConfig } from "./config";
import { redisConfig } from "./redis";
import { allowedOrigins } from "./request-guards";
import { sweepAfterStart } from "./hangup-sweep";

type Env = Record<string, string | undefined>;

/** Warnings about this deployment's setup, logged once at server start. Never includes secrets. */
export function startupWarnings(env: Env = process.env): string[] {
  const warnings: string[] = [];
  const production = env.NODE_ENV === "production";
  const onVercel = env.VERCEL === "1";
  if (production && !onVercel && env.TRUST_PROXY !== "true") {
    warnings.push(
      "TRUST_PROXY is not set, so client IPs can't be trusted and every visitor shares one rate-limit bucket. Behind a reverse proxy that sets X-Forwarded-For, set TRUST_PROXY=true.",
    );
  }
  if (production && !onVercel && !allowedOrigins(env)) {
    warnings.push("APP_ORIGIN is not set, so only localhost pages may call the API. Set APP_ORIGIN to your site's origin.");
  }
  if (production && !redisConfig(env)) {
    warnings.push(
      "No shared store (RATE_LIMIT_REDIS_REST_URL / RATE_LIMIT_REDIS_REST_TOKEN): rate limits are per server process, and a crash or restart forgets the calls in progress, so the server can no longer hang them up.",
    );
  }
  return warnings;
}

/**
 * Logs setup warnings and, with Redis, starts hanging up calls a previous process
 * left behind. The sweep runs in the background so the server starts at once.
 */
export async function runStartupChecks(env: Env = process.env): Promise<void> {
  for (const warning of startupWarnings(env)) console.warn(`[startup] ${warning}`);
  let apiKey: string;
  try {
    apiKey = readServerConfig(env).openaiApiKey;
  } catch {
    return; // The page shows the setup notice.
  }
  if (redisConfig(env)) void sweepAfterStart(apiKey);
}
