import { D1Client } from "@effect/sql-d1";
import { Array as Arr, Context, DateTime, Effect, Layer, Order, Schema, String as Str } from "effect";
import { WorkerEnv } from "./Cloudflare";
import { scorePrompt } from "./scoring";
import {
  type BatchConfig,
  type Day,
  ModelEntry,
  isTerminal,
  RunStatus,
  type TerminalStatus,
  type RunSummary,
  Submission,
  type TodayGame,
} from "./domain";

// Rows as the client returns them: column names camelCased, JSON and 0/1 columns decoded.

export const RunRow = Schema.Struct({
  runId: Schema.String,
  batch: Schema.String,
  day: Schema.String,
  modelId: Schema.String,
  attempt: Schema.Number,
  trial: Schema.BooleanFromBit,
  status: RunStatus,
  modelConfig: Schema.fromJsonString(ModelEntry),
  totalScore: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
});
export type RunRow = typeof RunRow.Type;

export const BatchRow = Schema.Struct({
  batch: Schema.String,
  day: Schema.NullOr(Schema.String),
  trial: Schema.BooleanFromBit,
  models: Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String))),
  createdBy: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type BatchRow = typeof BatchRow.Type;

export const SubmissionResult = Submission.mapFields(({ promptId, kind, canonical, tier, score, clockMs }) => ({
  promptId,
  kind,
  canonical,
  tier,
  score,
  clockMs,
}));
export type SubmissionResult = typeof SubmissionResult.Type;

export const LeaderboardEntry = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  modelId: Schema.String,
  day: Schema.String,
  round: Schema.Number,
  score: Schema.Number,
  rank: Schema.Number,
  /** One per prompt in game order: the tier emoji, or ⬛ for a miss. */
  emojis: Schema.Array(Schema.String),
  /** One per prompt in game order, matching `emojis`. */
  answers: Schema.Array(
    Schema.Struct({
      prompt: Schema.String,
      outcome: Schema.String,
      answer: Schema.NullOr(Schema.String),
      score: Schema.Number,
      attempts: Schema.Number,
    }),
  ),
});
export type LeaderboardEntry = typeof LeaderboardEntry.Type;

/** A model's run on a day that is still being played: finished prompts so far, the rest pending. */
export const LiveEntry = Schema.Struct({
  ...LeaderboardEntry.fields,
  status: RunStatus,
  /** Prompts with a result so far (accepted or missed), out of 7. */
  done: Schema.Number,
});
export type LiveEntry = typeof LiveEntry.Type;

export const LiveDay = Schema.Struct({
  day: Schema.String,
  round: Schema.Number,
  /** True once every run has finished and the day is ranked. */
  complete: Schema.Boolean,
  results: Schema.Array(LiveEntry),
});
export type LiveDay = typeof LiveDay.Type;

const ScoreRow = Schema.Struct({
  day: Schema.String,
  modelId: Schema.String,
  runId: Schema.String,
  totalScore: Schema.Number,
  rank: Schema.Number,
  dayNumber: Schema.Number,
  label: Schema.String,
});
const ResultRow = Schema.Struct({
  runId: Schema.String,
  tier: Schema.NullOr(Schema.String),
  outcome: Schema.String,
  text: Schema.String,
  answer: Schema.NullOr(Schema.String),
  score: Schema.Number,
  attempts: Schema.Number,
});

const LiveGameRow = Schema.Struct({ dayNumber: Schema.Number, status: Schema.String });
const PromptRow = Schema.Struct({ promptId: Schema.String, text: Schema.String });
const RunResultRow = Schema.Struct({
  runId: Schema.String,
  promptId: Schema.String,
  outcome: Schema.String,
  tier: Schema.NullOr(Schema.String),
  answer: Schema.NullOr(Schema.String),
  score: Schema.Number,
  attempts: Schema.Number,
});
const RunSubmissionRow = Schema.Struct({ runId: Schema.String, ...SubmissionResult.fields });
const RunKeyRow = Schema.Struct({ runId: Schema.String, modelId: Schema.String, attempt: Schema.Number });

/** Krillion's own share emojis (from the game bundle's TIERS / MISS_EMOJI). */
const TIER_EMOJI: Readonly<Record<string, string>> = {
  plankton: "🫧",
  tooclever: "🤡",
  schooler: "🐟",
  rare: "🦑",
  deepcut: "🏮",
  krillion: "🌟",
};
const MISS_EMOJI = "⬛";

