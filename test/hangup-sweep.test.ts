import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scheduled: Array<() => Promise<void>> = [];
vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => scheduled.push(task) }));
const hangupRealtimeCall = vi.fn();
vi.mock("@/lib/openai", () => ({ hangupRealtimeCall }));

const { scheduleSweep, STARTUP_SWEEP_INTERVAL_MS, STARTUP_SWEEP_MS, sweepAfterStart, sweepHangups } = await import("@/lib/hangup-sweep");
const { beatMonitor, callsToSweep, forgetHangup, MONITOR_TTL_MS, releaseMonitor, rememberHangup, resetPendingHangups } =
  await import("@/lib/pending-hangups");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  scheduled.length = 0;
  hangupRealtimeCall.mockReset();
  resetPendingHangups();
  vi.restoreAllMocks();
});

describe("pending calls and monitor heartbeats", () => {
  it("sweeps calls past their deadline or without a heartbeat, never a watched one", async () => {
    const now = 1_000_000;
    await rememberHangup("watched", now + 60_000, { now: () => now });
    await rememberHangup("overdue", now - 10_000, { now: () => now });
    await rememberHangup("orphan", now + 60_000, { now: () => now - MONITOR_TTL_MS - 1 });
    expect(await callsToSweep(now, { now: () => now })).toEqual({ callIds: ["overdue", "orphan"], pending: 3 });

    // The watched call's monitor keeps beating; once it stops, the call is swept.
    const later = now + MONITOR_TTL_MS + 1;
    await beatMonitor("watched", { now: () => later - 1 });
    expect((await callsToSweep(now, { now: () => later })).callIds).not.toContain("watched");
    await releaseMonitor("watched");
    expect((await callsToSweep(now, { now: () => later })).callIds).toContain("watched");
    await forgetHangup("watched");
    expect((await callsToSweep(now, { now: () => later })).pending).toBe(2);
  });

  it("uses a sorted set and expiring heartbeat keys in Redis", async () => {
    const env = { RATE_LIMIT_REDIS_REST_URL: "https://r.example.com", RATE_LIMIT_REDIS_REST_TOKEN: "t" };
    const bodies: unknown[][] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as unknown[][];
      bodies.push(...commands);
      if (commands[0]![0] === "ZRANGE") return Response.json([{ result: ["live", "100", "dead", "200"] }]);
      if (commands[0]![0] === "EXISTS") return Response.json([{ result: 1 }, { result: 0 }]);
      return Response.json(commands.map(() => ({ result: "OK" })));
    }) as unknown as typeof fetch;
    await rememberHangup("live", 100, { env, fetchImpl });
    await beatMonitor("live", { env, fetchImpl });
    await releaseMonitor("live", { env, fetchImpl });
    await forgetHangup("live", { env, fetchImpl });
    expect(await callsToSweep(50, { env, fetchImpl })).toEqual({ callIds: ["dead"], pending: 2 });
    expect(bodies).toEqual([
      ["ZADD", "ai-sales-roleplay:pending-hangups", "100", "live"],
      ["SET", "ai-sales-roleplay:monitor:live", "1", "PX", String(MONITOR_TTL_MS)],
      ["SET", "ai-sales-roleplay:monitor:live", "1", "PX", String(MONITOR_TTL_MS)],
      ["DEL", "ai-sales-roleplay:monitor:live"],
      ["ZREM", "ai-sales-roleplay:pending-hangups", "live"],
      ["DEL", "ai-sales-roleplay:monitor:live"],
      ["ZRANGE", "ai-sales-roleplay:pending-hangups", "0", "-1", "WITHSCORES"],
      ["EXISTS", "ai-sales-roleplay:monitor:live"],
      ["EXISTS", "ai-sales-roleplay:monitor:dead"],
    ]);
  });

  it("looks at every pending call, not only the earliest deadlines (re-review nit 14)", async () => {
    const now = 1_000_000;
    for (let index = 0; index < 250; index += 1) await rememberHangup(`watched${index}`, now + 60_000 + index, { now: () => now });
    await rememberHangup("orphan-last", now + 120_000, { now: () => now - MONITOR_TTL_MS - 1 });
    expect(await callsToSweep(now, { now: () => now })).toEqual({ callIds: ["orphan-last"], pending: 251 });

    const env = { RATE_LIMIT_REDIS_REST_URL: "https://r.example.com", RATE_LIMIT_REDIS_REST_TOKEN: "t" };
    const members = Array.from({ length: 450 }, (_, index) => [`c${index}`, String(now + index)]).flat();
    const existsBatches: number[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const commands = JSON.parse(String(init?.body)) as string[][];
      if (commands[0]![0] === "ZRANGE") return Response.json([{ result: members }]);
      existsBatches.push(commands.length);
      return Response.json(commands.map(([, key]) => ({ result: key === "ai-sales-roleplay:monitor:c449" ? 0 : 1 })));
    }) as unknown as typeof fetch;
    expect(await callsToSweep(now - 1, { env, fetchImpl })).toEqual({ callIds: ["c449"], pending: 450 });
    expect(existsBatches).toEqual([200, 200, 50]);
  });
});

