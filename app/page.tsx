import Link from "next/link";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { PERSONAS } from "@/content/personas";
import { SetupNotice } from "@/components/SetupNotice";
import { configProblem, displayedSessionSeconds } from "@/lib/config";
import { formatDuration } from "@/lib/persona-view";

export const dynamic = "force-dynamic";

const TRADE_LABEL = { roofing: "Roofing", hvac: "HVAC", windows: "Windows" } as const;

export default function HomePage() {
  const seconds = displayedSessionSeconds();
  const problem = configProblem();
  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
        Practice the conversation before the real one.
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
        Pick a homeowner and talk to them out loud. They push back the way real homeowners do. Each call
        lasts up to {formatDuration(seconds)}, then you get a scorecard: how much they trusted you, what worked, and
        the one line to change.
      </p>

      {problem ? (
        <div className="mt-6">
          <SetupNotice problem={problem} />
        </div>
      ) : null}

      <ul className="mt-8 grid gap-4">
        {PERSONAS.map((persona) => (
          <li key={persona.id}>
            <Link
              href={`/roleplay/${persona.id}`}
              className="flex gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-navy/40 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2"
            >
              <InitialsAvatar name={persona.name} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="font-semibold text-slate-900">{persona.name}</p>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                    {TRADE_LABEL[persona.trade]}
                  </span>
                  <span className="text-xs text-slate-500">
                    {persona.stages.length === 1 ? "1 stage" : `${persona.stages.length} stages`}
                  </span>
                </div>
                <p className="text-sm text-slate-500">
                  {persona.age}, {persona.occupation}
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-700">{persona.summary}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
