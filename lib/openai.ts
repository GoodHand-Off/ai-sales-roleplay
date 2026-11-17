/** The OpenAI requests the kit makes, with plain fetch and WebSocket and no SDK. */

const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * An OpenAI request that failed. `status` is the upstream HTTP status, or 502
 * when OpenAI answered but the answer was unusable. The message never includes
 * the API key or the upstream response body.
 */
export class OpenAIRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OpenAIRequestError";
  }
}

type FetchLike = typeof fetch;

/**
 * Starts a Realtime call from the server: sends the browser's SDP offer and the
 * session config to OpenAI, and returns OpenAI's SDP answer plus the call ID.
 * Because the server makes this request, it always knows the call ID and can
 * hang the call up later. The browser never holds an OpenAI credential.
 */
export async function createRealtimeCall(options: {
  apiKey: string;
  sdp: string;
  session: object;
  safetyIdentifier?: string;
  fetchImpl?: FetchLike;
}): Promise<{ answerSdp: string; callId: string }> {
  const body = new FormData();
  body.set("sdp", options.sdp);
  body.set("session", JSON.stringify(options.session));
  const headers: Record<string, string> = { Authorization: `Bearer ${options.apiKey}` };
  if (options.safetyIdentifier) headers["OpenAI-Safety-Identifier"] = options.safetyIdentifier;

  const response = await (options.fetchImpl ?? fetch)(`${OPENAI_BASE_URL}/realtime/calls`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new OpenAIRequestError("Realtime call creation failed", response.status);
  }
  const callId = readCallId(response.headers.get("Location"));
  const answerSdp = await response.text();
  if (!callId) throw new OpenAIRequestError("Realtime call ID missing", 502);
  if (!answerSdp.startsWith("v=0")) throw new OpenAIRequestError("Realtime answer was not SDP", 502);
  return { answerSdp, callId };
}

/** The part of a WebSocket the call monitor uses. Node's built-in WebSocket fits; tests pass a fake. */
export type SidebandSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number }) => void) | null;
};

/**
 * Opens the server's own connection to a running call: OpenAI's "sideband",
 * which receives the call's server events and accepts client events.
 * Node's built-in WebSocket (Node 22 and later) accepts headers as an option.
 */
export function openSideband(callId: string, apiKey: string): SidebandSocket {
  const Socket = globalThis.WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => SidebandSocket;
  const url = `${OPENAI_BASE_URL.replace(/^https:/, "wss:")}/realtime?call_id=${encodeURIComponent(callId)}`;
  return new Socket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

/**
 * Asks whether this key can see `model` (`GET /v1/models/{model}`, which is
 * free). Returns the HTTP status, or 0 when OpenAI could not be reached.
 */
export async function fetchModelStatus(apiKey: string, model: string, fetchImpl: FetchLike = fetch): Promise<number> {
  try {
    const response = await fetchImpl(`${OPENAI_BASE_URL}/models/${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    await response.text().catch(() => "");
    return response.status;
  } catch {
    return 0;
  }
}

/** OpenAI returns the call as `Location: /v1/realtime/calls/{call_id}`. */
export function readCallId(location: string | null): string | null {
  if (!location) return null;
  const match = /\/realtime\/calls\/([A-Za-z0-9_-]{4,128})\/?(?:[?#].*)?$/.exec(location);
  return match?.[1] ?? null;
}

/** "ended": OpenAI hung up the call. "already-ended": the call was over (404). "failed": try again. */
export type HangupResult = "ended" | "already-ended" | "failed";

/** Hangs up a Realtime call. A 404 means the call had already ended. */
export async function hangupRealtimeCall(options: {
  apiKey: string;
  callId: string;
  fetchImpl?: FetchLike;
}): Promise<HangupResult> {
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${OPENAI_BASE_URL}/realtime/calls/${encodeURIComponent(options.callId)}/hangup`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.ok) return "ended";
    if (response.status === 404) return "already-ended";
    return "failed";
  } catch {
    return "failed";
  }
}

/**
 * One Chat Completions call that must return JSON matching a strict schema.
 * @returns the parsed JSON, not yet validated against the schema.
 * @throws {OpenAIRequestError} on an HTTP error, an empty answer or non-JSON content.
 */
export async function createStructuredCompletion(options: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schema: { name: string; schema: object };
  maxTokens: number;
  safetyIdentifier?: string;
  fetchImpl?: FetchLike;
}): Promise<unknown> {
  const outputLimit = options.maxTokens;
  const response = await (options.fetchImpl ?? fetch)(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      // No temperature: reasoning models such as gpt-6-luna use their own sampling.
      max_completion_tokens: outputLimit,
      ...(options.safetyIdentifier ? { safety_identifier: options.safetyIdentifier } : {}),
      response_format: {
        type: "json_schema",
        json_schema: { name: options.schema.name, strict: true, schema: options.schema.schema },
      },
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: options.user },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.text().catch(() => "");
    throw new OpenAIRequestError("Coaching request failed", response.status);
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; refusal?: string | null } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new OpenAIRequestError("Coaching response was empty", 502);
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new OpenAIRequestError("Coaching response was not JSON", 502);
  }
}
