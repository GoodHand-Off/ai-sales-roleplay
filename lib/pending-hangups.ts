import { logStoreOutage, redisConfig, redisPipeline } from "./redis";

/**
 * Calls the server still has to hang up, with their deadlines, and a heartbeat
 * from the monitor watching each one (lib/call-monitor.ts). A sweep
 * (lib/hangup-sweep.ts) hangs up any pending call that is past its deadline or
 * whose monitor has stopped beating: a crash, a restart, a frozen serverless
 * instance. With Redis configured this survives restarts and is shared by every
 * instance. Without Redis it lives in memory and dies with the process.
 */

type Env = Record<string, string | undefined>;
type Options = { env?: Env; fetchImpl?: typeof fetch; now?: () => number };

const KEY = "ai-sales-roleplay:pending-hangups";
const MONITOR_PREFIX = "ai-sales-roleplay:monitor:";
/** A monitor beats every MONITOR_BEAT_MS; a call whose beat is older than MONITOR_TTL_MS has no monitor. */
export const MONITOR_BEAT_MS = 10_000;
export const MONITOR_TTL_MS = 25_000;

const pending = new Map<string, number>();
const beats = new Map<string, number>();

async function withStore<T>(options: Options, viaRedis: (store: { url: string; token: string }) => Promise<T>, viaMemory: () => T): Promise<T> {
  const store = redisConfig(options.env ?? process.env);
  if (store) {
    try {
      return await viaRedis(store);
    } catch {
      logStoreOutage("pending hang-ups");
    }
  }
  return viaMemory();
}

/** Records that `callId` must be hung up at `endsAt` (epoch ms), with a first heartbeat. */
export function rememberHangup(callId: string, endsAt: number, options: Options = {}): Promise<void> {
  const now = (options.now ?? Date.now)();
  return withStore(
    options,
    async (store) => {
      await redisPipeline(
        store,
        [
          ["ZADD", KEY, endsAt, callId],
          ["SET", MONITOR_PREFIX + callId, "1", "PX", MONITOR_TTL_MS],
        ],
        options.fetchImpl,
      );
    },
    () => {
      pending.set(callId, endsAt);
      beats.set(callId, now + MONITOR_TTL_MS);
    },
  );
}

/** The monitor's heartbeat for `callId`. */
export function beatMonitor(callId: string, options: Options = {}): Promise<void> {
  const now = (options.now ?? Date.now)();
  return withStore(
    options,
    async (store) => {
      await redisPipeline(store, [["SET", MONITOR_PREFIX + callId, "1", "PX", MONITOR_TTL_MS]], options.fetchImpl);
    },
    () => {
      beats.set(callId, now + MONITOR_TTL_MS);
    },
  );
}

/** Stops the heartbeat for `callId`; a sweep may now hang it up if it is still pending. */
export function releaseMonitor(callId: string, options: Options = {}): Promise<void> {
  return withStore(
    options,
    async (store) => {
      await redisPipeline(store, [["DEL", MONITOR_PREFIX + callId]], options.fetchImpl);
    },
    () => {
      beats.delete(callId);
    },
  );
}

/** Removes `callId` once its hang-up is confirmed. */
export function forgetHangup(callId: string, options: Options = {}): Promise<void> {
  return withStore(
    options,
    async (store) => {
      await redisPipeline(
        store,
        [
          ["ZREM", KEY, callId],
          ["DEL", MONITOR_PREFIX + callId],
        ],
        options.fetchImpl,
      );
    },
    () => {
      pending.delete(callId);
      beats.delete(callId);
    },
  );
}

/** EXISTS checks per Redis round trip. */
const EXISTS_BATCH = 200;

/**
 * Pending calls a sweep should hang up: past `overdueBefore` (epoch ms), or with
 * no monitor heartbeat. Looks at every pending call (normally only those started
 * in the last few minutes). Also returns how many are pending.
 */
export function callsToSweep(overdueBefore: number, options: Options = {}): Promise<{ callIds: string[]; pending: number }> {
  const now = (options.now ?? Date.now)();
  return withStore(
    options,
    async (store) => {
      const [entries] = await redisPipeline(store, [["ZRANGE", KEY, 0, -1, "WITHSCORES"]], options.fetchImpl);
      const flat = Array.isArray(entries) ? entries.map(String) : [];
      const calls: Array<{ callId: string; endsAt: number }> = [];
      for (let index = 0; index + 1 < flat.length; index += 2) {
        calls.push({ callId: flat[index]!, endsAt: Number(flat[index + 1]) });
      }
      const alive: unknown[] = [];
      for (let start = 0; start < calls.length; start += EXISTS_BATCH) {
        const batch = calls.slice(start, start + EXISTS_BATCH);
        alive.push(...(await redisPipeline(store, batch.map(({ callId }) => ["EXISTS", MONITOR_PREFIX + callId]), options.fetchImpl)));
      }
      return {
        callIds: calls.filter(({ endsAt }, index) => endsAt < overdueBefore || Number(alive[index]) !== 1).map(({ callId }) => callId),
        pending: calls.length,
      };
    },
    () => ({
      callIds: [...pending.entries()]
        .sort((a, b) => a[1] - b[1])
        .filter(([callId, endsAt]) => endsAt < overdueBefore || (beats.get(callId) ?? 0) <= now)
        .map(([callId]) => callId),
      pending: pending.size,
    }),
  );
}

/** Test helper. */
export function resetPendingHangups(): void {
  pending.clear();
  beats.clear();
}
