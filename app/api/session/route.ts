import { after } from "next/server";
import { findPersona, findStage } from "@/content/personas";
import { describeError, json } from "@/lib/api-errors";
import { CallMonitor } from "@/lib/call-monitor";
import { HANGUP_DEADLINE_SECONDS, readServerConfig, type ServerConfig } from "@/lib/config";
import { scheduleSweep } from "@/lib/hangup-sweep";
import { modelAccessProblem } from "@/lib/model-check";
import { createRealtimeCall, hangupRealtimeCall } from "@/lib/openai";
import { forgetHangup, rememberHangup } from "@/lib/pending-hangups";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildRealtimeSession, spendLimits } from "@/lib/realtime-session";
import { clientIp, isAllowedOrigin, isAllowedPreflight, readJsonBody, safetyIdentifier } from "@/lib/request-guards";
import { issueScoreToken } from "@/lib/score-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The call's monitor runs after the response inside this request (lib/call-monitor.ts).
// Must equal ROUTE_MAX_DURATION_SECONDS in lib/config.ts.
export const maxDuration = 300;

const MAX_SDP_BYTES = 65_536;
const MAX_BODY_BYTES = MAX_SDP_BYTES + 4_096;
const DAY_MS = 24 * 60 * 60_000;
/** Calls per client per 10 minutes. */
const CALLS_PER_WINDOW = 6;
const WINDOW_MS = 10 * 60_000;
/** Calls that may run at once from one client. */
const CONCURRENT_CALLS = 2;
/** Preflight checks per client per 10 minutes. The page makes one before each call. */
const CHECKS_PER_WINDOW = 30;
/** A scorecard may be requested this long after the call's deadline. */
const SCORE_TOKEN_GRACE_MS = 10 * 60_000;

type SessionRequest = { personaId: string; stageNumber: number; sdp: string };

function parseSessionRequest(value: unknown): SessionRequest | null {
  if (!value || typeof value !== "object") return null;
  const { personaId, stageNumber, sdp } = value as Record<string, unknown>;
  if (typeof personaId !== "string" || !/^[a-z0-9-]{1,64}$/.test(personaId)) return null;
  if (typeof stageNumber !== "number" || !Number.isInteger(stageNumber) || stageNumber < 1) return null;
  if (typeof sdp !== "string" || !sdp.startsWith("v=0")) return null;
  if (new TextEncoder().encode(sdp).length > MAX_SDP_BYTES) return null;
  return { personaId, stageNumber, sdp };
}

function limited(error: string, retryAfterSeconds: number) {
  return json({ code: "rate_limited", error }, 429, { "Retry-After": String(retryAfterSeconds) });
}

/**
 * Checks every limit, the client's own first so one busy client can't use up the
 * daily allowance. With `consume: false` it only looks: the page asks before it
 * opens the microphone, and the POST asks again before it reads the body, so a
 * request that turns out to be invalid never counts. Without a trusted proxy,
 * clients can't be told apart, so they share one "client" bucket (see clientIp).
 */
async function checkLimits(config: ServerConfig, client: string, consume: boolean) {
  const perClient = await checkRateLimit("session", client, CALLS_PER_WINDOW, WINDOW_MS, { consume });
  if (!perClient.allowed) {
    return limited("Too many calls from this network. Try again in a few minutes.", perClient.retryAfterSeconds);
  }
  const running = await checkRateLimit("concurrent", client, CONCURRENT_CALLS, config.sessionMaxSeconds * 1000, {
    consume,
  });
  if (!running.allowed) {
    return limited("Too many calls are running from this network. Finish one first.", running.retryAfterSeconds);
  }
  const daily = await checkRateLimit("daily", "all", config.maxCallsPerDay, DAY_MS, { consume });
  if (!daily.allowed) {
    return limited("This app has reached its daily call limit. Try again tomorrow.", daily.retryAfterSeconds);
  }
  return null;
}

function readConfig() {
  try {
    return { config: readServerConfig() };
  } catch (error) {
    const described = describeError(error, "start the call");
    console.error(`[session] ${described.error}`);
    return { response: json({ code: described.code, error: described.error }, described.status) };
  }
}

