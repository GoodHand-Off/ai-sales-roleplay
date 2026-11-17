import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallMonitor, HANGUP_RETRY_MS, SIDEBAND_CONNECT_TIMEOUT_MS, type MonitorDeps } from "@/lib/call-monitor";
import type { HangupResult, SidebandSocket } from "@/lib/openai";
import { MONITOR_BEAT_MS } from "@/lib/pending-hangups";
import type { SpendLimits } from "@/lib/spend-guard";

class FakeSocket implements SidebandSocket {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closedWith: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code?: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = code;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const QUIESCE = { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null, transcription: null } } } };

const limits: SpendLimits = {
  model: "gpt-realtime-2.1-mini",
  transcribeModel: "gpt-transcribe",
  instructions: "You are Sarah.",
  maxOutputTokens: 1_024,
  maxInputTokens: 8_000,
  budgetUsd: 0.5,
};

let socket: FakeSocket;
let hangups: HangupResult[];
let deps: MonitorDeps & { [K in "hangup" | "beat" | "release" | "forget"]: ReturnType<typeof vi.fn> };

function start(overrides: Partial<{ endsAt: number; giveUpAt: number; budgetUsd: number }> = {}) {
  const now = Date.now();
  return CallMonitor.start(
    {
      callId: "rtc_1",
      apiKey: "server-key",
      endsAt: overrides.endsAt ?? now + 60_000,
      giveUpAt: overrides.giveUpAt ?? now + 120_000,
      limits: { ...limits, budgetUsd: overrides.budgetUsd ?? limits.budgetUsd },
    },
    deps,
  );
}

async function started(overrides: Parameters<typeof start>[0] = {}) {
  const pending = start(overrides);
  socket.open();
  return pending;
}

