import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { microphoneErrorMessage, VoiceCall, type CallSnapshot } from "@/lib/voice-call";

// Minimal stand-ins for the browser's WebRTC objects, so the call client's logic
// runs in Node. They record what the client does and let a test drive events.

class FakeChannel {
  readyState: "connecting" | "open" | "closed" = "connecting";
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
  }
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

class FakePeer {
  static last: FakePeer | null = null;
  connectionState: RTCPeerConnectionState = "new";
  ontrack: ((event: { streams: unknown[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  channel = new FakeChannel();
  tracks: unknown[] = [];
  remote: unknown = null;
  closed = false;
  constructor() {
    FakePeer.last = this;
  }
  addTrack(track: unknown) {
    this.tracks.push(track);
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0 offer" };
  }
  async setLocalDescription() {}
  async setRemoteDescription(description: unknown) {
    this.remote = description;
  }
  close() {
    this.closed = true;
  }
  setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const track = { stop: vi.fn() };
const micStream = { getTracks: () => [track] };
const getUserMedia = vi.fn();
const fetchMock = vi.fn<typeof fetch>();

function audioElement(play: () => Promise<void> = async () => {}) {
  return { srcObject: null as unknown, play: vi.fn(play) } as unknown as HTMLAudioElement;
}

function startResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    answerSdp: "v=0 answer",
    maxSeconds: 240,
    ...overrides,
  });
}

function makeCall(audio = audioElement(), preflightUrl?: string) {
  const snapshots: CallSnapshot[] = [];
  const call = new VoiceCall({
    sessionUrl: "/api/session",
    preflightUrl,
    requestBody: { personaId: "sarah-chen", stageNumber: 1 },
    audio,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  const latest = () => snapshots[snapshots.length - 1];
  return { call, snapshots, latest, audio };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeer.last = null;
  track.stop.mockClear();
  getUserMedia.mockReset().mockResolvedValue(micStream);
  fetchMock.mockReset().mockResolvedValue(startResponse());
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function peer(): FakePeer {
  if (!FakePeer.last) throw new Error("no peer was created");
  return FakePeer.last;
}

describe("VoiceCall", () => {
  it("sends the offer to the server, applies the answer and goes live", async () => {
    const { call, latest } = makeCall();
    const response = await call.start();
    expect(response).toEqual({ answerSdp: "v=0 answer", maxSeconds: 240 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/session");
    expect(JSON.parse(String(init.body))).toEqual({ personaId: "sarah-chen", stageNumber: 1, sdp: "v=0 offer" });
    expect(peer().remote).toEqual({ type: "answer", sdp: "v=0 answer" });
    expect(peer().tracks).toEqual([track]);
    expect(latest()?.phase).toBe("connecting");

    peer().setState("connected");
    expect(latest()?.phase).toBe("live");
    peer().channel.open();
    expect(peer().channel.sent).toEqual([{ type: "response.create" }]);
  });

  it("plays the homeowner's audio and recovers when autoplay is blocked", async () => {
    let allowed = false;
    const audio = audioElement(async () => {
      if (!allowed) throw new Error("NotAllowedError");
    });
    const { call, latest } = makeCall(audio);
    await call.start();
    const stream = { id: "remote" };
    peer().ontrack?.({ streams: [stream] });
    expect(audio.srcObject).toBe(stream);
    await vi.waitFor(() => expect(latest()?.audioBlocked).toBe(true));
    allowed = true;
    await call.resumeAudio();
    expect(latest()?.audioBlocked).toBe(false);
  });

  it("builds the transcript from channel events and ends after the stage-end marker", async () => {
    const { call, latest } = makeCall();
    await call.start();
    peer().setState("connected");
    const channel = peer().channel;
    channel.emit({ type: "output_audio_buffer.started" });
    channel.emit({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "Okay, book it. This concludes stage 1." });
    channel.emit({ type: "not json at all" });
    channel.onmessage?.({ data: "{broken" });
    expect(latest()?.transcript.stageComplete).toBe(true);
    channel.emit({ type: "output_audio_buffer.stopped" });
    vi.advanceTimersByTime(600);
    expect(latest()).toMatchObject({ phase: "ended", endReason: "stage_complete" });
    expect(track.stop).toHaveBeenCalled();
    expect(peer().closed).toBe(true);
  });

  it("ends the stage even if the audio-stopped event never comes", async () => {
    const { call, latest } = makeCall();
    await call.start();
    peer().setState("connected");
    peer().channel.emit({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "This concludes stage 1." });
    vi.advanceTimersByTime(4_000);
    expect(latest()?.endReason).toBe("stage_complete");
  });

  it("asks the homeowner to wrap up 30 seconds before the cap and ends at the cap, on the browser's clock", async () => {
    fetchMock.mockResolvedValueOnce(startResponse({ maxSeconds: 90 }));
    const { call, latest } = makeCall();
    await call.start();
    peer().setState("connected");
    peer().channel.open();
    vi.advanceTimersByTime(60_000);
    expect(peer().channel.sent[1]).toMatchObject({ type: "conversation.item.create", item: { role: "system" } });
    vi.advanceTimersByTime(30_000);
    expect(latest()).toMatchObject({ phase: "ended", endReason: "time_cap" });
  });

  it("gives a dropped connection a few seconds to recover", async () => {
    const { call, latest } = makeCall();
    await call.start();
    peer().setState("connected");
    peer().setState("disconnected");
    vi.advanceTimersByTime(3_000);
    peer().setState("connected");
    vi.advanceTimersByTime(10_000);
    expect(latest()?.phase).toBe("live");
    peer().setState("disconnected");
    vi.advanceTimersByTime(5_000);
    expect(latest()).toMatchObject({ phase: "ended", endReason: "connection_lost" });
  });

  it("treats a failed connection before the cap as lost, and a server hang-up at the cap as the cap", async () => {
    const first = makeCall();
    await first.call.start();
    peer().setState("connected");
    peer().setState("failed");
    expect(first.latest()?.endReason).toBe("connection_lost");

    fetchMock.mockResolvedValueOnce(startResponse({ maxSeconds: 30 }));
    const second = makeCall();
    await second.call.start();
    peer().setState("connected");
    vi.setSystemTime(Date.now() + 29_000);
    peer().channel.onclose?.();
    expect(second.latest()?.endReason).toBe("time_cap");
  });

  it("fails clearly when the microphone is blocked", async () => {
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    const { call, latest } = makeCall();
    expect(await call.start()).toBeNull();
    expect(latest()).toMatchObject({ phase: "failed", error: expect.stringMatching(/Microphone access was blocked/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["NotAllowedError", /blocked/],
    ["NotFoundError", /No microphone was found/],
    ["NotReadableError", /in use by another app/],
    ["SomethingElse", /could not start/],
  ])("explains a %s microphone error", (name, message) => {
    expect(microphoneErrorMessage(Object.assign(new Error("x"), { name }))).toMatch(message);
    expect(microphoneErrorMessage("not an error")).toMatch(/could not start/);
  });

  it("explains that the microphone needs HTTPS or localhost", async () => {
    vi.stubGlobal("isSecureContext", false);
    const { call, latest } = makeCall();
    await call.start();
    expect(latest()?.error).toMatch(/needs a secure page/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("checks the server before opening the microphone", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "This app has reached its daily call limit." }, { status: 429 }));
    const blocked = makeCall(audioElement(), "/api/session");
    expect(await blocked.call.start()).toBeNull();
    expect(blocked.latest()?.error).toMatch(/daily call limit/);
    expect(getUserMedia).not.toHaveBeenCalled();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const offline = makeCall(audioElement(), "/api/session");
    await offline.call.start();
    expect(offline.latest()?.error).toMatch(/Could not reach the server/);

    fetchMock.mockResolvedValueOnce(Response.json({ ready: true }));
    const ready = makeCall(audioElement(), "/api/session");
    expect((await ready.call.start())?.maxSeconds).toBe(240);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("shows the server's error message, or a generic one", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "OpenAI rejected the server's API key." }, { status: 502 }));
    const first = makeCall();
    expect(await first.call.start()).toBeNull();
    expect(first.latest()?.error).toBe("OpenAI rejected the server's API key.");

    fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 500 }));
    const second = makeCall();
    await second.call.start();
    expect(second.latest()?.error).toBe("Could not start the call. Try again in a moment.");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const third = makeCall();
    await third.call.start();
    expect(third.latest()?.error).toMatch(/Could not connect the call/);
  });

  it("fails if the connection never comes up", async () => {
    const { call, latest } = makeCall();
    await call.start();
    peer().setState("failed");
    expect(latest()).toMatchObject({ phase: "failed", error: "The call could not connect. Try again." });
  });

  it("stops cleanly when ended while still connecting, and end() is idempotent", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((resolve) => (resolveFetch = resolve)));
    const { call, snapshots, latest } = makeCall();
    const started = call.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    call.end("rep_ended");
    call.end("rep_ended");
    resolveFetch(startResponse());
    expect(await started).toBeNull();
    expect(latest()).toMatchObject({ phase: "ended", endReason: "rep_ended" });
    expect(snapshots.filter((snapshot) => snapshot.phase === "ended")).toHaveLength(1);
  });

  it("does not open the call if it was ended while waiting for the microphone", async () => {
    let resolveMic: (stream: unknown) => void = () => {};
    getUserMedia.mockReturnValueOnce(new Promise((resolve) => (resolveMic = resolve)));
    const { call } = makeCall();
    const started = call.start();
    call.end("rep_ended");
    resolveMic(micStream);
    expect(await started).toBeNull();
    expect(FakePeer.last).toBeNull();
    expect(track.stop).toHaveBeenCalled();
  });
});