/**
 * The counted run per model for a real day: the latest attempt that isn't an infra
 * error; if every attempt was (e.g. rate limited twice), the one that scored most.
 */
const countedRuns = (runs: ReadonlyArray<RunRow>): Array<RunRow> => {
  const counted = new Map<string, RunRow>();
  for (const r of runs) {
    if (r.trial || !isTerminal(r.status)) continue;
    const prev = counted.get(r.modelId);
    const better =
      prev === undefined ||
      (prev.status === "infra_error"
        ? r.status !== "infra_error" || (r.totalScore ?? 0) > (prev.totalScore ?? 0)
        : r.status !== "infra_error" && r.attempt > prev.attempt);
    if (better) counted.set(r.modelId, r);
  }
  return [...counted.values()];
};

/**
 * The run shown per model while a day is live: the latest attempt still going, else the
 * one that counts (see `countedRuns`).
 */
const liveRuns = (runs: ReadonlyArray<RunRow>): Array<RunRow> => {
  const counted = new Map(countedRuns(runs).map((r) => [r.modelId, r]));
  for (const r of runs) {
    if (r.trial || isTerminal(r.status)) continue;
    const prev = counted.get(r.modelId);
    if (prev === undefined || isTerminal(prev.status) || r.attempt > prev.attempt) counted.set(r.modelId, r);
  }
  return [...counted.values()];
};

const tierEmoji = (outcome: string, tier: string | null) =>
  outcome === "accepted" && tier !== null ? (TIER_EMOJI[tier] ?? MISS_EMOJI) : MISS_EMOJI;

/** Pending prompts have no emoji yet. */
const PENDING_EMOJI = "";

const byScoreDesc = Order.flip(Order.mapInput(Order.Number, (r: RunRow) => r.totalScore ?? 0));

/**
 * D1. Every statement hits a primary key or an index from migrations/ (D1 bills per
 * row read); multi-statement writes go in one atomic `batch`.
 */
