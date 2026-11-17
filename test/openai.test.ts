import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchModelStatus,
  openSideband,
  createRealtimeCall,
  createStructuredCompletion,
  hangupRealtimeCall,
  OpenAIRequestError,
  readCallId,
} from "@/lib/openai";

const SDP_ANSWER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n";

describe("readCallId", () => {
  it("reads the call ID from the Location header", () => {
    expect(readCallId("/v1/realtime/calls/rtc_abc123")).toBe("rtc_abc123");
    expect(readCallId("https://api.openai.com/v1/realtime/calls/rtc_abc123/")).toBe("rtc_abc123");
    expect(readCallId(null)).toBeNull();
    expect(readCallId("/v1/realtime/calls/")).toBeNull();
    expect(readCallId("/v1/realtime/calls/../../x")).toBeNull();
  });
});

describe("createRealtimeCall", () => {
  it("posts the offer and session as multipart and returns answer and call ID", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(SDP_ANSWER, { status: 201, headers: { Location: "/v1/realtime/calls/rtc_42" } }),
    );
    const result = await createRealtimeCall({
      apiKey: "test-openai-key",
      sdp: "v=0\r\noffer",
      session: { type: "realtime" },
      safetyIdentifier: "abc",
      fetchImpl,
    });
    expect(result).toEqual({ answerSdp: SDP_ANSWER, callId: "rtc_42" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/realtime/calls");
    const body = init.body as FormData;
    expect(body.get("sdp")).toBe("v=0\r\noffer");
    expect(JSON.parse(String(body.get("session")))).toEqual({ type: "realtime" });
    expect((init.headers as Record<string, string>)["OpenAI-Safety-Identifier"]).toBe("abc");
  });

  it("refuses a call it could not hang up later", async () => {
    const fetchImpl = vi.fn(async () => new Response(SDP_ANSWER, { status: 201 }));
    await expect(
      createRealtimeCall({ apiKey: "k", sdp: "v=0", session: {}, fetchImpl }),
    ).rejects.toThrow(/call ID missing/);
  });

  it("reports upstream failures with their status", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota", { status: 429 }));
    await expect(createRealtimeCall({ apiKey: "k", sdp: "v=0", session: {}, fetchImpl })).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("hangupRealtimeCall", () => {
  it.each([
    [200, "ended"],
    [404, "already-ended"],
    [500, "failed"],
  ])("maps HTTP %i to %s", async (status, expected) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status }));
    await expect(hangupRealtimeCall({ apiKey: "k", callId: "rtc_1", fetchImpl })).resolves.toBe(expected);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("https://api.openai.com/v1/realtime/calls/rtc_1/hangup");
  });

  it("returns failed on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(hangupRealtimeCall({ apiKey: "k", callId: "rtc_1", fetchImpl })).resolves.toBe("failed");
  });
});

describe("createStructuredCompletion", () => {
  it("sends a strict json_schema response format and parses the content", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ choices: [{ message: { content: '{"ok":true}' } }] }),
    );
    const result = await createStructuredCompletion({
      apiKey: "k",
      model: "m",
      system: "s",
      user: "u",
      schema: { name: "x", schema: { type: "object" } },
      maxTokens: 10,
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body));
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "x", strict: true, schema: { type: "object" } },
    });
  });

  it("throws on non-JSON content", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ choices: [{ message: { content: "nope" } }] }));
    await expect(
      createStructuredCompletion({
        apiKey: "k",
        model: "m",
        system: "s",
        user: "u",
        schema: { name: "x", schema: {} },
        maxTokens: 10,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(OpenAIRequestError);
  });
});

describe("openSideband", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens Node's WebSocket to the call with the key in a header, not the URL", () => {
    const created: Array<{ url: string; init: { headers: Record<string, string> } }> = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor(url: string, init: { headers: Record<string, string> }) {
          created.push({ url, init });
        }
      },
    );
    openSideband("rtc_a/b", "server-key");
    expect(created).toEqual([
      { url: "wss://api.openai.com/v1/realtime?call_id=rtc_a%2Fb", init: { headers: { Authorization: "Bearer server-key" } } },
    ]);
  });
});

describe("fetchModelStatus", () => {
  it("returns OpenAI's status for the model, or 0 when OpenAI can't be reached", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchModelStatus("k", "gpt-x", fetchImpl)).resolves.toBe(404);
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe("https://api.openai.com/v1/models/gpt-x");
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(fetchModelStatus("k", "gpt-x", offline)).resolves.toBe(0);
  });
});
