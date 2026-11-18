import type { SubmissionResult } from "./Database";
import type { PromptResult } from "./domain";

/**
 * One prompt's result from a run's captured submissions: the accepted one if any; else a
 * miss, `timed_out` once tried or `reached`, otherwise `not_reached`. The finalizing
 * agent and the live view both score runs this way.
 */
export const scorePrompt = (
  promptId: string,
  subs: ReadonlyArray<SubmissionResult>,
  reached: boolean,
): PromptResult => {
  const mine = subs.filter((s) => s.promptId === promptId);
  const accepted = mine.find((s) => s.kind === "accepted");
  const attempts = mine.length;
  if (accepted !== undefined) {
    return {
      promptId,
      outcome: "accepted",
      answer: accepted.canonical,
      tier: accepted.tier,
      score: accepted.score ?? 0,
      attempts,
      msToAccept: accepted.clockMs,
    };
  }
  const outcome = attempts > 0 || reached ? "timed_out" : "not_reached";
  return { promptId, outcome, answer: null, tier: null, score: 0, attempts, msToAccept: null };
};