/**
 * Checks, without starting anything, whether a call could start now: the server
 * is configured, the key works and can see the models, and no limit is reached.
 * The page calls this before it asks for the microphone. Responds
 * `{ ready: true }`, or the same errors as POST. Origin-checked and rate-limited
 * like POST, though it costs nothing at OpenAI.
 */
export async function GET(request: Request) {
  if (!isAllowedPreflight(request)) return json({ code: "forbidden", error: "Forbidden" }, 403);
  const client = clientIp(request) ?? "client";
  const checks = await checkRateLimit("preflight", client, CHECKS_PER_WINDOW, WINDOW_MS);
  if (!checks.allowed) return limited("Too many checks from this network. Try again in a few minutes.", checks.retryAfterSeconds);
  const { config, response } = readConfig();
  if (!config) return response;
  const problem = await modelAccessProblem(config);
  if (problem) {
    console.error(`[session] ${problem.code}`);
    return json({ code: problem.code, error: problem.error }, problem.status);
  }
  return (await checkLimits(config, client, false)) ?? json({ ready: true });
}

/**
 * Starts a voice call. The browser posts its WebRTC SDP offer; the server adds
 * the persona instructions, starts the call with OpenAI, connects the call's
 * monitor and returns `{ answerSdp, maxSeconds, scoreToken }`. The call ID stays
 * on the server.
 */
export async function POST(request: Request) {
  // The cap counts from the moment the request arrives, so the hang-up retries
  // always fit inside the function's time limit.
  const requestStart = Date.now();
  if (!isAllowedOrigin(request)) return json({ code: "forbidden", error: "Forbidden" }, 403);

  const { config, response } = readConfig();
  if (!config) return response;

  const ip = clientIp(request);
  const client = ip ?? "client";
  const full = await checkLimits(config, client, false);
  if (full) return full;

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ code: "invalid_request", error: "Invalid request" }, body.status);
  const input = parseSessionRequest(body.value);
  if (!input) return json({ code: "invalid_request", error: "Invalid request" }, 400);
  const persona = findPersona(input.personaId);
  const stage = persona ? findStage(persona, input.stageNumber) : undefined;
  if (!persona || !stage) return json({ code: "not_found", error: "Unknown persona or stage" }, 404);

  const blocked = await checkLimits(config, client, true);
  if (blocked) return blocked;

  try {
    const session = buildRealtimeSession(persona, stage, config);
    const { answerSdp, callId } = await createRealtimeCall({
      apiKey: config.openaiApiKey,
      sdp: input.sdp,
      session,
      safetyIdentifier: safetyIdentifier(ip),
    });
    const endsAt = requestStart + config.sessionMaxSeconds * 1000;
    await rememberHangup(callId, endsAt);
    let monitor: CallMonitor;
    try {
      monitor = await CallMonitor.start({
        callId,
        apiKey: config.openaiApiKey,
        endsAt,
        giveUpAt: requestStart + HANGUP_DEADLINE_SECONDS * 1000,
        limits: spendLimits(session, config),
      });
    } catch {
      // No monitor, no call. If this hang-up fails, the call stays pending for a sweep.
      if ((await hangupRealtimeCall({ apiKey: config.openaiApiKey, callId })) !== "failed") await forgetHangup(callId);
      console.error("[session] the call's monitor could not connect, so the call was ended");
      return json({ code: "monitor_unavailable", error: "Could not start the call. Try again in a moment." }, 502);
    }
    after(() => monitor.finished.then(() => undefined));
    scheduleSweep(config.openaiApiKey);
    const scoreToken = issueScoreToken(
      { callId, personaId: persona.id, stageNumber: stage.number, exp: endsAt + SCORE_TOKEN_GRACE_MS },
      config.openaiApiKey,
    );
    return json({ answerSdp, maxSeconds: config.sessionMaxSeconds, scoreToken });
  } catch (error) {
    const described = describeError(error, "start the call");
    console.error(`[session] realtime call could not start (${described.code})`);
    return json({ code: described.code, error: described.error }, described.status);
  }
}
