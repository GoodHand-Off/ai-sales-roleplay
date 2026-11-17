import type { ReactNode } from "react";
import type { Outcome, Scorecard } from "@/lib/scorecard-shape";

const OUTCOME_LABEL: Record<Outcome, { text: string; className: string }> = {
  advanced: { text: "Earned the next step", className: "bg-emerald-100 text-emerald-900" },
  stalled: { text: "Still undecided", className: "bg-amber-100 text-amber-900" },
  lost: { text: "Lost the homeowner", className: "bg-rose-100 text-rose-900" },
};

function TrustMeter({ score }: { score: number }) {
  return (
    <div>
      <p className="text-sm font-medium text-slate-600">Trust by the end</p>
      <p className="mt-1 text-4xl font-bold tabular-nums text-slate-900">
        {score}
        <span className="text-xl font-semibold text-slate-600">/10</span>
      </p>
      <div className="mt-2 grid grid-cols-10 gap-1" aria-hidden>
        {Array.from({ length: 10 }, (_, index) => (
          <span
            key={index}
            className={`h-2 rounded-full ${index < score ? (score >= 7 ? "bg-emerald-500" : score >= 4 ? "bg-amber-400" : "bg-rose-500") : "bg-slate-200"}`}
          />
        ))}
      </div>
    </div>
  );
}

function Quote({ children }: { children: ReactNode }) {
  return <q className="font-medium text-slate-900">{children}</q>;
}

/** The post-call scorecard. `footer` holds whatever comes next (retry, next stage, sign-up). */
export function ScorecardView({
  scorecard,
  homeownerName,
  footer,
}: {
  scorecard: Scorecard;
  homeownerName: string;
  footer?: ReactNode;
}) {
  const outcome = OUTCOME_LABEL[scorecard.outcome];
  return (
    <section
      aria-labelledby="scorecard-title"
      className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="scorecard-title" className="text-base font-semibold text-slate-900">
          Your scorecard
        </h2>
        {scorecard.scored ? (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${outcome.className}`}>{outcome.text}</span>
        ) : null}
      </div>

      {scorecard.scored ? (
        <>
          <div className="mt-4 grid gap-5 sm:grid-cols-[10rem_1fr] sm:items-center">
            <TrustMeter score={scorecard.trustScore} />
            <p className="text-lg font-semibold leading-7 text-slate-900">{scorecard.headline}</p>
          </div>

          {scorecard.whatWorked.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-700">What worked</h3>
              <ul className="mt-2 space-y-3">
                {scorecard.whatWorked.map((item, index) => (
                  <li key={index} className="text-sm leading-6 text-slate-700">
                    {item.quote ? <Quote>{item.quote}</Quote> : null} {item.why}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-6">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-rose-700">The biggest fix</h3>
            <p className="mt-2 text-sm leading-6 text-slate-700">
              {scorecard.biggestFix.quote ? <Quote>{scorecard.biggestFix.quote}</Quote> : null}{" "}
              {scorecard.biggestFix.why}
            </p>
          </div>

          {scorecard.tryInstead ? (
            <div className="mt-6 rounded-xl border-l-4 border-cyan bg-cyan/10 p-4">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-navy">Try this instead</h3>
              <p className="mt-1 text-base leading-7 text-slate-900">&ldquo;{scorecard.tryInstead}&rdquo;</p>
            </div>
          ) : null}

          {scorecard.objections.length > 0 ? (
            <div className="mt-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-600">
                Objections {homeownerName.split(/\s+/)[0]} raised
              </h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {scorecard.objections.map((objection, index) => (
                  <li key={index} className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {objection}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div className="mt-3">
          <p className="text-lg font-semibold text-slate-900">{scorecard.headline}</p>
          <p className="mt-2 text-sm leading-6 text-slate-700">{scorecard.biggestFix.why}</p>
        </div>
      )}

      {footer ? <div className="mt-6 border-t border-slate-100 pt-5">{footer}</div> : null}
    </section>
  );
}
