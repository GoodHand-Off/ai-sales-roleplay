import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { logStoreOutage, redisConfig, redisPipeline } from "./redis";

/**
 * A token that lets the browser ask for one scorecard for a call this server
 * started: one attempt, plus one retry if that attempt fails
 * (MAX_SCORE_ATTEMPTS). It is signed with a key derived from
 * OPENAI_API_KEY, so every server instance can check it without extra setup,
 * and the key itself never leaves the server.
 */

/** What a score token vouches for. `exp` is epoch ms. */
export type ScoreClaims = { callId: string; personaId: string; stageNumber: number; exp: number };

type Env = Record<string, string | undefined>;

/** Scorecard attempts allowed per call: the first, and one retry after a failure. */
export const MAX_SCORE_ATTEMPTS = 2;

/** In-memory claims when Redis isn't configured: whether one is held, and how many attempts were made. */
const used = new Map<string, { expiresAt: number; held: boolean; attempts: number }>();

function signingKey(apiKey: string): Buffer {
  return createHash("sha256").update(`ai-sales-roleplay:score-token:${apiKey}`).digest();
}

function sign(payload: string, apiKey: string): string {
  return createHmac("sha256", signingKey(apiKey)).update(payload).digest("base64url");
}

/** Issues a token for one scorecard of one call. */
export function issueScoreToken(claims: ScoreClaims, apiKey: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, apiKey)}`;
}

/** Returns the claims if the token is genuine and not expired, otherwise null. */
export function verifyScoreToken(token: unknown, apiKey: string, now = Date.now()): ScoreClaims | null {
  if (typeof token !== "string" || token.length > 1_024) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload, apiKey));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<ScoreClaims>;
    if (
      typeof claims.callId !== "string" ||
      typeof claims.personaId !== "string" ||
      typeof claims.stageNumber !== "number" ||
      typeof claims.exp !== "number" ||
      claims.exp <= now
    ) {
      return null;
    }
    return claims as ScoreClaims;
  } catch {
    return null;
  }
}

/**
 * Claims a token for one scorecard attempt. Returns false while another attempt
 * holds it, after a successful one, or once MAX_SCORE_ATTEMPTS attempts were
 * made. Shared across instances through Redis when configured; otherwise per
 * process.
 */
export async function claimScoreToken(
  callId: string,
  ttlMs: number,
  options: { env?: Env; now?: number; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const ttl = Math.max(1, Math.round(ttlMs));
  const store = redisConfig(options.env ?? process.env);
  if (store) {
    try {
      const [held] = await redisPipeline(store, [["SET", `ai-sales-roleplay:scored:${callId}`, 1, "NX", "PX", ttl]], options.fetchImpl);
      if (held !== "OK") return false;
      const [attempts] = await redisPipeline(
        store,
        [
          ["INCR", `ai-sales-roleplay:score-attempts:${callId}`],
          ["PEXPIRE", `ai-sales-roleplay:score-attempts:${callId}`, ttl],
        ],
        options.fetchImpl,
      );
      // Past the limit, the claim stays held, so later requests stop at the first step.
      return Number(attempts) <= MAX_SCORE_ATTEMPTS;
    } catch {
      logStoreOutage("one-time scorecard tokens");
    }
  }
  for (const [id, entry] of used) if (entry.expiresAt <= now) used.delete(id);
  const entry = used.get(callId) ?? { expiresAt: now + ttl, held: false, attempts: 0 };
  if (entry.held || entry.attempts >= MAX_SCORE_ATTEMPTS) return false;
  used.set(callId, { ...entry, held: true, attempts: entry.attempts + 1 });
  return true;
}

/** Releases a claim after a failed attempt, so the visitor can retry while attempts remain. */
export async function releaseScoreToken(callId: string, options: { env?: Env; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const entry = used.get(callId);
  if (entry) used.set(callId, { ...entry, held: false });
  const store = redisConfig(options.env ?? process.env);
  if (!store) return;
  try {
    await redisPipeline(store, [["DEL", `ai-sales-roleplay:scored:${callId}`]], options.fetchImpl);
  } catch {
    logStoreOutage("one-time scorecard tokens");
  }
}

/** Test helper. */
export function resetUsedScoreTokens(): void {
  used.clear();
}
