/** Transcript types shared by the browser and the server. */

/** Who said a line: the human rep or the AI homeowner. */
export type Speaker = "rep" | "homeowner";

/** One finished line of the conversation. */
export type TranscriptLine = { speaker: Speaker; text: string };

/** Why a call ended. */
export type EndReason = "stage_complete" | "rep_ended" | "time_cap" | "connection_lost";

/** Every valid end reason, for validating input. */
export const END_REASONS: readonly EndReason[] = [
  "stage_complete",
  "rep_ended",
  "time_cap",
  "connection_lost",
];

/** Size limits for a transcript sent to the scorecard route. */
export const TRANSCRIPT_LIMITS = {
  maxLines: 200,
  maxLineChars: 2_000,
  maxTotalChars: 20_000,
} as const;

/** Validates transcript input from the browser. Returns null if it is malformed. */
export function parseTranscript(value: unknown): TranscriptLine[] | null {
  if (!Array.isArray(value) || value.length > TRANSCRIPT_LIMITS.maxLines) return null;
  const lines: TranscriptLine[] = [];
  let total = 0;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const { speaker, text } = entry as Record<string, unknown>;
    if (speaker !== "rep" && speaker !== "homeowner") return null;
    if (typeof text !== "string" || text.length > TRANSCRIPT_LIMITS.maxLineChars) return null;
    const trimmed = text.trim();
    if (!trimmed) continue;
    total += trimmed.length;
    if (total > TRANSCRIPT_LIMITS.maxTotalChars) return null;
    lines.push({ speaker, text: trimmed });
  }
  return lines;
}

/** Plain-text transcript with the labels the coaching prompt expects. */
export function formatTranscript(lines: TranscriptLine[], homeownerName: string): string {
  return lines
    .map((line) =>
      line.speaker === "rep" ? `SALES REP: ${line.text}` : `HOMEOWNER (${homeownerName}): ${line.text}`,
    )
    .join("\n");
}

/** How much the rep actually said: turns and characters. */
export function repSpeech(lines: TranscriptLine[]): { turns: number; chars: number } {
  const repLines = lines.filter((line) => line.speaker === "rep");
  return { turns: repLines.length, chars: repLines.reduce((sum, line) => sum + line.text.length, 0) };
}
