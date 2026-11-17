import {
  applyRealtimeEvent,
  initialTranscriptState,
  type CallTranscriptState,
} from "./realtime-events";
import type { EndReason } from "./transcript";

/**
 * Browser side of a call: microphone, WebRTC peer connection and the OpenAI
 * event channel. The browser sends its SDP offer to your server, which starts
 * the call with OpenAI and returns the answer. No OpenAI credential ever
 * reaches the browser.
 */

/** Where the call is in its life. */
export type CallPhase = "idle" | "connecting" | "live" | "ended" | "failed";

/** Everything the UI needs to draw the call. Replaced, never mutated, on each change. */
export type CallSnapshot = {
  phase: CallPhase;
  transcript: CallTranscriptState;
  /** When the call ends, in this browser's `Date.now()` time (never the server's clock). */
  endsAt: number | null;
  endReason: EndReason | null;
  error: string | null;
  /** The browser refused to autoplay the homeowner's audio; a tap fixes it. */
  audioBlocked: boolean;
};

/** What the session endpoint returns. */
export type StartCallResponse = {
  answerSdp: string;
  maxSeconds: number;
  /** One-time token for the scorecard request, when the endpoint issues one. */
  scoreToken?: string;
};

type Options = {
  sessionUrl: string;
  /** Sent as JSON together with `sdp`. */
  requestBody: Record<string, unknown>;
  /** Optional GET endpoint checked before the microphone opens; non-2xx stops the call with its message. */
  preflightUrl?: string;
  audio: HTMLAudioElement;
  onChange: (snapshot: CallSnapshot) => void;
};

/** Seconds before the cap when the homeowner is asked to wrap up. */
const WRAP_UP_WARNING_SECONDS = 30;
/** How long the session endpoint may take to start the call. */
const START_TIMEOUT_MS = 30_000;
/** After the stage-end marker, how long to wait for the audio to finish. */
const STAGE_END_GRACE_MS = 4_000;
/** WebRTC often recovers from "disconnected"; wait this long before giving up. */
const RECONNECT_GRACE_MS = 5_000;

const GENERIC_START_ERROR = "Could not start the call. Try again in a moment.";

/** The state before a call starts. */
export function idleSnapshot(): CallSnapshot {
  return {
    phase: "idle",
    transcript: initialTranscriptState(),
    endsAt: null,
    endReason: null,
    error: null,
    audioBlocked: false,
  };
}

function isStartCallResponse(value: unknown): value is StartCallResponse {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.answerSdp === "string" &&
    typeof record.maxSeconds === "number" &&
    Number.isFinite(record.maxSeconds) &&
    (record.scoreToken === undefined || typeof record.scoreToken === "string")
  );
}

function errorMessage(payload: unknown, fallback: string): string {
  const error = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : undefined;
  return typeof error === "string" && error ? error : fallback;
}

/** Turns a getUserMedia failure into something the rep can act on. */
export function microphoneErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was blocked. Allow the microphone for this site in your browser settings and try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect one, or check your system sound settings, then try again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is in use by another app or could not start. Close other apps using it and try again.";
    default:
      return "The microphone could not start. Check your browser and system settings, then try again.";
  }
}

/**
 * One voice call in the browser. Create it, call `start()` from a click (the
 * browser asks for the microphone then), and `end()` to hang up. Every state
 * change goes to `onChange`.
 */
export class VoiceCall {
  private snapshot: CallSnapshot = idleSnapshot();
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private timers: number[] = [];
  private stageEndTimer: number | null = null;
  private reconnectTimer: number | null = null;

  constructor(private readonly options: Options) {}

  private update(patch: Partial<CallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.options.onChange(this.snapshot);
  }

  private get finished() {
    return this.snapshot.phase === "ended" || this.snapshot.phase === "failed";
  }

  private fail(message: string) {
    if (this.finished) return;
    this.release();
    this.update({ phase: "failed", error: message });
  }

  /** Starts the call. Returns the session endpoint's response, or null if the call failed. */
  async start(): Promise<StartCallResponse | null> {
    this.update({ ...idleSnapshot(), phase: "connecting" });

    if (this.options.preflightUrl) {
      try {
        const result = await fetch(this.options.preflightUrl, { signal: AbortSignal.timeout(10_000) });
        if (!result.ok) {
          this.fail(errorMessage(await result.json().catch(() => null), GENERIC_START_ERROR));
          return null;
        }
      } catch {
        this.fail("Could not reach the server. Check your connection and try again.");
        return null;
      }
      if (this.finished) return null;
    }

    if (typeof window !== "undefined" && (!window.isSecureContext || !navigator.mediaDevices)) {
      this.fail("The microphone needs a secure page. Open this app over HTTPS, or on localhost.");
      return null;
    }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      this.fail(microphoneErrorMessage(error));
      return null;
    }
    if (this.finished) {
      this.release();
      return null;
    }

