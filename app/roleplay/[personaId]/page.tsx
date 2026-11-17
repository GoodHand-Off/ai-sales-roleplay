import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { RolePlaySession } from "@/components/RolePlaySession";
import { findPersona, findStage } from "@/content/personas";
import { SetupNotice } from "@/components/SetupNotice";
import { configProblem, displayedSessionSeconds } from "@/lib/config";
import { toPersonaView, toStageView } from "@/lib/persona-view";

type Props = {
  params: Promise<{ personaId: string }>;
  searchParams: Promise<{ stage?: string | string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const persona = findPersona((await params).personaId);
  return { title: persona ? `${persona.name} · AI Sales Role Play` : "AI Sales Role Play" };
}

export default async function RolePlayPage({ params, searchParams }: Props) {
  const persona = findPersona((await params).personaId);
  if (!persona) notFound();
  const requested = Number((await searchParams).stage ?? "1");
  const stage = findStage(persona, Number.isInteger(requested) ? requested : 1) ?? persona.stages[0];
  if (!stage) notFound();
  const problem = configProblem();

  return (
    <div>
      <Link href="/" className="text-sm font-medium text-navy hover:underline">
        ← All homeowners
      </Link>
      <div className="mt-4 flex items-center gap-4">
        <InitialsAvatar name={persona.name} size="lg" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-900">{persona.name}</h1>
          <p className="text-sm text-slate-600">
            {persona.age}, {persona.occupation} · {persona.program}
          </p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-700">
        {persona.profile.home} {persona.profile.situation}
      </p>

      {persona.stages.length > 1 ? (
        <nav aria-label="Stages" className="mt-5 flex gap-2 overflow-x-auto pb-1">
          {persona.stages.map((item) => (
            <Link
              key={item.number}
              href={`/roleplay/${persona.id}?stage=${item.number}`}
              aria-current={item.number === stage.number ? "step" : undefined}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${item.number === stage.number ? "bg-navy text-white" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:ring-navy/40"}`}
            >
              {item.number}. {item.title}
            </Link>
          ))}
        </nav>
      ) : null}

      <div className="mt-6">
        {problem ? (
          <SetupNotice problem={problem} />
        ) : (
          <RolePlaySession
            key={`${persona.id}-${stage.number}`}
            persona={toPersonaView(persona)}
            stage={toStageView(stage)}
            maxSeconds={displayedSessionSeconds()}
          />
        )}
      </div>
    </div>
  );
}
