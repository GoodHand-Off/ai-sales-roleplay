import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Sales Role Play",
  description:
    "Practice in-home sales conversations with a voice AI homeowner who pushes back, then get a coaching scorecard.",
  authors: [{ name: "GoodHandoff", url: "https://goodhandoff.com" }],
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#183a63",
};

const GOODHANDOFF_URL = "https://goodhandoff.com/?utm_source=github&utm_medium=kit&utm_campaign=ai-sales-roleplay";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
            <Link href="/" className="text-sm font-semibold text-navy">
              AI Sales Role Play
            </Link>
            <span className="text-xs text-slate-500">Practice mode · AI homeowners</span>
          </div>
        </header>
        <main className="mx-auto max-w-3xl px-4 py-8 sm:py-10">{children}</main>
        <footer className="mx-auto max-w-3xl px-4 pb-10 text-xs text-slate-500">
          Open source under Apache-2.0. Built by{" "}
          <a href={GOODHANDOFF_URL} className="font-medium text-navy underline">
            GoodHandoff
          </a>
          .
        </footer>
      </body>
    </html>
  );
}
