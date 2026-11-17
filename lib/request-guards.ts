import { createHash } from "node:crypto";

type Env = Record<string, string | undefined>;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parses a comma-separated origin list, skipping anything that is not an http(s) URL. */
export function parseOrigins(value: string | undefined): string[] {
  const origins: string[] = [];
  for (const part of value?.split(",") ?? []) {
    try {
      const url = new URL(part.trim());
      if (url.protocol === "http:" || url.protocol === "https:") origins.push(url.origin);
    } catch {
      // config.ts reports the invalid entry on the page.
    }
  }
  return origins;
}

/**
 * The origins allowed to call the API.
 * - APP_ORIGIN, when set: a comma-separated list such as "https://practice.example.com".
 * - On Vercel: the deployment, branch and production URLs Vercel provides.
 * - Otherwise: null, meaning only localhost origins (local development).
 */
export function allowedOrigins(env: Env = process.env): string[] | null {
  const configured = parseOrigins(env.APP_ORIGIN);
  if (configured.length) return configured;
  if (env.VERCEL === "1") {
    return [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]
      .filter((host): host is string => Boolean(host))
      .map((host) => `https://${host}`);
  }
  return null;
}

/**
 * Browsers send an Origin header on every POST, and a web page can't fake it.
 * Requiring an allowed origin stops other websites (including DNS-rebinding
 * pages that resolve to your machine) from spending your OpenAI key through
 * visitors' browsers. Scripts can fake the header, which is why the rate limits,
 * the daily cap and the server-side time cap exist too.
 */
export function isAllowedOrigin(request: Request, env: Env = process.env): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const allowed = allowedOrigins(env);
  if (allowed) return allowed.includes(parsed.origin);
  return LOCAL_HOSTNAMES.has(parsed.hostname);
}

/**
 * The host the browser asked for: the Host header, or the first
 * X-Forwarded-Host entry where a proxy sets it (Vercel, or TRUST_PROXY=true).
 */
function requestHost(request: Request, env: Env): string | null {
  const proxied = env.VERCEL === "1" || env.TRUST_PROXY === "true";
  const forwarded = proxied ? request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() : undefined;
  const host = forwarded || request.headers.get("host");
  if (!host) return null;
  try {
    return new URL(`http://${host}`).host;
  } catch {
    return null;
  }
}

/**
 * The origin check for GET requests, which browsers send without an Origin
 * header when they are same-origin. Allowed: an allowed Origin, or a browser's
 * same-origin fetch (`Sec-Fetch-Site: same-origin`, which a page can't fake) to
 * an allowed host. The host matters because a DNS-rebinding page is same-origin
 * with itself: its requests carry its own name as the Host. Requests with
 * neither header (scripts, very old browsers) are refused, as POSTs without an
 * Origin are.
 */
export function isAllowedPreflight(request: Request, env: Env = process.env): boolean {
  if (request.headers.get("origin") !== null) return isAllowedOrigin(request, env);
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  const host = requestHost(request, env);
  if (!host) return false;
  const allowed = allowedOrigins(env);
  if (allowed) return allowed.some((origin) => new URL(origin).host === host);
  return LOCAL_HOSTNAMES.has(new URL(`http://${host}`).hostname);
}

/**
 * The client IP for per-IP rate limits, or null when it can't be trusted.
 * - On Vercel the edge overwrites X-Forwarded-For with the real client IP.
 * - With TRUST_PROXY=true (your own reverse proxy in front), the right-most
 *   X-Forwarded-For entry is the one your proxy appended.
 * - Otherwise the header comes from the client and is ignored.
 */
export function clientIp(request: Request, env: Env = process.env): string | null {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!forwarded?.length) return null;
  if (env.VERCEL === "1") return forwarded[0] ?? null;
  if (env.TRUST_PROXY === "true") return forwarded[forwarded.length - 1] ?? null;
  return null;
}

/**
 * A stable, non-reversible ID for the visitor, sent to OpenAI as a safety
 * identifier so abuse can be traced without sharing the IP address.
 */
export function safetyIdentifier(ip: string | null): string {
  return createHash("sha256").update(`ai-sales-roleplay:${ip ?? "unidentified"}`).digest("hex").slice(0, 32);
}

/** Result of reading a JSON body: the value, or the HTTP status to answer with. */
export type BodyResult = { ok: true; value: unknown } | { ok: false; status: 400 | 411 | 413 };

/**
 * Reads a JSON body without ever holding more than `maxBytes`. Requires a
 * Content-Length (browsers always send one for these requests), then counts
 * the bytes actually streamed, in case the header lies.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return { ok: false, status: 411 };
  if (Number(declared) > maxBytes) return { ok: false, status: 413 };
  if (!request.body) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}
