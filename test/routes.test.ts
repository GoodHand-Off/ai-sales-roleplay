import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scheduleSweep = vi.fn();
vi.mock("@/lib/hangup-sweep", () => ({ scheduleSweep }));
const monitorStart = vi.fn();
vi.mock("@/lib/call-monitor", () => ({ CallMonitor: { start: monitorStart } }));
const afterTasks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => afterTasks.push(task),
}));

const { GET: sessionGET, POST: sessionPOST } = await import("@/app/api/session/route");
const { POST: scorePOST } = await import("@/app/api/score/route");
const { resetMemoryRateLimits } = await import("@/lib/rate-limit");
const { callsToSweep, resetPendingHangups } = await import("@/lib/pending-hangups");
const { resetModelCheckCache } = await import("@/lib/model-check");
const { resetUsedScoreTokens, verifyScoreToken } = await import("@/lib/score-token");

const ORIGIN = "http://localhost:3000";
const KEY = "test-openai-key";
const OFFER = "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n";
const ANSWER = "v=0\r\no=- 3 4 IN IP4 127.0.0.1\r\n";

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(text)),
      origin: ORIGIN,
      ...headers,
    },
    body: text,
  });
}

const fetchMock = vi.fn<typeof fetch>();

function answerOnce(callId = "rtc_live1") {
  fetchMock.mockResolvedValueOnce(
    new Response(ANSWER, { status: 201, headers: { Location: `/v1/realtime/calls/${callId}` } }),
  );
}