    let response: StartCallResponse;
    // The deadline uses this browser's own clock, so a wrong system clock can't shorten or stretch the call.
    const requestedAt = Date.now();
    try {
      const peer = new RTCPeerConnection();
      this.peer = peer;
      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        this.options.audio.srcObject = stream;
        this.options.audio.play().catch(() => this.update({ audioBlocked: true }));
      };
      peer.onconnectionstatechange = () => this.onConnectionState(peer.connectionState);
      const mic = this.mic;
      mic.getTracks().forEach((track) => peer.addTrack(track, mic));

      const channel = peer.createDataChannel("oai-events");
      this.channel = channel;
      // The homeowner speaks first: the session instructions hold the opening line.
      channel.onopen = () => this.send({ type: "response.create" });
      channel.onmessage = (message) => this.onEvent(message.data);
      // OpenAI closes the event channel when the call ends, including the server-side hang-up.
      channel.onclose = () => this.onConnectionState("closed");

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const result = await fetch(this.options.sessionUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...this.options.requestBody, sdp: offer.sdp }),
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
      const payload: unknown = await result.json().catch(() => null);
      if (!result.ok || !isStartCallResponse(payload)) {
        this.fail(errorMessage(payload, GENERIC_START_ERROR));
        return null;
      }
      response = payload;
      if (this.finished) return null;
      await peer.setRemoteDescription({ type: "answer", sdp: response.answerSdp });
    } catch {
      this.fail("Could not connect the call. Check your connection and try again.");
      return null;
    }

    const endsAt = requestedAt + response.maxSeconds * 1000;
    this.update({ endsAt });
    const untilCap = endsAt - Date.now();
    this.timers.push(window.setTimeout(() => this.end("time_cap"), Math.max(0, untilCap)));
    if (response.maxSeconds >= 2 * WRAP_UP_WARNING_SECONDS) {
      this.timers.push(
        window.setTimeout(() => this.askToWrapUp(), Math.max(0, untilCap - WRAP_UP_WARNING_SECONDS * 1000)),
      );
    }
    return response;
  }

  /** Ends the call from the browser. Safe to call more than once. */
  end(reason: EndReason): void {
    if (this.finished) return;
    this.release();
    this.update({
      phase: "ended",
      endReason: reason,
      transcript: { ...this.snapshot.transcript, homeownerSpeaking: false, repSpeaking: false },
    });
  }

  /** Retries audio playback after the browser blocked autoplay. Call from a click. */
  async resumeAudio(): Promise<void> {
    try {
      await this.options.audio.play();
      this.update({ audioBlocked: false });
    } catch {
      this.update({ audioBlocked: true });
    }
  }

  private onConnectionState(state: RTCPeerConnectionState) {
    if (state === "connected") {
      this.clearReconnectTimer();
      if (this.snapshot.phase === "connecting") this.update({ phase: "live" });
      return;
    }
    if (this.finished) return;
    if (state === "disconnected" && this.snapshot.phase === "live") {
      if (this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.endForLostConnection();
        }, RECONNECT_GRACE_MS);
      }
      return;
    }
    if (state === "failed" || state === "closed" || state === "disconnected") {
      if (this.snapshot.phase === "connecting") this.fail("The call could not connect. Try again.");
      else this.endForLostConnection();
    }
  }

  private endForLostConnection() {
    const atCap = this.snapshot.endsAt !== null && Date.now() >= this.snapshot.endsAt - 2_000;
    this.end(atCap ? "time_cap" : "connection_lost");
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private onEvent(data: unknown) {
    if (typeof data !== "string") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    const before = this.snapshot.transcript;
    const transcript = applyRealtimeEvent(before, event);
    if (transcript === before) return;
    this.update({ transcript });
    if (transcript.stageComplete && !before.stageComplete) {
      this.stageEndTimer = window.setTimeout(() => this.end("stage_complete"), STAGE_END_GRACE_MS);
    }
    if (transcript.stageComplete && before.homeownerSpeaking && !transcript.homeownerSpeaking) {
      // The homeowner finished saying the closing line; end shortly after.
      if (this.stageEndTimer !== null) window.clearTimeout(this.stageEndTimer);
      this.stageEndTimer = window.setTimeout(() => this.end("stage_complete"), 600);
    }
  }

  private askToWrapUp() {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "About 30 seconds remain in this practice call. Bring the conversation to its natural end within your next turn or two, then say your final line and the stage-end sentence.",
          },
        ],
      },
    });
  }

  private send(event: object) {
    if (this.channel?.readyState === "open") this.channel.send(JSON.stringify(event));
  }

  private release() {
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers = [];
    if (this.stageEndTimer !== null) window.clearTimeout(this.stageEndTimer);
    this.stageEndTimer = null;
    this.clearReconnectTimer();
    if (this.channel) {
      this.channel.onopen = null;
      this.channel.onmessage = null;
      this.channel.onclose = null;
      this.channel.close();
    }
    this.channel = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    this.peer = null;
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    this.options.audio.srcObject = null;
  }
}
