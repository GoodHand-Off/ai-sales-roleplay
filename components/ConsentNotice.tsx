import type { ReactNode } from "react";
import { formatDuration } from "@/lib/persona-view";

/**
 * AI disclosure and microphone consent, shown before the mic can open.
 * The microphone is requested only when the rep presses the start button.
 */
export function ConsentNotice({
  homeownerName,
  maxSeconds,
  dataNote,
  onStart,
  startDisabled = false,
  children,
}: {
  homeownerName: string;
  maxSeconds: number;
  /** One sentence on where the transcript goes after the call. */
  dataNote: string;
  onStart: () => void;
  startDisabled?: boolean;
  /** Extra checks to show above the button, such as a CAPTCHA. */
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby="consent-title"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <h2 id="consent-title" className="text-base font-semibold text-slate-900">
        Before you start
      </h2>
      <ul className="mt-3 space-y-2.5 text-sm leading-6 text-slate-700">
        <li>
          <span className="font-semibold text-slate-900">{homeownerName} is an AI.</span> The voice and
          replies come from OpenAI&apos;s Realtime model. This is a practice simulation, not a real
          homeowner.
        </li>
        <li>
          <span className="font-semibold text-slate-900">Your microphone opens only when you press Start.</span>{" "}
          Your browser asks for permission first. Your audio goes to OpenAI to run the conversation and is
          not recorded here.
        </li>
        <li>
          <span className="font-semibold text-slate-900">The call ends on its own after {formatDuration(maxSeconds)}.</span>{" "}
          You can hang up at any time.
        </li>
        <li>{dataNote}</li>
      </ul>
      {children ? <div className="mt-4">{children}</div> : null}
      <button
        type="button"
        onClick={onStart}
        disabled={startDisabled}
        className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-navy px-5 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-navy-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        I understand. Start the call
      </button>
    </section>
  );
}