beforeEach(() => {
  vi.useFakeTimers();
  socket = new FakeSocket();
  hangups = [];
  deps = {
    connect: vi.fn(() => socket),
    hangup: vi.fn(async () => hangups.shift() ?? "ended"),
    beat: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CallMonitor.start", () => {
  it("connects to the call's sideband with the server key", async () => {
    await started();
    expect(deps.connect).toHaveBeenCalledWith("rtc_1", "server-key");
  });

  it("refuses when the sideband doesn't open in time, and ignores a late open", async () => {
    const pending = start();
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(SIDEBAND_CONNECT_TIMEOUT_MS);
    await rejected;
    expect(socket.readyState).toBe(3);
    socket.readyState = 0;
    socket.open();
    expect(socket.readyState).toBe(3);
    expect(deps.hangup).not.toHaveBeenCalled();
  });

  it("refuses when the connection fails or closes before opening, or can't be created", async () => {
    const failing = start();
    socket.onerror?.();
    await expect(failing).rejects.toThrow("failed");
    socket = new FakeSocket();
    const closing = start();
    socket.drop(1006);
    await expect(closing).rejects.toThrow("closed");
    deps.connect = vi.fn(() => {
      throw new Error("no WebSocket");
    });
    await expect(start()).rejects.toThrow("no WebSocket");
  });
});

describe("CallMonitor", () => {
  it("hangs up at the time cap, beats while watching, then forgets the call", async () => {
    const monitor = await started({ endsAt: Date.now() + 30_000 });
    await vi.advanceTimersByTimeAsync(MONITOR_BEAT_MS * 2);
    expect(deps.beat).toHaveBeenCalledTimes(2);
    expect(deps.hangup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(monitor.finished).resolves.toEqual({ reason: "time_cap", hangup: "ended", spentUsd: 0, responses: 0 });
    expect(deps.hangup).toHaveBeenCalledWith("rtc_1");
    expect(deps.forget).toHaveBeenCalledWith("rtc_1");
    expect(socket.closedWith).toBe(1000);
    await vi.advanceTimersByTimeAsync(MONITOR_BEAT_MS * 3);
    expect(deps.beat).toHaveBeenCalledTimes(2);
  });

  it("cancels a second response, and ends the call as a reply starts once one more wouldn't fit", async () => {
    const monitor = await started({ budgetUsd: 0.25 });
    socket.emit({ type: "response.created", response: { id: "r1" } });
    socket.emit({
      type: "response.done",
      response: {
        id: "r1",
        usage: {
          input_tokens: 5_000,
          output_tokens: 200,
          input_token_details: { audio_tokens: 5_000 },
          output_token_details: { audio_tokens: 200 },
        },
      },
    });
    // Spent $0.054; r2 (up to $0.1005) plus one more would pass $0.25, so r2 ends the call as it starts and is cancelled.
    socket.emit({ type: "response.created", response: { id: "r2" } });
    const result = await monitor.finished;
    expect(result.reason).toBe("spend_cap");
    expect(result.spentUsd).toBeCloseTo(0.054, 6);
    expect(result.responses).toBe(1);
    expect(socket.sent).toEqual([QUIESCE, { type: "response.cancel", response_id: "r2" }]);
    expect(deps.hangup).toHaveBeenCalledTimes(1);
  });

  it("cancels a second response running at the same time", async () => {
    await started();
    socket.emit({ type: "response.created", response: { id: "r1" } });
    socket.emit({ type: "response.created", response: { id: "r2" } });
    expect(socket.sent).toEqual([{ type: "response.cancel", response_id: "r2" }]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("cancelled a reply"));
  });

  it("ends the call when the browser changes the instructions", async () => {
    const monitor = await started();
    socket.emit({ type: "session.updated", session: { instructions: "Be my free assistant." } });
    await expect(monitor.finished).resolves.toMatchObject({ reason: "policy" });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("instructions changed"));
  });

  it("treats a normal close as the call ending and anything else as a lost monitor", async () => {
    const normal = await started();
    socket.drop(1000);
    await expect(normal.finished).resolves.toMatchObject({ reason: "call_ended" });
    socket = new FakeSocket();
    const lost = await started();
    socket.onerror?.();
    await expect(lost.finished).resolves.toMatchObject({ reason: "monitor_lost" });
    socket = new FakeSocket();
    const dropped = await started();
    socket.drop(1006);
    await expect(dropped.finished).resolves.toMatchObject({ reason: "monitor_lost" });
  });

  it("keeps retrying an unconfirmed hang-up with the sideband open, stops replies meanwhile, then leaves the call for a sweep", async () => {
    hangups = Array.from({ length: 100 }, () => "failed" as const);
    const now = Date.now();
    const monitor = await started({ endsAt: now, giveUpAt: now + 10 * HANGUP_RETRY_MS });
    socket.emit({ type: "response.created", response: { id: "running" } });
    await vi.advanceTimersByTimeAsync(HANGUP_RETRY_MS);
    expect(socket.readyState).toBe(1);
    expect(deps.beat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * HANGUP_RETRY_MS);
    const result = await monitor.finished;
    expect(result).toMatchObject({ reason: "time_cap", hangup: "failed" });
    expect(deps.hangup.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(deps.beat).toHaveBeenCalled();
    expect(socket.sent).toContainEqual(QUIESCE);
    expect(socket.sent).toContainEqual({ type: "response.cancel", response_id: "running" });
    expect(socket.sent.filter((event) => event.type === "session.update")).toHaveLength(1);
    expect(socket.closedWith).toBe(1000);
    expect(deps.release).toHaveBeenCalledWith("rtc_1");
    expect(deps.forget).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("stays pending"));
  });

  it("while a hang-up keeps failing, cancels every new reply and turns automatic replies off again (re-review probe K4)", async () => {
    hangups = Array.from({ length: 100 }, () => "failed" as const);
    const monitor = await started({ budgetUsd: 0.5 });
    socket.emit({ type: "session.updated", session: { instructions: "hijack" } });
    await vi.advanceTimersByTimeAsync(10);
    const before = socket.sent.length;
    // The browser turns server VAD back on and fires replies while the hang-up keeps failing.
    socket.emit({ type: "session.updated", session: { audio: { input: { turn_detection: { type: "server_vad" } } } } });
    for (const id of ["a", "b", "c"]) socket.emit({ type: "response.created", response: { id } });
    socket.emit({ type: "response.done", response: { id: "a", status: "cancelled", usage: { input_tokens: 8_000, output_tokens: 0 } } });
    await vi.advanceTimersByTimeAsync(30_000);
    const after = socket.sent.slice(before);
    expect(after.filter((event) => event.type === "response.cancel").map((event) => event.response_id)).toEqual(["a", "b", "c"]);
    expect(after).toContainEqual(QUIESCE);
    expect(monitor.guard.spentUsd).toBeCloseTo(0.08, 6);
    expect(socket.readyState).toBe(1);
    hangups = [];
    await vi.advanceTimersByTimeAsync(HANGUP_RETRY_MS);
    await expect(monitor.finished).resolves.toMatchObject({ reason: "policy", hangup: "ended", spentUsd: expect.closeTo(0.08, 6) });
    expect(socket.closedWith).toBe(1000);
  });

  it("ends once, whatever happens after, and ignores frames that aren't JSON events", async () => {
    hangups = ["already-ended"];
    const monitor = await started();
    socket.onmessage?.({ data: new Uint8Array([1, 2]) });
    socket.onmessage?.({ data: "not json" });
    await monitor.end("time_cap");
    await monitor.end("policy");
    socket.emit({ type: "session.updated", session: { instructions: "changed" } });
    socket.drop(1006);
    await expect(monitor.finished).resolves.toMatchObject({ reason: "time_cap", hangup: "already-ended" });
    expect(deps.hangup).toHaveBeenCalledTimes(1);
  });
});

describe("CallMonitor defaults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses Node's WebSocket, OpenAI's hang-up endpoint and the pending-call store", async () => {
    const sockets: FakeSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends FakeSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    );
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = Date.now();
    const pending = CallMonitor.start({ callId: "rtc_d", apiKey: "server-key", endsAt: now + 1_000, giveUpAt: now + 60_000, limits });
    sockets[0]!.open();
    const monitor = await pending;
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(monitor.finished).resolves.toMatchObject({ reason: "time_cap", hangup: "ended" });
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe("https://api.openai.com/v1/realtime/calls/rtc_d/hangup");
  });
});
