import { DateTime, Effect, Schema } from "effect";

/** A calendar day in New York (Krillion's reset clock), `YYYY-MM-DD`. */
export const Day = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).pipe(Schema.brand("Day"));
export type Day = typeof Day.Type;

const NewYork = DateTime.zoneMakeNamedUnsafe("America/New_York");

export const eastern = (at: DateTime.DateTime): { readonly day: Day; readonly hour: number } => {
  const local = DateTime.setZone(at, NewYork);
  return { day: Day.make(DateTime.formatIsoDate(local)), hour: DateTime.toParts(local).hour };
};

export const easternToday: Effect.Effect<Day> = Effect.map(DateTime.now, (now) => eastern(now).day);

export const KRILLION_ORIGIN = "https://krillion.io";

export const Prompt = Schema.Struct({ id: Schema.String, text: Schema.String });

/** GET https://krillion.io/api/today */
export const TodayGame = Schema.Struct({
  date: Day,
  dayNumber: Schema.Number,
  resetsAt: Schema.String,
  prompts: Schema.Array(Prompt),
});
export type TodayGame = typeof TodayGame.Type;

/** One roster entry in KV `models`. */
export const ModelEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  vision: Schema.optional(Schema.Boolean),
  thinkingLevel: Schema.optional(Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
});
export type ModelEntry = typeof ModelEntry.Type;

/** KV key `models`. */
export const ModelsDoc = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Array(ModelEntry).check(
    Schema.makeFilter((models) => new Set(models.map((m) => m.id)).size === models.length || "duplicate model id"),
  ),
});
export type ModelsDoc = typeof ModelsDoc.Type;

export const TerminalStatus = Schema.Literals(["completed", "timed_out", "failed", "infra_error", "aborted"]);
export type TerminalStatus = typeof TerminalStatus.Type;
export const RunStatus = Schema.Union([Schema.Literals(["queued", "running"]), TerminalStatus]);
export type RunStatus = typeof RunStatus.Type;
export const isTerminal = Schema.is(TerminalStatus);

/** What a batch is asked to do. */
export const BatchRequest = Schema.Struct({
  /** ET day for real runs. Trials take whatever day the site is on. */
  day: Schema.NullOr(Day),
  trial: Schema.Boolean,
  /** Restrict to these roster ids (trials). */
  models: Schema.NullOr(Schema.Array(Schema.String)),
  /** "cron" or the admin's email. */
  createdBy: Schema.String,
});
export type BatchRequest = typeof BatchRequest.Type;

export const BatchConfig = Schema.Struct({ ...BatchRequest.fields, createdAt: Schema.Number });
export type BatchConfig = typeof BatchConfig.Type;

/** What the coordinator hands a DiveAgent. */
export const RunInput = Schema.Struct({
  runId: Schema.String,
  batch: Schema.String,
  day: Day,
  attempt: Schema.Number,
  trial: Schema.Boolean,
  model: ModelEntry,
  prompts: Schema.Array(Prompt),
});
export type RunInput = typeof RunInput.Type;

/** One `/api/submit` exchange as captured from the network. */
export const Submission = Schema.Struct({
  runId: Schema.String,
  seq: Schema.Number,
  day: Schema.String,
  promptId: Schema.String,
  submittedAt: Schema.String,
  rawAnswer: Schema.String,
  kind: Schema.Literals(["accepted", "rejected", "correction", "error"]),
  canonical: Schema.NullOr(Schema.String),
  correction: Schema.NullOr(Schema.String),
  tier: Schema.NullOr(Schema.String),
  score: Schema.NullOr(Schema.Number),
  httpStatus: Schema.Number,
  latencyMs: Schema.Number,
  clockMs: Schema.NullOr(Schema.Number),
});
export type Submission = typeof Submission.Type;

/** Result per prompt of a finished run. */
export const PromptResult = Schema.Struct({
  promptId: Schema.String,
  outcome: Schema.Literals(["accepted", "timed_out", "not_reached"]),
  answer: Schema.NullOr(Schema.String),
  tier: Schema.NullOr(Schema.String),
  score: Schema.Number,
  attempts: Schema.Number,
  msToAccept: Schema.NullOr(Schema.Number),
});
export type PromptResult = typeof PromptResult.Type;

/** Everything a finished run records. */
export const RunSummary = Schema.Struct({
  runId: Schema.String,
  day: Day,
  modelId: Schema.String,
  status: TerminalStatus,
  error: Schema.NullOr(Schema.String),
  totalScore: Schema.Number,
  steps: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  costUsd: Schema.NullOr(Schema.Number),
  piOutcome: Schema.String,
  selfReport: Schema.NullOr(Schema.String),
  results: Schema.Array(PromptResult),
});
export type RunSummary = typeof RunSummary.Type;
