import { Schema } from "effect";

/** GET https://krillion.io/api/today */
export const TodayGame = Schema.Struct({
  date: Schema.String,
  dayNumber: Schema.Number,
  resetsAt: Schema.String,
  prompts: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
});
export type TodayGame = typeof TodayGame.Type;

/** POST https://krillion.io/api/submit request body (as the page sends it). */
export const SubmitRequest = Schema.Struct({
  date: Schema.String,
  promptId: Schema.String,
  answer: Schema.String,
});

/**
 * POST /api/submit response. Observed shapes:
 * `{accepted:false}`, `{accepted:true, answer, tier, score}`, `{correction}`.
 */
export const SubmitResponse = Schema.Struct({
  accepted: Schema.optional(Schema.Boolean),
  answer: Schema.optional(Schema.String),
  tier: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
  correction: Schema.optional(Schema.String),
});
export type SubmitResponse = typeof SubmitResponse.Type;

export const ThinkingLevel = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** One roster entry in KV `models`. */
export const ModelEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  vision: Schema.optional(Schema.Boolean),
  thinkingLevel: Schema.optional(ThinkingLevel),
});
export type ModelEntry = typeof ModelEntry.Type;

/** KV key `models`. */
export const ModelsDoc = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(ModelEntry),
});
export type ModelsDoc = typeof ModelsDoc.Type;

export const RunStatus = Schema.Literals([
  "queued",
  "running",
  "completed",
  "timed_out",
  "failed",
  "infra_error",
  "aborted",
]);
export type RunStatus = typeof RunStatus.Type;

export const TERMINAL: Record<RunStatus, boolean> = {
  queued: false,
  running: false,
  completed: true,
  timed_out: true,
  failed: true,
  infra_error: true,
  aborted: true,
};

/** What the coordinator hands a DiveAgent. Stored in the agent's own storage. */
export const RunInput = Schema.Struct({
  runId: Schema.String,
  batch: Schema.String,
  day: Schema.String,
  attempt: Schema.Number,
  trial: Schema.Boolean,
  model: ModelEntry,
  prompts: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
});
export type RunInput = typeof RunInput.Type;

/** The page's `localStorage["krillion:game:v1"]`, the parts we read. */
export const GameState = Schema.Struct({
  date: Schema.optional(Schema.String),
  roundIndex: Schema.optional(Schema.Number),
  phase: Schema.optional(Schema.String),
  answerEndsAt: Schema.optional(Schema.NullOr(Schema.Number)),
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        promptId: Schema.String,
        answer: Schema.optional(Schema.NullOr(Schema.String)),
        tier: Schema.optional(Schema.NullOr(Schema.String)),
        score: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
export type GameState = typeof GameState.Type;

export const ANSWER_WINDOW_MS = 25_000;