describe("sweepHangups", () => {
  it("hangs up the calls to sweep and forgets the ones that ended", async () => {
    const hangup = vi.fn(async (callId: string) => (callId === "stuck" ? ("failed" as const) : ("ended" as const)));
    const forget = vi.fn<(callId: string) => Promise<void>>(async () => {});
    const toSweep = vi.fn(async () => ({ callIds: ["a", "stuck", "b"], pending: 4 }));
    await expect(sweepHangups("k", { now: () => 100_000, hangup, forget, toSweep })).resolves.toEqual({ swept: 2, pending: 2 });
    expect(toSweep).toHaveBeenCalledWith(95_000);
    expect(forget.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("hands the sweep to after(), which hangs up calls left behind with the server key", async () => {
    hangupRealtimeCall.mockResolvedValue("already-ended");
    await rememberHangup("rtc_orphan", Date.now() - 60_000);
    scheduleSweep("server-key");
    await scheduled[0]!();
    expect(hangupRealtimeCall).toHaveBeenCalledWith({ apiKey: "server-key", callId: "rtc_orphan" });
    expect((await callsToSweep(Date.now())).pending).toBe(0);
  });
});

describe("sweepAfterStart", () => {
  it("keeps sweeping while calls are pending, so a call whose monitor died in a restart is hung up once its heartbeat lapses", async () => {
    let now = 0;
    const lapsed = new Set<string>();
    const hangup = vi.fn(async () => "ended" as const);
    const forget = vi.fn(async (callId: string) => void lapsed.add(callId));
    // Call B's old heartbeat lasts 25 s after the restart; it is not due for minutes.
    const toSweep = vi.fn(async () => (now >= MONITOR_TTL_MS && !lapsed.has("B") ? { callIds: ["B"], pending: 1 } : { callIds: [], pending: lapsed.has("B") ? 0 : 1 }));
    const wait = vi.fn(async (ms: number) => {
      now += ms;
    });
    await sweepAfterStart("k", { now: () => now, hangup, forget, toSweep, wait });
    expect(hangup).toHaveBeenCalledTimes(1);
    expect(now).toBe(3 * STARTUP_SWEEP_INTERVAL_MS);
  });

  it("stops after STARTUP_SWEEP_MS even if a call can't be hung up", async () => {
    let now = 0;
    const wait = vi.fn(async (ms: number) => {
      now += ms;
    });
    await sweepAfterStart("k", {
      now: () => now,
      hangup: async () => "failed",
      forget: async () => {},
      toSweep: async () => ({ callIds: ["stuck"], pending: 1 }),
      wait,
    });
    expect(now).toBeLessThanOrEqual(STARTUP_SWEEP_MS);
    expect(wait.mock.calls.length).toBe(STARTUP_SWEEP_MS / STARTUP_SWEEP_INTERVAL_MS);
  });

  it("survives a store outage", async () => {
    await expect(
      sweepAfterStart("k", {
        now: () => 0,
        hangup: async () => "ended",
        forget: async () => {},
        toSweep: async () => {
          throw new Error("store down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
