import type { StageView } from "@/lib/persona-view";

/** What the rep reads before the call: the scene and what to practice. */
export function StageBriefing({ stage }: { stage: StageView }) {
  return (
    <section aria-labelledby="briefing-title" className="rounded-2xl bg-navy p-5 text-white sm:p-6">
      <p className="text-xs font-semibold uppercase tracking-wider text-cyan">
        Stage {stage.number} · {stage.difficulty}
      </p>
      <h2 id="briefing-title" className="mt-1 text-xl font-semibold">
        {stage.title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-200">{stage.scene}</p>
      <h3 className="mt-4 text-sm font-semibold text-white">Practice this</h3>
      <ul className="mt-2 space-y-1.5 text-sm leading-6 text-slate-200">
        {stage.goals.map((goal) => (
          <li key={goal} className="flex gap-2">
            <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-cyan" />
            <span>{goal}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
