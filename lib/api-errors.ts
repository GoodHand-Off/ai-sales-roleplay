import { NextResponse } from "next/server";
import { ConfigError } from "./config";
import { OpenAIRequestError } from "./openai";

/** An error response the browser shows as-is: plain words, an error code, no secrets. */
export type ApiError = { status: number; code: string; error: string };

/** JSON response helper for the API routes; never cached. */
export function json(body: object, status = 200, headers?: Record<string, string>): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** OpenAI answered 401: the key itself is wrong. */
export const KEY_REJECTED: ApiError = {
  status: 502,
  code: "openai_key_rejected",
  error:
    "OpenAI rejected the server's API key (OPENAI_API_KEY). Check the key at https://platform.openai.com/api-keys and restart the server.",
};

/** OpenAI answered 404 for a model: the name is wrong or the project can't use it. */
export function modelUnavailable(model?: string, variable?: string): ApiError {
  const which = model && variable ? `The model "${model}" (${variable})` : "A configured model";
  return {
    status: 502,
    code: "openai_model_unavailable",
    error: `${which} isn't available to this OpenAI key's project. Check the model name, or the project's model access at https://platform.openai.com/settings.`,
  };
}

/**
 * Turns a configuration or OpenAI failure into a message the person running the
 * app can act on. Unknown errors become a generic 502.
 */
export function describeError(error: unknown, action: "start the call" | "write the scorecard"): ApiError {
  if (error instanceof ConfigError) {
    return { status: 500, code: "config", error: error.message };
  }
  if (error instanceof OpenAIRequestError) {
    if (error.status === 401) return KEY_REJECTED;
    if (error.status === 403) {
      return {
        status: 502,
        code: "openai_key_forbidden",
        error:
          "This OpenAI key isn't allowed to make this request. A restricted key needs write access to Realtime and to Model capabilities; check it at https://platform.openai.com/api-keys.",
      };
    }
    if (error.status === 404) return modelUnavailable();
    if (error.status === 429) {
      return {
        status: 503,
        code: "openai_rate_limited",
        error: "OpenAI's rate limit or the project's budget was reached. Try again later, or check billing at https://platform.openai.com.",
      };
    }
  }
  return { status: 502, code: "upstream", error: `Could not ${action}. Try again in a moment.` };
}
