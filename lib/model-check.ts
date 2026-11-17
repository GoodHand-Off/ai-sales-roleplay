import { createHash } from "node:crypto";
import { KEY_REJECTED, modelUnavailable, type ApiError } from "./api-errors";
import type { ServerConfig } from "./config";
import { fetchModelStatus } from "./openai";

/** Results are reused this long, so a busy start page doesn't ask OpenAI on every visit. */
export const MODEL_CHECK_CACHE_MS = 60_000;

const cache = new Map<string, { expires: number; problem: ApiError | null }>();

/**
 * Before the microphone opens, asks OpenAI whether the key works and can see
 * each configured model (`GET /v1/models/{model}`, which is free). Returns the
 * problem to show, or null. A 403 (a restricted key without "Models: read"), a
 * rate limit or a network error can't be judged here; the call itself reports
 * those.
 */
export async function modelAccessProblem(
  config: Pick<ServerConfig, "openaiApiKey" | "realtimeModel" | "transcribeModel" | "coachingModel">,
  options: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<ApiError | null> {
  const models = [
    ["OPENAI_REALTIME_MODEL", config.realtimeModel],
    ["OPENAI_TRANSCRIBE_MODEL", config.transcribeModel],
    ["OPENAI_COACHING_MODEL", config.coachingModel],
  ] as const;
  const now = (options.now ?? Date.now)();
  const fingerprint = createHash("sha256").update(config.openaiApiKey).digest("hex").slice(0, 16);
  const cacheKey = `${fingerprint}:${models.map(([, model]) => model).join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now) return cached.problem;

  const statuses = await Promise.all(models.map(([, model]) => fetchModelStatus(config.openaiApiKey, model, options.fetchImpl)));
  let problem: ApiError | null = null;
  if (statuses.includes(401)) problem = KEY_REJECTED;
  else {
    const missing = statuses.indexOf(404);
    if (missing >= 0) problem = modelUnavailable(models[missing]![1], models[missing]![0]);
  }
  cache.set(cacheKey, { expires: now + MODEL_CHECK_CACHE_MS, problem });
  return problem;
}

/** Test helper. */
export function resetModelCheckCache(): void {
  cache.clear();
}
