import { hangupRealtimeCall, openSideband, type HangupResult, type SidebandSocket } from "./openai";
import { beatMonitor, forgetHangup, MONITOR_BEAT_MS, releaseMonitor } from "./pending-hangups";
import { SpendGuard, type GuardAction, type SpendLimits } from "./spend-guard";

/**
 * The server's watch over one call. It connects to the call's sideband (OpenAI's
 * server-side event connection to the same call), feeds every event to the spend
 * guard, and hangs the call up at the time cap, at the budget, when the session
 * is tampered with, or when the connection drops. The browser's own timer is a
 * courtesy; this is the limit.
 *
 * Once it decides to end the call it keeps the sideband open and keeps reading
 * until OpenAI confirms the hang-up: automatic turns and transcription go off,
 * every reply that starts is cancelled, and spend is still metered.
 *
 * The session route starts a monitor before it returns the call to the browser.
 * If the monitor can't connect, the call is hung up and refused: no monitor, no
 * call.
 */

export type MonitorEndReason = "time_cap" | "spend_cap" | "policy" | "call_ended" | "monitor_lost";

export type MonitorResult = {
  reason: MonitorEndReason;
  hangup: HangupResult;
  spentUsd: number;
  responses: number;
};

export type MonitorOptions = {
  callId: string;
  apiKey: string;
  /** The time cap (epoch ms). */
  endsAt: number;
  /** Hang-up retries stop here (epoch ms), inside the route's time limit. */
  giveUpAt: number;
  limits: SpendLimits;
};

export type MonitorDeps = {
  connect: (callId: string, apiKey: string) => SidebandSocket;
  hangup: (callId: string) => Promise<HangupResult>;
  beat: (callId: string) => Promise<void>;
  release: (callId: string) => Promise<void>;
  forget: (callId: string) => Promise<void>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** How long the sideband may take to connect before the call is refused. */
export const SIDEBAND_CONNECT_TIMEOUT_MS = 5_000;
/** Pause between hang-up attempts. */
export const HANGUP_RETRY_MS = 3_000;

const OPEN = 1;
const NORMAL_CLOSE = 1000;
/** Turns off automatic replies and input transcription while a hang-up is on its way. */
const QUIESCE = { type: "session.update", session: { type: "realtime", audio: { input: { turn_detection: null, transcription: null } } } };

function defaultDeps(apiKey: string): MonitorDeps {
  return {
    connect: openSideband,
    hangup: (callId) => hangupRealtimeCall({ apiKey, callId }),
    beat: (callId) => beatMonitor(callId),
    release: (callId) => releaseMonitor(callId),
    forget: (callId) => forgetHangup(callId),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export class CallMonitor {
  readonly guard: SpendGuard;
  /** Settles once the call is over and its hang-up has been confirmed or given up on. */
  readonly finished: Promise<MonitorResult>;
  private settle!: (result: MonitorResult) => void;
  private ending = false;
  private cancels = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly options: MonitorOptions,
    private readonly deps: MonitorDeps,
    private readonly socket: SidebandSocket,
  ) {
    this.guard = new SpendGuard(options.limits);
    this.finished = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /**
   * Connects to the call's sideband and starts watching. Resolves once the
   * connection is open; rejects if it fails or takes longer than
   * SIDEBAND_CONNECT_TIMEOUT_MS.
   */
  static start(options: MonitorOptions, deps: MonitorDeps = defaultDeps(options.apiKey)): Promise<CallMonitor> {
    return new Promise((resolve, reject) => {
      let socket: SidebandSocket;
      try {
        socket = deps.connect(options.callId, options.apiKey);
      } catch (error) {
        reject(error);
        return;
      }
      const monitor = new CallMonitor(options, deps, socket);
      let state: "connecting" | "open" | "failed" = "connecting";
      const fail = (message: string) => {
        if (state !== "connecting") return;
        state = "failed";
        clearTimeout(timeout);
        socket.close();
        reject(new Error(message));
      };
      const timeout = setTimeout(() => fail("Sideband connection timed out"), SIDEBAND_CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        if (state !== "connecting") return socket.close();
        state = "open";
        clearTimeout(timeout);
        monitor.watch();
        resolve(monitor);
      };
      socket.onmessage = (event) => monitor.onMessage(event.data);
      socket.onerror = () => (state === "open" ? void monitor.end("monitor_lost") : fail("Sideband connection failed"));
      socket.onclose = (event) =>
        state === "open" ? void monitor.end(event.code === NORMAL_CLOSE ? "call_ended" : "monitor_lost") : fail("Sideband closed");
    });
  }

  private watch(): void {
    const { callId, endsAt } = this.options;
    this.deadline = setTimeout(() => void this.end("time_cap"), Math.max(0, endsAt - this.deps.now()));
    this.heartbeat = setInterval(() => void this.deps.beat(callId).catch(() => undefined), MONITOR_BEAT_MS);
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    for (const action of this.guard.onEvent(event)) this.apply(action);
  }

  private apply(action: GuardAction): void {
    const { callId } = this.options;
    switch (action.type) {
      case "cancel":
        this.cancels += 1;
        if (this.cancels === 1) console.warn(`[call] ${callId}: cancelled a reply (one runs at a time, none while ending)`);
        this.send({ type: "response.cancel", response_id: action.responseId });
        return;
      case "quiesce":
        this.send(QUIESCE);
        return;
      case "end":
        console.warn(`[call] ${callId}: ending (${action.reason}: ${action.detail})`);
        void this.end(action.reason);
    }
  }

  private send(event: object): void {
    if (this.socket.readyState === OPEN) this.socket.send(JSON.stringify(event));
  }

  /**
   * Stops what spends (automatic turns, transcription, running replies), then
   * hangs the call up, retrying until OpenAI confirms or `giveUpAt` passes. The
   * sideband stays open meanwhile, so replies the browser starts are cancelled.
   * Then it closes the sideband. Safe to call more than once; the first reason wins.
   */
  async end(reason: MonitorEndReason): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    clearTimeout(this.deadline);
    for (const action of this.guard.stop()) this.apply(action);
    const { callId, giveUpAt } = this.options;
    let hangup: HangupResult;
    for (;;) {
      hangup = await this.deps.hangup(callId);
      if (hangup !== "failed" || this.deps.now() + HANGUP_RETRY_MS >= giveUpAt) break;
      await this.deps.sleep(HANGUP_RETRY_MS);
    }
    clearInterval(this.heartbeat);
    if (this.socket.readyState === OPEN) this.socket.close(NORMAL_CLOSE);
    if (hangup === "failed") {
      console.error(`[call] ${callId}: hang-up unconfirmed; it stays pending for the next sweep`);
      await this.deps.release(callId).catch(() => undefined);
    } else {
      await this.deps.forget(callId).catch(() => undefined);
    }
    const { spentUsd, responses } = this.guard;
    this.settle({ reason, hangup, spentUsd, responses });
  }
}
