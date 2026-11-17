/** Shown instead of the call when the server is missing configuration. Names the variable to fix. */
export function SetupNotice({ problem }: { problem: { variable: string; message: string } }) {
  return (
    <section role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-amber-950 sm:p-6">
      <h2 className="text-base font-semibold">
        Setup needed: <code className="rounded bg-amber-100 px-1.5 py-0.5 text-sm">{problem.variable}</code>
      </h2>
      <p className="mt-2 text-sm leading-6">{problem.message}</p>
      <p className="mt-2 text-sm leading-6">
        Running it yourself? Fix the variable (locally, in <code className="rounded bg-amber-100 px-1 text-xs">.env.local</code>)
        and restart the server.
      </p>
    </section>
  );
}
