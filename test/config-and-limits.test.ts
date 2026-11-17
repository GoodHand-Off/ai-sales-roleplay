import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConfigError,
  configProblem,
  DEFAULTS,
  displayedSessionSeconds,
  HANGUP_DEADLINE_SECONDS,
  readServerConfig,
  ROUTE_MAX_DURATION_SECONDS,
  SESSION_MAX_SECONDS_RANGE,
} from "@/lib/config";
import { checkRateLimit, resetMemoryRateLimits } from "@/lib/rate-limit";

describe("readServerConfig", () => {
  it("needs only OPENAI_API_KEY", () => {
    expect(readServerConfig({ OPENAI_API_KEY: "test-openai-key" })).toEqual({
      openaiApiKey: "test-openai-key",
      realtimeModel: DEFAULTS.realtimeModel,
      transcribeModel: DEFAULTS.transcribeModel,
      coachingModel: DEFAULTS.coachingModel,
      sessionMaxSeconds: 180,
      maxCallsPerDay: 100,
      maxCallCostUsd: 0.5,
    });
  });

  it.each([
    ["SESSION_MAX_SECONDS", "600"],
    ["SESSION_MAX_SECONDS", "12.5"],
    ["SESSION_MAX_SECONDS", "abc"],
    ["SESSION_MAX_SECONDS", "NaN"],
    ["SESSION_MAX_SECONDS", "Infinity"],
    ["MAX_CALLS_PER_DAY", "0"],
    ["MAX_CALLS_PER_DAY", "lots"],
    ["OPENAI_REALTIME_MODEL", "bad model!"],
    ["OPENAI_REALTIME_MODEL", "gpt-unpriced-realtime"],
    ["OPENAI_TRANSCRIBE_MODEL", "gpt-unpriced-transcribe"],
    ["MAX_CALL_COST_USD", "0"],
    ["MAX_CALL_COST_USD", "1e2"],
    ["MAX_CALL_COST_USD", "-1"],
    ["MAX_CALL_COST_USD", "Infinity"],
    ["MAX_CALL_COST_USD", "50"],
    ["APP_ORIGIN", "practice.example.com"],
    ["APP_ORIGIN", "https://example.com/path"],
  ])("rejects %s=%s and names it", (variable, value) => {
    expect(() => readServerConfig({ OPENAI_API_KEY: "k", [variable]: value })).toThrow(ConfigError);
    expect(configProblem({ OPENAI_API_KEY: "secret-value", [variable]: value })).toMatchObject({ variable });
    expect(configProblem({ OPENAI_API_KEY: "secret-value", [variable]: value })?.message).not.toContain("secret-value");
  });

  it("explains a missing key and accepts valid values", () => {
    expect(configProblem({})).toMatchObject({
      variable: "OPENAI_API_KEY",
      message: expect.stringContaining("platform.openai.com/api-keys"),
    });
    expect(configProblem({ OPENAI_API_KEY: "k", APP_ORIGIN: "https://a.example.com, https://b.example.com" })).toBeNull();
    expect(
      readServerConfig({ OPENAI_API_KEY: "k", SESSION_MAX_SECONDS: "60", MAX_CALLS_PER_DAY: "20", MAX_CALL_COST_USD: "1.25" }),
    ).toMatchObject({ sessionMaxSeconds: 60, maxCallsPerDay: 20, maxCallCostUsd: 1.25 });
    expect(
      readServerConfig({ OPENAI_API_KEY: "k", OPENAI_REALTIME_MODEL: "gpt-realtime-2.1", MAX_CALL_COST_USD: "1" }).realtimeModel,
    ).toBe("gpt-realtime-2.1");
  });

  it("refuses a budget below two worst-case replies, naming the variable and the minimum", () => {
    // gpt-realtime-2.1-mini: the longest instructions (4,467 bytes) at $0.60/M + 8,000 tokens at $10/M + 1,024 at $20/M = $0.1032 a reply.
    expect(readServerConfig({ OPENAI_API_KEY: "k", MAX_CALL_COST_USD: "0.21" }).maxCallCostUsd).toBe(0.21);
    const low = configProblem({ OPENAI_API_KEY: "k", MAX_CALL_COST_USD: "0.2" });
    expect(low).toEqual({
      variable: "MAX_CALL_COST_USD",
      message: expect.stringMatching(/up to \$0\.1032.*at least 0\.21\./),
    });
    // The default budget is too small for the full model: the page says how much it needs.
    const full = configProblem({ OPENAI_API_KEY: "k", OPENAI_REALTIME_MODEL: "gpt-realtime-2.1" });
    expect(full?.variable).toBe("MAX_CALL_COST_USD");
    expect(full?.message).toContain("gpt-realtime-2.1 can cost up to $0.3394");
    expect(full?.message).toContain("at least 0.68.");
  });

  it("shows the configured cap, or the default when it is invalid", () => {
    expect(displayedSessionSeconds({})).toBe(180);
    expect(displayedSessionSeconds({ SESSION_MAX_SECONDS: "150" })).toBe(150);
    expect(displayedSessionSeconds({ SESSION_MAX_SECONDS: "nope" })).toBe(180);
  });

  it("keeps the longest cap plus a minute of hang-up retries inside the route's time limit", () => {
    const route = readFileSync("app/api/session/route.ts", "utf8");
    expect(route).toContain(`export const maxDuration = ${ROUTE_MAX_DURATION_SECONDS};`);
    expect(HANGUP_DEADLINE_SECONDS - SESSION_MAX_SECONDS_RANGE.max).toBeGreaterThanOrEqual(60);
    expect(HANGUP_DEADLINE_SECONDS).toBeLessThan(ROUTE_MAX_DURATION_SECONDS);
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => resetMemoryRateLimits());

  it("allows up to the limit and blends in the previous window", async () => {
    const env = {};
    const start = 600_000; // the start of a 60-second window
    for (let i = 0; i < 3; i += 1) {
      expect((await checkRateLimit("t", "ip", 3, 60_000, { env, now: start + 1 })).allowed).toBe(true);
    }
    const blocked = await checkRateLimit("t", "ip", 3, 60_000, { env, now: start + 2 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect((await checkRateLimit("t", "other-ip", 3, 60_000, { env, now: start + 2 })).allowed).toBe(true);
    // Just after the boundary the previous window still counts almost fully: no burst.
    expect((await checkRateLimit("t", "ip", 3, 60_000, { env, now: start + 60_001 })).allowed).toBe(false);
    // Two windows later it is clear.
    expect((await checkRateLimit("t", "ip", 3, 60_000, { env, now: start + 180_000 })).allowed).toBe(true);
  });

  it("can check without counting", async () => {
    const env = {};
    expect((await checkRateLimit("p", "ip", 1, 60_000, { env, now: 5, consume: false })).allowed).toBe(true);
    expect((await checkRateLimit("p", "ip", 1, 60_000, { env, now: 5 })).allowed).toBe(true);
    expect((await checkRateLimit("p", "ip", 1, 60_000, { env, now: 6, consume: false })).allowed).toBe(false);
  });

  it("uses the Redis REST store when configured", async () => {
    const fetchImpl = vi.fn(async () => Response.json([{ result: 4 }, { result: 1 }, { result: null }]));
    const result = await checkRateLimit("t", "ip", 3, 60_000, {
      env: { RATE_LIMIT_REDIS_REST_URL: "https://redis.example.com/", RATE_LIMIT_REDIS_REST_TOKEN: "token" },
      now: 960_000,
      fetchImpl,
    });
    expect(result.allowed).toBe(false);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://redis.example.com/pipeline");
    expect(JSON.parse(String(init.body))[0]).toEqual(["INCR", "rl:t:ip:960000"]);
  });

  it("falls back to memory and logs loudly if the store fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("down", { status: 503 }));
    const result = await checkRateLimit("t", "ip", 1, 60_000, {
      env: { RATE_LIMIT_REDIS_REST_URL: "https://redis.example.com", RATE_LIMIT_REDIS_REST_TOKEN: "token" },
      now: 5,
      fetchImpl,
    });
    expect(result.allowed).toBe(true);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Redis REST store unreachable"));
    errorLog.mockRestore();
  });
});
