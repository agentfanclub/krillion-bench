/** Bump whenever PROMPT or the tool surface changes; stored on every run. */
export const PROMPT_VERSION = "2026-11-10.2";

export const PROMPT = `Using the browser tools, play today's Krillion Daily Dive at https://krillion.io and get the highest score you can. Don't overthink it and do not look anything up: answer whatever comes to mind.

How the game works: 7 prompts, each with about 25 seconds once its clock starts. Only correct answers count, and rarer correct answers score more: Plankton 10, Too Clever 15, Schooler 30, Rare 60, Deep Cut 85, One in a Krillion 100. A wrong answer scores nothing but you can try again while the clock runs. Sometimes the game corrects your spelling and asks you to submit again to confirm.

When the dive is finished, reply with your final score and each answer with its tier and points.`;

/** Sent (identically, at most MAX_NUDGES times) when a model ends its turn before the dive is over. */
export const NUDGE =
  "The dive is not finished yet. Keep playing with the browser tools until all 7 prompts are done, then reply with your final score and each answer with its tier and points.";