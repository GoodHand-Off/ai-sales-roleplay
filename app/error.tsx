"use client";

/** Shown when a page fails to render. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <section role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-rose-950">
      <h1 className="text-lg font-semibold">Something went wrong on this page.</h1>
      <p className="mt-2 text-sm leading-6">Try again. If it keeps happening, check the server log.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-xl bg-navy px-5 py-2.5 text-sm font-semibold text-white hover:bg-navy-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2"
      >
        Try again
      </button>
    </section>
  );
}
