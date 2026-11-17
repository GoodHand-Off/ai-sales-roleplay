import { findPersona, findStage } from "@/content/personas";
import { describeError, json } from "@/lib/api-errors";
import { readServerConfig } from "@/lib/config";
import { createStructuredCompletion } from "@/lib/openai";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientIp, isAllowedOrigin, readJsonBody, safetyIdentifier } from "@/lib/request-guards";
import { claimScoreToken, releaseScoreToken, verifyScoreToken } from "@/lib/score-token";
import {
  buildCoachingPrompt,
  parseScorecard,
  SCORECARD_SCHEMA,
  tooShortToScore,
  unscoredScorecard,
} from "@/lib/scorecard";
import { END_REASONS, parseTranscript } from "@/lib/transcript";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 64_000;
/** Scorecards per client per 10 minutes. */
const SCORES_PER_WINDOW = 12;
const WINDOW_MS = 10 * 60_000;

/**
 * Writes the coaching scorecard for a call this server started. Takes
 * `{ personaId, stageNumber, transcript, endReason, scoreToken }`, where
 * `scoreToken` came from POST /api/session, and responds with `{ scorecard }`.
 * Each token gives one scorecard, with one retry if an attempt fails
 * (MAX_SCORE_ATTEMPTS). Calls too short to coach get an unscored card without
 * a model call.
 */
export async function POST(request: Request) {
  if (!isAllowedOrigin(request)) return json({ code: "forbidden", error: "Forbidden" }, 403);

  let config;
  try {
    config = readServerConfig();
  } catch (error) {
    const described = describeError(error, "write the scorecard");
    console.error(`[score] ${described.error}`);
    return json({ code: described.code, error: described.error }, described.status);
  }

  const ip = clientIp(request);
  const limit = await checkRateLimit("score", ip ?? "client", SCORES_PER_WINDOW, WINDOW_MS);
  if (!limit.allowed) {
    return json(
      { code: "rate_limited", error: "Too many scorecards from this network. Try again in a few minutes." },
      429,
      { "Retry-After": String(limit.retryAfterSeconds) },
    );
  }

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return json({ code: "invalid_request", error: "Invalid request" }, body.status);
  if (!body.value || typeof body.value !== "object") return json({ code: "invalid_request", error: "Invalid request" }, 400);
  const { personaId, stageNumber, transcript, endReason, scoreToken } = body.value as Record<string, unknown>;

  const claims = verifyScoreToken(scoreToken, config.openaiApiKey);
  if (!claims || claims.personaId !== personaId || claims.stageNumber !== stageNumber) {
    return json({ code: "invalid_token", error: "This call can't be scored any more. Start a new call." }, 403);
  }
  const persona = findPersona(claims.personaId);
  const stage = persona ? findStage(persona, claims.stageNumber) : undefined;
  if (!persona || !stage) return json({ code: "not_found", error: "Unknown persona or stage" }, 404);
  const lines = parseTranscript(transcript);
  const reason = END_REASONS.find((value) => value === endReason);
  if (!lines || !reason) return json({ code: "invalid_request", error: "Invalid request" }, 400);

  if (!(await claimScoreToken(claims.callId, claims.exp - Date.now()))) {
    return json({ code: "already_scored", error: "This call already has a scorecard, or its attempts are used up." }, 409);
  }

  if (tooShortToScore(lines)) return json({ scorecard: unscoredScorecard(persona) });

  try {
    const prompt = buildCoachingPrompt(persona, stage, lines, reason);
    const raw = await createStructuredCompletion({
      apiKey: config.openaiApiKey,
      model: config.coachingModel,
      system: prompt.system,
      user: prompt.user,
      schema: SCORECARD_SCHEMA,
      // Reasoning tokens count toward this limit; the scorecard itself is about 300.
      maxTokens: 2_000,
      safetyIdentifier: safetyIdentifier(ip),
    });
    const scorecard = parseScorecard(raw);
    if (!scorecard) {
      console.error("[score] coaching response did not match the scorecard schema");
      await releaseScoreToken(claims.callId);
      return json({ code: "upstream", error: "The scorecard could not be written. Try again." }, 502);
    }
    return json({ scorecard });
  } catch (error) {
    await releaseScoreToken(claims.callId);
    const described = describeError(error, "write the scorecard");
    console.error(`[score] coaching request failed (${described.code})`);
    return json({ code: described.code, error: described.error }, described.status);
  }
}
