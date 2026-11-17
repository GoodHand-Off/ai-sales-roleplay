"use client";

import { useEffect, useRef, useState } from "react";
import { lastFinishedLine, transcriptLines } from "@/lib/realtime-events";
import type { CallSnapshot } from "@/lib/voice-call";
import { InitialsAvatar } from "./InitialsAvatar";

function useSecondsLeft(endsAt: number | null): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (endsAt === null) return;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 250);
    const first = window.setTimeout(tick, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [endsAt]);
  if (endsAt === null || now === null) return null;
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The call screen: who is talking, time left, the live transcript and the hang-up button. */
export function LiveCall({
  homeownerName,
  snapshot,
  onEnd,
  onResumeAudio,
}: {
  homeownerName: string;
  snapshot: CallSnapshot;
  onEnd: () => void;
  onResumeAudio: () => void;
}) {
  const secondsLeft = useSecondsLeft(snapshot.endsAt);
  const lines = transcriptLines(snapshot.transcript);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const first = homeownerName.split(/\s+/)[0] ?? homeownerName;

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines.length, snapshot.transcript]);

  const { homeownerSpeaking, repSpeaking } = snapshot.transcript;
  const lastReply = lastFinishedLine(snapshot.transcript, "homeowner");
  const status =
    snapshot.phase === "connecting"
      ? "Connecting…"
      : homeownerSpeaking
        ? `${first} is talking`
        : repSpeaking
          ? "You're talking"
          : "Listening…";
  const lowTime = secondsLeft !== null && secondsLeft <= 30;

  return (
    <section
      aria-label={`Call with ${homeownerName}`}
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-center gap-4">
        <InitialsAvatar name={homeownerName} size="lg" speaking={homeownerSpeaking} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-semibold text-slate-900">{homeownerName}</p>
          <p className="text-sm text-slate-600">{status}</p>
        </div>
        {secondsLeft !== null ? (
          <span
            className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${lowTime ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-700"}`}
            role="timer"
            aria-label={`${secondsLeft} seconds left`}
          >
            {formatClock(secondsLeft)}
          </span>
        ) : null}
      </div>

      {/* Screen readers hear each finished reply once, not every partial word. */}
      <p className="sr-only" aria-live="polite">
        {lastReply ? `${first}: ${lastReply}` : ""}
      </p>

      {snapshot.audioBlocked ? (
        <button
          type="button"
          onClick={onResumeAudio}
          className="mt-4 w-full rounded-xl bg-amber-100 px-4 py-2.5 text-sm font-semibold text-amber-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-800 focus-visible:ring-offset-2"
        >
          Your browser paused the audio. Tap to hear {first}.
        </button>
      ) : null}

      <div
        ref={scrollRef}
        className="mt-5 h-64 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-3 sm:h-72"
        role="region"
        aria-label="Live transcript"
        tabIndex={0}
      >
        {lines.length === 0 ? (
          <p className="p-2 text-sm text-slate-500">
            {snapshot.phase === "connecting" ? "Connecting the call…" : `${first} is coming to the door…`}
          </p>
        ) : (
          lines.map((line, index) => (
            <div key={index} className={`flex ${line.speaker === "rep" ? "justify-end" : "justify-start"}`}>
              <p
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-6 ${line.speaker === "rep" ? "bg-navy text-white" : "bg-white text-slate-800 shadow-sm ring-1 ring-slate-200"}`}
              >
                {line.text}
              </p>
            </div>
          ))
        )}
      </div>

      <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-slate-500">You are talking to an AI homeowner. Speak normally; pause to let {first} answer.</p>
        <button
          type="button"
          onClick={onEnd}
          className="rounded-xl border border-rose-300 bg-white px-5 py-2.5 text-sm font-semibold text-rose-700 transition hover:bg-rose-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-700 focus-visible:ring-offset-2"
        >
          End call
        </button>
      </div>
    </section>
  );
}
