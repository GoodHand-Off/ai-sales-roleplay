/** The scorecard's shape, shared by the browser and the server. No prompt text lives here. */

/** Did the rep earn the next step this stage is about? */
export type Outcome = "advanced" | "stalled" | "lost";

/** The coaching result shown after a call. */
export type Scorecard = {
  /** False when the call was too short to coach; the other fields then explain why. */
  scored: boolean;
  headline: string;
  /** How much the homeowner trusted the rep by the end, 1 to 10. */
  trustScore: number;
  outcome: Outcome;
  whatWorked: Array<{ quote: string; why: string }>;
  biggestFix: { quote: string; why: string };
  /** One exact line to say next time. */
  tryInstead: string;
  objections: string[];
};

function isQuote(value: unknown): value is { quote: string; why: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { quote?: unknown }).quote === "string" &&
    typeof (value as { why?: unknown }).why === "string"
  );
}

/** Checks a scorecard that arrived over the network before the page renders it. */
export function isScorecard(value: unknown): value is Scorecard {
  if (!value || typeof value !== "object") return false;
  const card = value as Record<string, unknown>;
  return (
    typeof card.scored === "boolean" &&
    typeof card.headline === "string" &&
    typeof card.trustScore === "number" &&
    (card.outcome === "advanced" || card.outcome === "stalled" || card.outcome === "lost") &&
    Array.isArray(card.whatWorked) &&
    card.whatWorked.every(isQuote) &&
    isQuote(card.biggestFix) &&
    typeof card.tryInstead === "string" &&
    Array.isArray(card.objections) &&
    card.objections.every((item) => typeof item === "string")
  );
}
