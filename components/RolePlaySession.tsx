"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import type { PersonaView, StageView } from "@/lib/persona-view";
import { transcriptLines } from "@/lib/realtime-events";
import { isScorecard, type Scorecard } from "@/lib/scorecard-shape";
import type { CallSnapshot } from "@/lib/voice-call";
import { ConsentNotice } from "./ConsentNotice";
import { LiveCall } from "./LiveCall";
import { ScorecardView } from "./ScorecardView";
import { StageBriefing } from "./StageBriefing";
import { useVoiceCall } from "./useVoiceCall";

/** The scorecard route waits on one model call; give it room, but not forever. */
const SCORE_TIMEOUT_MS = 60_000;

type ScoreState =
  | { status: "idle" }
  | { status: "scoring" }
  | { status: "done"; scorecard: Scorecard }
  | { status: "error"; message: string };

/** One stage, start to finish: briefing and consent, the call, then the scorecard. */
export function RolePlaySession({
  persona,
  stage,
  maxSeconds,
}: {
  persona: PersonaView;
  stage: StageView;
  maxSeconds: number;
}) {
  const [score, setScore] = useState<ScoreState>({ status: "idle" });
  const [lastCall, setLastCall] = useState<CallSnapshot | null>(null);
  const scoreTokenRef = useRef<string | null>(null);

  const requestScore = useCallback(
    async (ended: CallSnapshot) => {
      setLastCall(ended);
      setScore({ status: "scoring" });
      try {
        const response = await fetch("/api/score", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            personaId: persona.id,
            stageNumber: stage.number,
            transcript: transcriptLines(ended.transcript),
            endReason: ended.endReason ?? "rep_ended",
            scoreToken: scoreTokenRef.current,
          }),
          signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
        });
        const payload: unknown = await response.json().catch(() => null);
        const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (!response.ok || !isScorecard(record.scorecard)) {
          const message = typeof record.error === "string" ? record.error : "The scorecard could not be written.";
          setScore({ status: "error", message });
          return;
        }
        setScore({ status: "done", scorecard: record.scorecard });
      } catch {
        setScore({ status: "error", message: "The scorecard could not be written. Check your connection and try again." });
      }
    },
    [persona.id, stage.number],
  );

  const { audioRef, snapshot, start, end, resumeAudio, reset } = useVoiceCall(requestScore);
  const { phase } = snapshot;
  const inCall = phase === "connecting" || phase === "live";

  const begin = async () => {
    scoreTokenRef.current = null;
    const started = await start({
      sessionUrl: "/api/session",
      preflightUrl: "/api/session",
      requestBody: { personaId: persona.id, stageNumber: stage.number },
    });
    scoreTokenRef.current = started?.scoreToken ?? null;
  };

  const restart = () => {
    reset();
    setScore({ status: "idle" });
    setLastCall(null);
  };

  const nextStage = stage.number < persona.stageCount ? stage.number + 1 : null;

  return (
    <div className="space-y-5">
      {/* The homeowner's voice plays through this element. */}
      <audio ref={audioRef} autoPlay playsInline className="hidden" />

      {score.status === "idle" && !inCall ? (
        <>
          <StageBriefing stage={stage} />
          {phase === "failed" && snapshot.error ? (
            <p role="alert" className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {snapshot.error}
            </p>
          ) : null}
          <ConsentNotice
            homeownerName={persona.name}
            maxSeconds={maxSeconds}
            dataNote="When the call ends, the transcript goes to this app's server and to OpenAI to write your scorecard. This app doesn't save it; OpenAI keeps API data under its own data policy."
            onStart={() => void begin()}
          />
        </>
      ) : null}

      {inCall ? (
        <LiveCall
          homeownerName={persona.name}
          snapshot={snapshot}
          onEnd={end}
          onResumeAudio={resumeAudio}
        />
      ) : null}

      {score.status === "scoring" ? (
        <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-600" aria-live="polite">
          Writing your scorecard. This usually takes 10 to 15 seconds…
        </p>
      ) : null}

      {score.status === "error" ? (
        <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900">
          <p>{score.message}</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {lastCall ? (
              <button type="button" onClick={() => void requestScore(lastCall)} className="font-semibold underline">
                Try the scorecard again
              </button>
            ) : null}
            <button type="button" onClick={restart} className="font-semibold underline">
              Start a new call
            </button>
          </div>
        </div>
      ) : null}

      {score.status === "done" ? (
        <ScorecardView
          scorecard={score.scorecard}
          homeownerName={persona.name}
          footer={
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={restart}
                className="rounded-xl bg-navy px-5 py-2.5 text-sm font-semibold text-white hover:bg-navy-dark"
              >
                Run this stage again
              </button>
              {nextStage ? (
                <Link
                  href={`/roleplay/${persona.id}?stage=${nextStage}`}
                  className="rounded-xl border border-slate-300 px-5 py-2.5 text-center text-sm font-semibold text-slate-800 hover:bg-slate-50"
                >
                  Go to stage {nextStage}
                </Link>
              ) : null}
            </div>
          }
        />
      ) : null}
    </div>
  );
}