beforeEach(() => {
  resetMemoryRateLimits();
  resetPendingHangups();
  resetUsedScoreTokens();
  resetModelCheckCache();
  scheduleSweep.mockReset();
  afterTasks.length = 0;
  monitorStart.mockReset();
  monitorStart.mockResolvedValue({ finished: Promise.resolve({ reason: "call_ended" }) });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("OPENAI_API_KEY", KEY);
  vi.stubEnv("SESSION_MAX_SECONDS", "");
  vi.stubEnv("MAX_CALLS_PER_DAY", "");
  vi.stubEnv("TRUST_PROXY", "");
  vi.stubEnv("APP_ORIGIN", "");
  vi.stubEnv("VERCEL", "");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/session", () => {
  const valid = { personaId: "sarah-chen", stageNumber: 1, sdp: OFFER };

  it("rejects other origins (including rebinding names) and origin-less requests before any upstream call", async () => {
    expect((await sessionPOST(post("/api/session", valid, { origin: "https://evil.example" }))).status).toBe(403);
    expect(
      (await sessionPOST(post("/api/session", valid, { origin: "http://rebind.example:3000", host: "rebind.example:3000" }))).status,
    ).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/session`, { method: "POST", body: JSON.stringify(valid) });
    expect((await sessionPOST(noOrigin)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the missing variable and where to get it when no key is configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const response = await sessionPOST(post("/api/session", valid));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.code).toBe("config");
    expect(body.error).toMatch(/OPENAI_API_KEY is not set/);
    expect(body.error).toMatch(/platform\.openai\.com\/api-keys/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "{", 400],
    ["no SDP", { personaId: "sarah-chen", stageNumber: 1 }, 400],
    ["SDP that is not SDP", { personaId: "sarah-chen", stageNumber: 1, sdp: "hello" }, 400],
    ["oversized body", { personaId: "sarah-chen", stageNumber: 1, sdp: `v=0${"a".repeat(70_000)}` }, 413],
    ["fractional stage", { personaId: "sarah-chen", stageNumber: 1.5, sdp: OFFER }, 400],
  ])("returns %s as %i", async (_label, body, status) => {
    expect((await sessionPOST(post("/api/session", body))).status).toBe(status);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a Content-Length", async () => {
    const request = new Request(`${ORIGIN}/api/session`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    expect((await sessionPOST(request)).status).toBe(411);
  });

  it("returns 404 for an unknown persona or stage", async () => {
    expect((await sessionPOST(post("/api/session", { ...valid, personaId: "nobody" }))).status).toBe(404);
    expect((await sessionPOST(post("/api/session", { ...valid, stageNumber: 9 }))).status).toBe(404);
  });

  it("starts the call, connects its monitor, keeps the call ID on the server and issues a score token", async () => {
    vi.stubEnv("SESSION_MAX_SECONDS", "90");
    vi.stubEnv("MAX_CALL_COST_USD", "0.75");
    answerOnce();
    const before = Date.now();
    const response = await sessionPOST(post("/api/session", valid));
    const after = Date.now();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = await response.json();
    expect(payload).toMatchObject({ answerSdp: ANSWER, maxSeconds: 90 });
    expect(payload).not.toHaveProperty("callId");
    expect(payload).not.toHaveProperty("endsAt");

    const [options] = monitorStart.mock.calls[0] as [
      { callId: string; apiKey: string; endsAt: number; giveUpAt: number; limits: Record<string, unknown> },
    ];
    expect(options.callId).toBe("rtc_live1");
    expect(options.apiKey).toBe(KEY);
    expect(options.endsAt).toBeGreaterThanOrEqual(before + 90_000);
    expect(options.endsAt).toBeLessThanOrEqual(after + 90_000);
    expect(options.giveUpAt - options.endsAt).toBe(200_000);
    expect(options.limits).toMatchObject({ model: "gpt-realtime-2.1-mini", budgetUsd: 0.75, maxOutputTokens: 1_024, maxInputTokens: 8_000 });
    expect(options.limits.instructions).toContain("Sarah Chen");
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]!();
    expect(scheduleSweep).toHaveBeenCalledWith(KEY);
    expect((await callsToSweep(options.endsAt + 10_000)).callIds).toEqual(["rtc_live1"]);

    expect(verifyScoreToken(payload.scoreToken, KEY)).toMatchObject({ callId: "rtc_live1", personaId: "sarah-chen", stageNumber: 1 });
    const [, init] = fetchMock.mock.calls[0]!;
    const session = JSON.parse(String((init?.body as FormData).get("session")));
    expect(session.instructions).toContain("Sarah Chen");
    expect(session.truncation).toEqual({ type: "retention_ratio", retention_ratio: 0.8, token_limits: { post_instructions: 8_000 } });
  });

  it("hangs the call up and refuses it when the monitor can't connect", async () => {
    answerOnce("rtc_nomon");
    monitorStart.mockRejectedValueOnce(new Error("Sideband connection timed out"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const response = await sessionPOST(post("/api/session", valid));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "monitor_unavailable", error: "Could not start the call. Try again in a moment." });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/realtime/calls/rtc_nomon/hangup");
    expect((await callsToSweep(Number.MAX_SAFE_INTEGER)).pending).toBe(0);
    expect(afterTasks).toHaveLength(0);
  });

  it("leaves a refused call pending for a sweep when its hang-up fails too", async () => {
    answerOnce("rtc_stuck");
    monitorStart.mockRejectedValueOnce(new Error("Sideband connection failed"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect((await sessionPOST(post("/api/session", valid))).status).toBe(502);
    expect((await callsToSweep(Number.MAX_SAFE_INTEGER)).callIds).toEqual(["rtc_stuck"]);
  });

  it.each([
    [401, "openai_key_rejected", 502, /OpenAI rejected the server's API key \(OPENAI_API_KEY\)/],
    [403, "openai_key_forbidden", 502, /restricted key/],
    [404, "openai_model_unavailable", 502, /isn't available to this OpenAI key's project/],
    [429, "openai_rate_limited", 503, /rate limit or the project's budget/],
    [500, "upstream", 502, /Could not start the call/],
  ])("turns an OpenAI %i into an actionable %s message and starts no monitor", async (upstream, code, status, message) => {
    fetchMock.mockResolvedValueOnce(new Response("upstream body with org_secret detail", { status: upstream }));
    const response = await sessionPOST(post("/api/session", valid));
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(code);
    expect(body.error).toMatch(message);
    expect(JSON.stringify(body)).not.toContain("org_secret");
    expect(monitorStart).not.toHaveBeenCalled();
  });

  it("doesn't count invalid requests against the daily limit", async () => {
    vi.stubEnv("MAX_CALLS_PER_DAY", "1");
    for (let i = 0; i < 8; i += 1) {
      expect((await sessionPOST(post("/api/session", {}))).status).toBe(400);
    }
    answerOnce();
    expect((await sessionPOST(post("/api/session", valid))).status).toBe(200);
  });

  it("checks the client's own limits before the daily one, so a busy client can't use up the day", async () => {
    vi.stubEnv("MAX_CALLS_PER_DAY", "3");
    vi.stubEnv("TRUST_PROXY", "true");
    fetchMock.mockImplementation(
      async () => new Response(ANSWER, { status: 201, headers: { Location: "/v1/realtime/calls/rtc_busy" } }),
    );
    const busy = { "x-forwarded-for": "10.0.0.1" };
    expect((await sessionPOST(post("/api/session", valid, busy))).status).toBe(200);
    expect((await sessionPOST(post("/api/session", valid, busy))).status).toBe(200);
    for (let i = 0; i < 5; i += 1) expect((await sessionPOST(post("/api/session", valid, busy))).status).toBe(429);
    expect((await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "10.0.0.2" }))).status).toBe(200);
  });

  it("does not trust a client-sent X-Forwarded-For: changing it doesn't buy more calls", async () => {
    fetchMock.mockImplementation(
      async () => new Response(ANSWER, { status: 201, headers: { Location: "/v1/realtime/calls/rtc_x" } }),
    );
    for (let i = 0; i < 2; i += 1) {
      expect((await sessionPOST(post("/api/session", valid, { "x-forwarded-for": `198.51.100.${i}` }))).status).toBe(200);
    }
    const blocked = await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "198.51.100.99" }));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/running from this network/);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("separates clients behind a trusted proxy", async () => {
    vi.stubEnv("TRUST_PROXY", "true");
    fetchMock.mockImplementation(
      async () => new Response(ANSWER, { status: 201, headers: { Location: "/v1/realtime/calls/rtc_y" } }),
    );
    for (let i = 0; i < 2; i += 1) {
      expect((await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "spoof, 10.0.0.1" }))).status).toBe(200);
    }
    expect((await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "spoof, 10.0.0.1" }))).status).toBe(429);
    expect((await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "spoof, 10.0.0.2" }))).status).toBe(200);
  });

  it("stops every caller at MAX_CALLS_PER_DAY", async () => {
    vi.stubEnv("MAX_CALLS_PER_DAY", "1");
    vi.stubEnv("TRUST_PROXY", "true");
    answerOnce();
    expect((await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "10.0.0.1" }))).status).toBe(200);
    const blocked = await sessionPOST(post("/api/session", valid, { "x-forwarded-for": "10.0.0.2" }));
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toMatch(/daily call limit/);
  });

  it("never puts the API key in a response or a log line", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    answerOnce("rtc_k");
    const ok = await sessionPOST(post("/api/session", valid));
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));
    const rejected = await sessionPOST(post("/api/session", valid));
    vi.stubEnv("SESSION_MAX_SECONDS", "abc");
    const misconfigured = await sessionPOST(post("/api/session", valid));
    for (const response of [ok, rejected, misconfigured]) {
      expect(await response.text()).not.toContain(KEY);
    }
    expect(JSON.stringify([...errorLog.mock.calls, ...warnLog.mock.calls])).not.toContain(KEY);
  });
});

describe("GET /api/session (preflight)", () => {
  // A browser's same-origin fetch: no Origin header on a GET, but Sec-Fetch-Site.
  const preflight = (headers: Record<string, string> = { "sec-fetch-site": "same-origin", host: "localhost:3000" }) =>
    sessionGET(new Request(`${ORIGIN}/api/session`, { headers }));

  it("refuses other sites, rebinding names and header-less requests before any upstream call (re-review item 9)", async () => {
    const refused: Array<Record<string, string>> = [
      {},
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site", host: "localhost:3000" },
      { "sec-fetch-site": "same-site", host: "localhost:3000" },
      { "sec-fetch-site": "same-origin", host: "rebind.example:3000" },
      { "sec-fetch-site": "same-origin" },
    ];
    for (const headers of refused) expect((await preflight(headers)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockImplementation(async () => Response.json({ id: "model" }));
    expect((await preflight({ origin: ORIGIN })).status).toBe(200);
    expect((await preflight({ "sec-fetch-site": "same-origin", host: "127.0.0.1:3000" })).status).toBe(200);
    vi.stubEnv("APP_ORIGIN", "https://practice.example.com");
    expect((await preflight({ "sec-fetch-site": "same-origin", host: "practice.example.com" })).status).toBe(200);
    expect((await preflight({ origin: "http://localhost:3000" })).status).toBe(403);
    // A rebinding page is same-origin with itself, so its Host is checked too (re-check item C).
    expect((await preflight({ "sec-fetch-site": "same-origin", host: "rebind.example" })).status).toBe(403);
    // Behind a trusted proxy the browser's host arrives in X-Forwarded-Host; without TRUST_PROXY that header is ignored.
    const proxied = { "sec-fetch-site": "same-origin", host: "127.0.0.1:3000", "x-forwarded-host": "practice.example.com" };
    expect((await preflight(proxied)).status).toBe(403);
    vi.stubEnv("TRUST_PROXY", "true");
    expect((await preflight(proxied)).status).toBe(200);
    expect((await preflight({ ...proxied, "x-forwarded-host": "rebind.example" })).status).toBe(403);
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "kit-preview.example.test");
    expect((await preflight({ "sec-fetch-site": "same-origin", host: "kit-preview.example.test" })).status).toBe(200);
    expect((await preflight({ "sec-fetch-site": "same-origin", host: "rebind.example" })).status).toBe(403);
  });

  it("rate limits checks per client (re-review item 9)", async () => {
    fetchMock.mockImplementation(async () => Response.json({ id: "model" }));
    for (let i = 0; i < 30; i += 1) expect((await preflight()).status).toBe(200);
    const limited = await preflight();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await limited.json()).error).toMatch(/Too many checks/);
  });

  it("reports ready without counting a call, and asks OpenAI about the models at most once a minute", async () => {
    vi.stubEnv("MAX_CALLS_PER_DAY", "1");
    fetchMock.mockImplementation(async () => Response.json({ id: "model" }));
    for (let i = 0; i < 3; i += 1) expect(await (await preflight()).json()).toEqual({ ready: true });
    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://api.openai.com/v1/models/gpt-realtime-2.1-mini",
      "https://api.openai.com/v1/models/gpt-transcribe",
      "https://api.openai.com/v1/models/gpt-6-luna",
    ]);
  });

  it("catches a wrong key before the microphone opens", async () => {
    fetchMock.mockImplementation(async () => new Response("bad key", { status: 401 }));
    const response = await preflight();
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("openai_key_rejected");
  });

  it("names the model and variable the key's project can't use", async () => {
    vi.stubEnv("OPENAI_COACHING_MODEL", "gpt-not-there");
    fetchMock.mockImplementation(async (url) => new Response(null, { status: String(url).endsWith("gpt-not-there") ? 404 : 200 }));
    const body = await (await preflight()).json();
    expect(body.code).toBe("openai_model_unavailable");
    expect(body.error).toContain('"gpt-not-there" (OPENAI_COACHING_MODEL)');
  });

  it("lets a restricted key without model-list access through; the call reports any real problem", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 403 }));
    expect(await (await preflight()).json()).toEqual({ ready: true });
  });

  it("reports a missing key or a reached limit before the microphone opens", async () => {
    vi.stubEnv("MAX_CALLS_PER_DAY", "1");
    answerOnce();
    await sessionPOST(post("/api/session", { personaId: "sarah-chen", stageNumber: 1, sdp: OFFER }));
    expect((await preflight()).status).toBe(429);
    vi.stubEnv("OPENAI_API_KEY", "");
    const missing = await preflight();
    expect(missing.status).toBe(500);
    expect((await missing.json()).error).toMatch(/OPENAI_API_KEY/);
  });
});

describe("POST /api/score", () => {
  const transcript = [
    { speaker: "homeowner", text: "Oh god, yeah, I saw the damage. What do you want?" },
    { speaker: "rep", text: "I'm working with your neighbors on storm damage and noticed your gutters." },
    { speaker: "homeowner", text: "How do I know you're not trying to scare me?" },
    { speaker: "rep", text: "Fair question. Here's my license number and photos from next door." },
  ];
  const modelResult = {
    headline: "Proof earned the inspection.",
    trustScore: 7,
    outcome: "advanced",
    whatWorked: [{ quote: "Here's my license number", why: "Proof first." }],
    biggestFix: { quote: "noticed your gutters", why: "Lead with her stain, not your pitch." },
    tryInstead: "You mentioned a stain upstairs; can I show you what causes that?",
    objections: ["Scare tactics"],
  };

  let callCounter = 0;
  async function startCall() {
    callCounter += 1;
    resetMemoryRateLimits();
    answerOnce(`rtc_call${callCounter}`);
    const response = await sessionPOST(post("/api/session", { personaId: "sarah-chen", stageNumber: 1, sdp: OFFER }));
    return (await response.json()).scoreToken as string;
  }

  function scoreBody(scoreToken: string, overrides: Record<string, unknown> = {}) {
    return { personaId: "sarah-chen", stageNumber: 1, transcript, endReason: "stage_complete", scoreToken, ...overrides };
  }

  it("rejects other origins and requests without a valid token, before any model call", async () => {
    const token = await startCall();
    fetchMock.mockClear();
    expect((await scorePOST(post("/api/score", scoreBody(token), { origin: "https://evil.example" }))).status).toBe(403);
    const forged = await scorePOST(post("/api/score", scoreBody("abc.def")));
    expect(forged.status).toBe(403);
    expect((await forged.json()).code).toBe("invalid_token");
    expect((await scorePOST(post("/api/score", scoreBody(token, { stageNumber: 2 })))).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates the transcript and end reason", async () => {
    const token = await startCall();
    expect((await scorePOST(post("/api/score", scoreBody(token, { transcript: "hi" })))).status).toBe(400);
    expect((await scorePOST(post("/api/score", scoreBody(token, { endReason: "bored" })))).status).toBe(400);
  });

  it("returns an unscored card without calling the model for a too-short call", async () => {
    const token = await startCall();
    fetchMock.mockClear();
    const response = await scorePOST(post("/api/score", scoreBody(token, { transcript: [{ speaker: "rep", text: "Hi." }] })));
    expect((await response.json()).scorecard.scored).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scores once with the strict schema and refuses a second use of the token", async () => {
    const token = await startCall();
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }));
    const response = await scorePOST(post("/api/score", scoreBody(token)));
    expect(response.status).toBe(200);
    expect((await response.json()).scorecard).toEqual({ ...modelResult, scored: true });
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body));
    expect(body.model).toBe("gpt-6-luna");
    expect(body).not.toHaveProperty("temperature");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[1].content).toContain("SALES REP: Fair question.");

    const again = await scorePOST(post("/api/score", scoreBody(token)));
    expect(again.status).toBe(409);
  });

  it("lets the visitor retry once after the model fails, with a specific message for a rejected key", async () => {
    const token = await startCall();
    fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401 }));
    const first = await scorePOST(post("/api/score", scoreBody(token)));
    expect(first.status).toBe(502);
    expect((await first.json()).code).toBe("openai_key_rejected");
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify({ trustScore: 5 }) } }] }));
    const second = await scorePOST(post("/api/score", scoreBody(token)));
    expect(second.status).toBe(502);
    expect(await second.json()).toEqual({ code: "upstream", error: "The scorecard could not be written. Try again." });
    // Two failed attempts use up the token: the third request gets no model call (re-check item A).
    const calls = fetchMock.mock.calls.length;
    const third = await scorePOST(post("/api/score", scoreBody(token)));
    expect(third.status).toBe(409);
    expect(fetchMock.mock.calls.length).toBe(calls);

    const retried = await startCall();
    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 500 }));
    expect((await scorePOST(post("/api/score", scoreBody(retried)))).status).toBe(502);
    fetchMock.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: JSON.stringify(modelResult) } }] }));
    expect((await scorePOST(post("/api/score", scoreBody(retried)))).status).toBe(200);
  });

  it("names the variable when the scorecard route is not configured", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const response = await scorePOST(post("/api/score", scoreBody("x.y")));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toMatch(/OPENAI_API_KEY/);
  });

  it("rate limits scorecards", async () => {
    for (let i = 0; i < 12; i += 1) await scorePOST(post("/api/score", scoreBody("x.y")));
    const blocked = await scorePOST(post("/api/score", scoreBody("x.y")));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
