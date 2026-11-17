/** The spoken stage-end marker, shared by the instructions (server) and the call client (browser). */

/**
 * The homeowner says this after their last in-character line, so the browser
 * knows the stage is over and can end the call cleanly.
 */
export function stageEndMarker(stageNumber: number): string {
  return `This concludes stage ${stageNumber}.`;
}

/** Matches the stage-end marker in a spoken transcript. */
export const STAGE_END_PATTERN = /this concludes stage\s+\w+/i;
