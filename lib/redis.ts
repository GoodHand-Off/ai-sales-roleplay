/**
 * A minimal client for an Upstash-compatible Redis REST endpoint. Used for rate
 * limits, one-time scorecard tokens and pending hang-ups when
 * RATE_LIMIT_REDIS_REST_URL and RATE_LIMIT_REDIS_REST_TOKEN are set.
 */

type Env = Record<string, string | undefined>;

/** One Redis command, e.g. ["INCR", "key"]. */
export type RedisCommand = (string | number)[];

/** The REST endpoint and token, or null when shared storage is not configured. */
export function redisConfig(env: Env = process.env): { url: string; token: string } | null {
  const { RATE_LIMIT_REDIS_REST_URL: rawUrl, RATE_LIMIT_REDIS_REST_TOKEN: rawToken } = env;
  const url = rawUrl?.trim();
  const token = rawToken?.trim();
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

/**
 * Runs commands in one round trip and returns each command's result.
 * @throws when the store answers with an error or does not answer within 1.5 seconds.
 */
export async function redisPipeline(
  store: { url: string; token: string },
  commands: RedisCommand[],
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  const response = await fetchImpl(`${store.url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${store.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands.map((command) => command.map(String))),
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) throw new Error(`Redis store returned ${response.status}`);
  const results = (await response.json()) as Array<{ result?: unknown; error?: string }>;
  if (!Array.isArray(results) || results.some((entry) => entry?.error)) throw new Error("Redis store returned an error");
  return results.map((entry) => entry.result);
}

let lastOutageLog = 0;

/** Logs a shared-store outage at most once a minute, so it is visible without flooding the log. */
export function logStoreOutage(what: string, now = Date.now()): void {
  if (now - lastOutageLog < 60_000) return;
  lastOutageLog = now;
  console.error(`[store] Redis REST store unreachable; ${what} fall back to this server's memory until it recovers.`);
}
