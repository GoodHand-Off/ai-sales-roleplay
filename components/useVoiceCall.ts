"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { idleSnapshot, VoiceCall, type CallSnapshot, type StartCallResponse } from "@/lib/voice-call";

/** React wrapper around VoiceCall. Render `<audio ref={audioRef} />` once. */
export function useVoiceCall(onEnded?: (snapshot: CallSnapshot) => void) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const callRef = useRef<VoiceCall | null>(null);
  const onEndedRef = useRef(onEnded);
  const [snapshot, setSnapshot] = useState<CallSnapshot>(idleSnapshot);

  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  /** Drops the current call without reporting it as ended (no scorecard). */
  const discardCurrent = useCallback(() => {
    const call = callRef.current;
    callRef.current = null;
    call?.end("rep_ended");
  }, []);

  useEffect(() => discardCurrent, [discardCurrent]);

  const start = useCallback(
    async (request: {
      sessionUrl: string;
      requestBody: Record<string, unknown>;
      preflightUrl?: string;
    }): Promise<StartCallResponse | null> => {
      const audio = audioRef.current;
      if (!audio) return null;
      discardCurrent();
      let previousPhase: CallSnapshot["phase"] = "idle";
      const call = new VoiceCall({
        ...request,
        audio,
        onChange: (next) => {
          if (callRef.current !== call) return;
          setSnapshot(next);
          if (next.phase === "ended" && previousPhase !== "ended") onEndedRef.current?.(next);
          previousPhase = next.phase;
        },
      });
      callRef.current = call;
      return call.start();
    },
    [discardCurrent],
  );

  /** The rep hangs up. Reported as ended, so a scorecard follows. */
  const end = useCallback(() => callRef.current?.end("rep_ended"), []);
  const resumeAudio = useCallback(() => void callRef.current?.resumeAudio(), []);
  const reset = useCallback(() => {
    discardCurrent();
    setSnapshot(idleSnapshot());
  }, [discardCurrent]);

  return { audioRef, snapshot, start, end, resumeAudio, reset };
}
