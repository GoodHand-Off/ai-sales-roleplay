import { logStoreOutage, redisConfig, redisPipeline } from "./redis";

/**
 * Sliding-window rate limits. The count for the current window is blended with
 * the previous window's count, weighted by how much of it still overlaps, so a
 * burst can't double up across a window boundary.
 *
 * Counts live in Redis when RATE_LIMIT_REDIS_REST_URL and
 * RATE_LIMIT_REDIS_REST_TOKEN are set, so every server instance shares them.
 * Otherwise they live in this process's memory, which is right for one machine.
 */

/** Whether the request may go ahead, and how long to wait if not. */
export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

type Env = Record<string, string | undefined>;

type Options = {
  env?: Env;
  now?: number;
  fetchImpl?: typeof fetch;
  /** False to check the limit without counting this request (used before opening the microphone). */
  consume?: boolean;
};

const memory = new Map<string, { count: number; expiresAt: number }>();

function keys(bucket: string, key: string, windowMs: number, now: number) {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return {
    current: `rl:${bucket}:${key}:${windowStart}`,
    previous: `rl:${bucket}:${key}:${windowStart - windowMs}`,
    resetAt: windowStart + windowMs,
    overlap: 1 - (now - windowStart) / windowMs,
  };
}

function memoryCount(id: string, now: number): number {
  const entry = memory.get(id);
  return entry && entry.expiresAt > now ? entry.count : 0;
}

function memoryCounts(current: string, previous: string, resetAt: number, windowMs: number, consume: boolean, now: number) {
  if (memory.size > 10_000) {
    for (const [id, entry] of memory) if (entry.expiresAt <= now) memory.delete(id);
  }
  let count = memoryCount(current, now);
  if (consume) {
    count += 1;
    // Kept for two windows: it is the "previous" window during the next one.
    memory.set(current, { count, expiresAt: resetAt + windowMs });
  }
  return { current: count, previous: memoryCount(previous, now) };
}

async function redisCounts(
  store: { url: string; token: string },
  current: string,
  previous: string,
  resetAt: number,
  windowMs: number,
  consume: boolean,
  fetchImpl: typeof fetch,
) {
  const commands = consume
    ? [["INCR", current], ["PEXPIREAT", current, resetAt + windowMs], ["GET", previous]]
    : [["GET", current], ["GET", previous]];
  const results = await redisPipeline(store, commands, fetchImpl);
  const currentCount = Number(results[0] ?? 0);
  const previousCount = Number(results[consume ? 2 : 1] ?? 0);
  if (!Number.isFinite(currentCount) || !Number.isFinite(previousCount)) throw new Error("Redis returned no count");
  return { current: currentCount, previous: previousCount };
}

/**
 * Counts one request for `key` in `bucket` and says whether it is within
 * `limit` per `windowMs`. Pass `consume: false` to check without counting.
 */
export async function checkRateLimit(
  bucket: string,
  key: string,
  limit: number,
  windowMs: number,
  options: Options = {},
): Promise<RateLimitResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const consume = options.consume ?? true;
  const { current, previous, resetAt, overlap } = keys(bucket, key, windowMs, now);

  let counts: { current: number; previous: number } | null = null;
  const store = redisConfig(env);
  if (store) {
    try {
      counts = await redisCounts(store, current, previous, resetAt, windowMs, consume, options.fetchImpl ?? fetch);
    } catch {
      logStoreOutage("rate limits");
    }
  }
  counts ??= memoryCounts(current, previous, resetAt, windowMs, consume, now);

  const estimate = counts.previous * overlap + counts.current;
  // When only checking, the request that follows would add one more.
  const allowed = consume ? estimate <= limit : estimate + 1 <= limit;
  return { allowed, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
}

/** Test helper. */
export function resetMemoryRateLimits(): void {
  memory.clear();
}
