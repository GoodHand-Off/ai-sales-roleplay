import Link from "next/link";

/** Shown for unknown pages and unknown homeowners. */
export default function NotFound() {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6">
      <h1 className="text-lg font-semibold text-slate-900">That homeowner isn&apos;t here.</h1>
      <p className="mt-2 text-sm leading-6 text-slate-700">The page or persona you asked for doesn&apos;t exist.</p>
      <Link href="/" className="mt-4 inline-block text-sm font-semibold text-navy underline">
        See all homeowners
      </Link>
    </section>
  );
}
