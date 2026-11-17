import { after } from "next/server";
import { hangupRealtimeCall, type HangupResult } from "./openai";
import { callsToSweep, forgetHangup } from "./pending-hangups";

/** A pending call this far past its deadline is treated as abandoned by its monitor. */
export const SWEEP_GRACE_MS = 5_000;
/** After a start, sweeps repeat this often while calls are pending, for up to STARTUP_SWEEP_MS. */
export const STARTUP_SWEEP_INTERVAL_MS = 10_000;
/** Longer than any call can last (lib/config.ts HANGUP_DEADLINE_SECONDS), so every pending call is settled. */
export const STARTUP_SWEEP_MS = 6 * 60_000;

type Deps = {
  now: () => number;
  hangup: (callId: string) => Promise<HangupResult>;
  forget: (callId: string) => Promise<void>;
  toSweep?: typeof callsToSweep;
};

function defaultDeps(apiKey: string): Deps {
  return {
    now: Date.now,
    hangup: (callId) => hangupRealtimeCall({ apiKey, callId }),
    forget: (callId) => forgetHangup(callId),
  };
}

/**
 * Hangs up pending calls that no monitor is watching (its process crashed,
 * restarted or froze) or that are past their deadline. Returns how many it
 * hung up and how many calls are still pending. It only hangs up: a sweep has
 * no sideband, so it can't cancel replies while a hang-up keeps failing.
 */
export async function sweepHangups(apiKey: string, deps: Deps = defaultDeps(apiKey)): Promise<{ swept: number; pending: number }> {
  const { callIds, pending } = await (deps.toSweep ?? callsToSweep)(deps.now() - SWEEP_GRACE_MS);
  let swept = 0;
  for (const callId of callIds) {
    if ((await deps.hangup(callId)) !== "failed") {
      await deps.forget(callId);
      swept += 1;
    }
  }
  if (swept) console.warn(`[sweep] hung up ${swept} call(s) no monitor was watching`);
  return { swept, pending: pending - swept };
}

/** Schedules a sweep after the response is sent. */
export function scheduleSweep(apiKey: string): void {
  after(async () => {
    await sweepHangups(apiKey).catch(() => undefined);
  });
}

/**
 * Sweeps when a server process starts, then again every
 * STARTUP_SWEEP_INTERVAL_MS while calls are pending, for up to STARTUP_SWEEP_MS.
 * A call whose monitor died in a restart still has a heartbeat for up to
 * MONITOR_TTL_MS, so the first sweep can't tell; a later one hangs it up.
 */
export async function sweepAfterStart(
  apiKey: string,
  deps: Deps & { wait?: (ms: number) => Promise<void> } = defaultDeps(apiKey),
): Promise<void> {
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  const stopAt = deps.now() + STARTUP_SWEEP_MS;
  for (;;) {
    const { pending } = await sweepHangups(apiKey, deps).catch(() => ({ pending: 0 }));
    if (pending <= 0 || deps.now() + STARTUP_SWEEP_INTERVAL_MS > stopAt) return;
    await wait(STARTUP_SWEEP_INTERVAL_MS);
  }
}