export class Database extends Context.Service<Database>()("krillion/Database", {
  make: Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const now = Effect.map(DateTime.now, DateTime.formatIso);
    /** Malformed rows are a bug, not a recoverable error. */
    const decodeRows =
      <S extends Schema.Codec<any, any>>(schema: S) =>
      (r: unknown): Effect.Effect<ReadonlyArray<S["Type"]>> =>
        Effect.orDie(Schema.decodeUnknownEffect(Schema.Array(schema))(r));
    const rows =
      <S extends Schema.Codec<any, any>>(schema: S) =>
      <E>(query: Effect.Effect<ReadonlyArray<unknown>, E>): Effect.Effect<ReadonlyArray<S["Type"]>, E> =>
        Effect.flatMap(query, decodeRows(schema));

    /** Only moves a run that isn't terminal yet, so a late finalize can't overwrite a deadline. */
    const markRunStatusStatement = (runId: string, status: TerminalStatus, error: string | null, at: string) =>
      sql`UPDATE runs SET status = ${status}, error = ${error}, finished_at = COALESCE(finished_at, ${at})
        WHERE run_id = ${runId} AND status IN ('queued', 'running')`;

    // Uses the UNIQUE (batch, model_id, attempt) index.
    const runsOfBatchStatement = (batch: string) =>
      sql`SELECT run_id, batch, day, model_id, attempt, trial, status, model_config, total_score, created_at
        FROM runs WHERE batch = ${batch}`;
    const runsOfBatch = (batch: string) =>
      runsOfBatchStatement(batch).pipe(rows(RunRow), Effect.withSpan("Database.runsOfBatch"));

    return {
      runsOfBatch,

      upsertGame: Effect.fn("Database.upsertGame")(function* (g: TodayGame) {
        const at = yield* now;
        yield* sql.batch([
          sql`INSERT INTO games (day, day_number, resets_at, fetched_at, raw_json)
            VALUES (${g.date}, ${g.dayNumber}, ${g.resetsAt}, ${at}, ${JSON.stringify(g)})
            ON CONFLICT (day) DO NOTHING`,
          ...g.prompts.map(
            (p, i) => sql`INSERT INTO prompts (day, prompt_id, position, text)
              VALUES (${g.date}, ${p.id}, ${i + 1}, ${p.text}) ON CONFLICT (day, prompt_id) DO NOTHING`,
          ),
        ]);
      }),

      /**
       * Insert `queued` runs (and upsert their models) in one batch. Idempotent per (batch,
       * model, attempt): returns each run with its id, the existing one when its row was
       * already there, so concurrent or repeated launches agree on one id per agent.
       */
      insertRuns: Effect.fn("Database.insertRuns")(function* (
        b: { readonly batch: string; readonly day: Day; readonly trial: boolean; readonly promptVersion: string },
        runs: ReadonlyArray<{ readonly model: ModelEntry; readonly attempt: number }>,
      ) {
        if (runs.length === 0) return [];
        const at = yield* now;
        const models = new Map(runs.map(({ model }) => [model.id, model]));
        const results = yield* sql.batch([
          ...Array.from(
            models.values(),
            (m) => sql`INSERT INTO models (model_id, label, first_seen, last_config)
              VALUES (${m.id}, ${m.label}, ${at}, ${JSON.stringify(m)})
              ON CONFLICT (model_id) DO UPDATE SET label = excluded.label, last_config = excluded.last_config`,
          ),
          ...runs.map(
            ({ model, attempt }) => sql`INSERT INTO runs
                (run_id, batch, day, model_id, attempt, trial, status, prompt_version, model_config, created_at)
              VALUES (${crypto.randomUUID()}, ${b.batch}, ${b.day}, ${model.id}, ${attempt}, ${b.trial ? 1 : 0}, 'queued',
                ${b.promptVersion}, ${JSON.stringify(model)}, ${at})
              ON CONFLICT (batch, model_id, attempt) DO NOTHING`,
          ),
          sql`SELECT run_id, model_id, attempt FROM runs WHERE batch = ${b.batch}`,
        ]);
        const key = (modelId: string, attempt: number) => `${modelId}|${attempt}`;
        const ids = new Map((yield* decodeRows(RunKeyRow)(results.at(-1))).map((r) => [key(r.modelId, r.attempt), r.runId]));
        const inserted: Array<{ readonly model: ModelEntry; readonly attempt: number; readonly runId: string }> = [];
        for (const run of runs) {
          const runId = ids.get(key(run.model.id, run.attempt));
          if (runId === undefined) return yield* Effect.die(`run row missing after insert: ${key(run.model.id, run.attempt)}`);
          inserted.push({ ...run, runId });
        }
        return inserted;
      }),

      markRunning: Effect.fn("Database.markRunning")(function* (runId: string, browserSessionId: string) {
        yield* sql`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ${yield* now}),
          browser_session_id = ${browserSessionId} WHERE run_id = ${runId} AND status IN ('queued', 'running')`;
      }),

      markRunStatus: Effect.fn("Database.markRunStatus")(function* (runId: string, status: TerminalStatus, error: string | null) {
        yield* markRunStatusStatement(runId, status, error, yield* now);
      }),

      insertSubmission: (s: Submission) =>
        sql`INSERT INTO submissions (run_id, seq, day, prompt_id, submitted_at, raw_answer, kind, canonical,
            correction, tier, score, http_status, latency_ms, clock_ms)
          VALUES (${s.runId}, ${s.seq}, ${s.day}, ${s.promptId}, ${s.submittedAt}, ${s.rawAnswer}, ${s.kind},
            ${s.canonical}, ${s.correction}, ${s.tier}, ${s.score}, ${s.httpStatus}, ${s.latencyMs}, ${s.clockMs})
          ON CONFLICT (run_id, seq) DO NOTHING`.pipe(Effect.asVoid, Effect.withSpan("Database.insertSubmission")),

      // PK prefix scan on submissions(run_id, seq).
      submissionsOfRun: (runId: string) =>
        sql`SELECT prompt_id, kind, canonical, tier, score, clock_ms FROM submissions
          WHERE run_id = ${runId} ORDER BY seq`.pipe(rows(SubmissionResult), Effect.withSpan("Database.submissionsOfRun")),

      writeRunSummary: Effect.fn("Database.writeRunSummary")(function* (s: RunSummary) {
        yield* sql.batch([
          ...s.results.map(
            (r) => sql`INSERT INTO results (run_id, day, model_id, prompt_id, outcome, answer, tier, score, attempts, ms_to_accept)
              VALUES (${s.runId}, ${s.day}, ${s.modelId}, ${r.promptId}, ${r.outcome}, ${r.answer}, ${r.tier}, ${r.score},
                ${r.attempts}, ${r.msToAccept})
              ON CONFLICT (run_id, prompt_id) DO UPDATE SET outcome = excluded.outcome, answer = excluded.answer,
                tier = excluded.tier, score = excluded.score, attempts = excluded.attempts, ms_to_accept = excluded.ms_to_accept`,
          ),
          sql`UPDATE runs SET total_score = ${s.totalScore}, steps = ${s.steps}, input_tokens = ${s.inputTokens},
              output_tokens = ${s.outputTokens}, cost_usd = ${s.costUsd}, pi_outcome = ${s.piOutcome},
              self_report = ${s.selfReport}
            WHERE run_id = ${s.runId}`,
          markRunStatusStatement(s.runId, s.status, s.error, yield* now),
        ]);
      }),

      /** Rank the counted run per model for a real (non-trial) day; returns how many were ranked. */
      finalizeDay: Effect.fn("Database.finalizeDay")(function* (day: Day) {
        const ranked = Arr.sort(countedRuns(yield* runsOfBatch(day)), byScoreDesc);
        // Ties share a place: rank is 1 + the number of runs that scored strictly more.
        const rankOf = (score: number) => 1 + ranked.filter((r) => (r.totalScore ?? 0) > score).length;
        yield* sql.batch([
          ...ranked.map((r) => {
            const score = r.totalScore ?? 0;
            return sql`INSERT INTO daily_scores (day, model_id, run_id, total_score, rank)
              VALUES (${day}, ${r.modelId}, ${r.runId}, ${score}, ${rankOf(score)})
              ON CONFLICT (day, model_id) DO UPDATE SET run_id = excluded.run_id, total_score = excluded.total_score,
                rank = excluded.rank`;
          }),
          sql`UPDATE games SET status = 'complete' WHERE day = ${day}`,
        ]);
        return ranked.length;
      }),

      /** Idempotent. A batch's day, once known, is filled in: trials learn theirs at dispatch. */
      registerBatch: Effect.fn("Database.registerBatch")(function* (batch: string, c: BatchConfig, day: Day | null) {
        yield* sql`INSERT INTO batches (batch, day, trial, models, created_by, created_at)
          VALUES (${batch}, ${day}, ${c.trial ? 1 : 0}, ${c.models ? JSON.stringify(c.models) : null}, ${c.createdBy},
            ${DateTime.formatIso(DateTime.makeUnsafe(c.createdAt))})
          ON CONFLICT (batch) DO UPDATE SET day = COALESCE(batches.day, excluded.day)`;
      }),

      // Newest first via the batches_created index.
      recentBatches: (limit: number) =>
        sql`SELECT batch, day, trial, models, created_by, created_at FROM batches
          ORDER BY created_at DESC LIMIT ${limit}`.pipe(rows(BatchRow), Effect.withSpan("Database.recentBatches")),

      /**
       * A real day as it is being played, or null before its game is fetched. Finished runs
       * come from `results`; runs still going are scored from the submissions captured so
       * far: a prompt is accepted, missed (a later prompt has submissions), or pending.
       */
      liveDay: Effect.fn("Database.liveDay")(function* (day: Day) {
        // One round trip. Results and submissions join through runs' (batch, …) index into the per-run primary keys.
        const [games, prompts, batchRuns, results, subs] = yield* sql
          .batch([
            sql`SELECT day_number, status FROM games WHERE day = ${day}`,
            sql`SELECT prompt_id, text FROM prompts WHERE day = ${day} ORDER BY position`,
            runsOfBatchStatement(day),
            sql`SELECT r.run_id, r.prompt_id, r.outcome, r.tier, r.answer, r.score, r.attempts
              FROM runs x JOIN results r ON r.run_id = x.run_id WHERE x.batch = ${day}`,
            sql`SELECT s.run_id, s.prompt_id, s.kind, s.canonical, s.tier, s.score, s.clock_ms
              FROM runs x JOIN submissions s ON s.run_id = x.run_id
              WHERE x.batch = ${day} AND x.status IN ('queued', 'running')
              ORDER BY s.run_id, s.seq`,
          ])
          .pipe(
            Effect.flatMap(([g, p, r, res, s]) =>
              Effect.all([
                decodeRows(LiveGameRow)(g),
                decodeRows(PromptRow)(p),
                decodeRows(RunRow)(r),
                decodeRows(RunResultRow)(res),
                decodeRows(RunSubmissionRow)(s),
              ]),
            ),
          );
        const game = games[0];
        if (game === undefined) return null;
        const runs = liveRuns(batchRuns);
        const resultsByRun = Arr.groupBy(results, (r) => r.runId);
        const subsByRun = Arr.groupBy(subs, (s) => s.runId);

        const entries = runs.map((run) => {
          const finished = resultsByRun[run.runId];
          const mine = subsByRun[run.runId] ?? [];
          const answers = prompts.map((p, i) => {
            const result = finished?.find((r) => r.promptId === p.promptId);
            if (result !== undefined) {
              return { ...result, prompt: p.text, emoji: tierEmoji(result.outcome, result.tier) };
            }
            const scored = scorePrompt(p.promptId, mine, false);
            // A finished run without result rows (its summary never got written) missed the rest.
            const settled =
              scored.outcome === "accepted" ||
              isTerminal(run.status) ||
              prompts.slice(i + 1).some((q) => mine.some((s) => s.promptId === q.promptId));
            return {
              prompt: p.text,
              outcome: settled ? scored.outcome : "pending",
              answer: scored.answer,
              score: scored.score,
              attempts: scored.attempts,
              emoji: settled ? tierEmoji(scored.outcome, scored.tier) : PENDING_EMOJI,
            };
          });
          return {
            id: run.runId,
            model: run.modelConfig.label,
            modelId: run.modelId,
            day,
            round: game.dayNumber,
            score: answers.reduce((sum, a) => sum + a.score, 0),
            status: run.status,
            done: answers.filter((a) => a.outcome !== "pending").length,
            emojis: answers.map((a) => a.emoji),
            answers: answers.map(({ prompt, outcome, answer, score, attempts }) => ({ prompt, outcome, answer, score, attempts })),
          };
        });
        // Ties share a place, as in `finalizeDay`.
        const ranked = entries.map((e): LiveEntry => ({
          ...e,
          rank: 1 + entries.filter((o) => o.score > e.score).length,
        }));
        return { day, round: game.dayNumber, complete: game.status === "complete", results: ranked } satisfies LiveDay;
      }),

      /** Ranked results for real days since `since`: `daily_scores` by PK range, then each counted run's `results`. */
      leaderboard: Effect.fn("Database.leaderboard")(function* (since: Day) {
        // One round trip. Results join through daily_scores rather than an IN list: D1 caps bound parameters at 100.
        const [scores, results] = yield* sql
          .batch([
            sql`SELECT ds.day, ds.model_id, ds.run_id, ds.total_score, ds.rank, g.day_number, m.label
              FROM daily_scores ds
              JOIN games g ON g.day = ds.day
              JOIN models m ON m.model_id = ds.model_id
              WHERE ds.day >= ${since}`,
            sql`SELECT r.run_id, r.tier, r.outcome, p.text, r.answer, r.score, r.attempts
              FROM daily_scores ds
              JOIN results r ON r.run_id = ds.run_id
              JOIN prompts p ON p.day = r.day AND p.prompt_id = r.prompt_id
              WHERE ds.day >= ${since}
              ORDER BY r.run_id, p.position`,
          ])
          .pipe(Effect.flatMap(([s, r]) => Effect.all([decodeRows(ScoreRow)(s), decodeRows(ResultRow)(r)])));
        const byRun = Arr.groupBy(results, (r) => r.runId);
        return scores.map((r): LeaderboardEntry => {
          const prompts = byRun[r.runId] ?? [];
          return {
            id: r.runId,
            model: r.label,
            modelId: r.modelId,
            day: r.day,
            round: r.dayNumber,
            score: r.totalScore,
            rank: r.rank,
            emojis: prompts.map((x) => tierEmoji(x.outcome, x.tier)),
            answers: prompts.map((x) => ({
              prompt: x.text,
              outcome: x.outcome,
              answer: x.answer,
              score: x.score,
              attempts: x.attempts,
            })),
          };
        });
      }),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.unwrap(WorkerEnv.useSync((env) => D1Client.layer({ db: env.DB, transformResultNames: Str.snakeToCamel })))),
    Layer.orDie,
  );
}
