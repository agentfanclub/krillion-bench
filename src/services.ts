import { D1Client } from "@effect/sql-d1";
import { Data, Effect, Layer, ManagedRuntime, Schedule, Schema } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  ModelsDoc,
  type ModelEntry,
  type RunStatus,
  TodayGame,
  type TodayGame as TodayGameT,
} from "./domain";

export class KrillionError extends Data.TaggedError("KrillionError")<{ readonly message: string }> {}
export class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

// ── Krillion (orchestrator only; the agent only ever sees the UI) ────────────

export const KRILLION_ORIGIN = "https://krillion.io";

export const fetchToday: Effect.Effect<TodayGameT, KrillionError> = Effect.tryPromise({
  try: async () => {
    const res = await fetch(`${KRILLION_ORIGIN}/api/today`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`GET /api/today → ${res.status}`);
    return (await res.json()) as unknown;
  },
  catch: (e) => new KrillionError({ message: String(e) }),
}).pipe(
  Effect.flatMap((json) =>
    Schema.decodeUnknownEffect(TodayGame)(json).pipe(
      Effect.mapError((e) => new KrillionError({ message: `unexpected /api/today shape: ${e.message}` })),
    ),
  ),
  Effect.retry(Schedule.exponential("1 second").pipe(Schedule.upTo({ times: 4 }))),
);

/** Today's game, insisting the site has rolled over to `day` (ET). */
export const fetchGameFor = (day: string) =>
  fetchToday.pipe(
    Effect.flatMap((g) =>
      g.date === day
        ? Effect.succeed(g)
        : Effect.fail(new KrillionError({ message: `site still on ${g.date}, want ${day}` })),
    ),
  );

// ── Roster (KV) ──────────────────────────────────────────────────────────────

export const ROSTER_KEY = "models";

export const loadRoster = (kv: KVNamespace): Effect.Effect<ReadonlyArray<ModelEntry>, ConfigError> =>
  Effect.tryPromise({
    try: () => kv.get(ROSTER_KEY, "json"),
    catch: (e) => new ConfigError({ message: `KV read failed: ${String(e)}` }),
  }).pipe(
    Effect.flatMap((json) =>
      json === null
        ? Effect.fail(new ConfigError({ message: `KV key '${ROSTER_KEY}' is missing` }))
        : Schema.decodeUnknownEffect(ModelsDoc)(json).pipe(
            Effect.mapError((e) => new ConfigError({ message: `invalid roster: ${e.message}` })),
          ),
    ),
    Effect.map((doc) => doc.models.filter((m) => m.enabled)),
  );

// ── D1 repos ─────────────────────────────────────────────────────────────────
// Every statement below hits a primary key or an index from migrations/0001_init.sql.

const now = () => new Date().toISOString();

export const upsertGame = (g: TodayGameT) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO games (day, day_number, resets_at, fetched_at, raw_json)
      VALUES (${g.date}, ${g.dayNumber}, ${g.resetsAt}, ${now()}, ${JSON.stringify(g)})
      ON CONFLICT (day) DO NOTHING`;
    for (const [i, p] of g.prompts.entries()) {
      yield* sql`INSERT INTO prompts (day, prompt_id, position, text)
        VALUES (${g.date}, ${p.id}, ${i + 1}, ${p.text})
        ON CONFLICT (day, prompt_id) DO NOTHING`;
    }
  });

export const upsertModel = (m: ModelEntry) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO models (model_id, label, first_seen, last_config)
      VALUES (${m.id}, ${m.label}, ${now()}, ${JSON.stringify(m)})
      ON CONFLICT (model_id) DO UPDATE SET label = excluded.label, last_config = excluded.last_config`;
  });

export interface NewRun {
  readonly runId: string;
  readonly batch: string;
  readonly day: string;
  readonly model: ModelEntry;
  readonly attempt: number;
  readonly trial: boolean;
  readonly promptVersion: string;
}

/** Returns false when (batch, model, attempt) already exists: dispatch is idempotent. */
export const insertRun = (r: NewRun) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ run_id: string }>`INSERT INTO runs
        (run_id, batch, day, model_id, attempt, trial, status, prompt_version, model_config, created_at)
      VALUES (${r.runId}, ${r.batch}, ${r.day}, ${r.model.id}, ${r.attempt}, ${r.trial ? 1 : 0}, 'queued',
        ${r.promptVersion}, ${JSON.stringify(r.model)}, ${now()})
      ON CONFLICT (batch, model_id, attempt) DO NOTHING
      RETURNING run_id`;
    return rows.length > 0;
  });

export interface RunRow {
  readonly run_id: string;
  readonly batch: string;
  readonly day: string;
  readonly model_id: string;
  readonly attempt: number;
  readonly trial: number;
  readonly status: RunStatus;
  readonly model_config: string;
  readonly total_score: number | null;
  readonly created_at: string;
}

/** Uses the UNIQUE (batch, model_id, attempt) index. */
export const runsOfBatch = (batch: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<RunRow>`SELECT run_id, batch, day, model_id, attempt, trial, status, model_config,
        total_score, created_at
      FROM runs WHERE batch = ${batch}`;
  });

export const markRunning = (runId: string, browserSessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE runs SET status = 'running', started_at = COALESCE(started_at, ${now()}),
      browser_session_id = ${browserSessionId} WHERE run_id = ${runId} AND status IN ('queued', 'running')`;
  });

/** Only moves a run that isn't terminal yet, so a late finalize can't overwrite a deadline. */
export const markRunStatus = (runId: string, status: RunStatus, error?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE runs SET status = ${status}, error = ${error ?? null},
      finished_at = COALESCE(finished_at, ${now()})
      WHERE run_id = ${runId} AND status IN ('queued', 'running')`;
  });

export interface SubmissionRow {
  readonly runId: string;
  readonly seq: number;
  readonly day: string;
  readonly promptId: string;
  readonly submittedAt: string;
  readonly rawAnswer: string;
  readonly kind: "accepted" | "rejected" | "correction" | "error";
  readonly canonical: string | null;
  readonly correction: string | null;
  readonly tier: string | null;
  readonly score: number | null;
  readonly httpStatus: number;
  readonly latencyMs: number;
  readonly clockMs: number | null;
}

export const insertSubmission = (s: SubmissionRow) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO submissions (run_id, seq, day, prompt_id, submitted_at, raw_answer, kind, canonical,
        correction, tier, score, http_status, latency_ms, clock_ms)
      VALUES (${s.runId}, ${s.seq}, ${s.day}, ${s.promptId}, ${s.submittedAt}, ${s.rawAnswer}, ${s.kind},
        ${s.canonical}, ${s.correction}, ${s.tier}, ${s.score}, ${s.httpStatus}, ${s.latencyMs}, ${s.clockMs})
      ON CONFLICT (run_id, seq) DO NOTHING`;
  });

/** PK prefix scan on submissions(run_id, seq). */
export const submissionsOfRun = (runId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<{
      seq: number;
      prompt_id: string;
      kind: string;
      canonical: string | null;
      tier: string | null;
      score: number | null;
      clock_ms: number | null;
    }>`SELECT seq, prompt_id, kind, canonical, tier, score, clock_ms FROM submissions
      WHERE run_id = ${runId} ORDER BY seq`;
  });

export interface ResultRow {
  readonly promptId: string;
  readonly outcome: "accepted" | "timed_out" | "not_reached";
  readonly answer: string | null;
  readonly tier: string | null;
  readonly score: number;
  readonly attempts: number;
  readonly msToAccept: number | null;
}

export interface RunSummary {
  readonly runId: string;
  readonly day: string;
  readonly modelId: string;
  readonly status: RunStatus;
  readonly error: string | null;
  readonly totalScore: number;
  readonly steps: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
  readonly piOutcome: string;
  readonly selfReport: string | null;
  readonly results: ReadonlyArray<ResultRow>;
}

export const writeRunSummary = (s: RunSummary) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    for (const r of s.results) {
      yield* sql`INSERT INTO results (run_id, day, model_id, prompt_id, outcome, answer, tier, score, attempts, ms_to_accept)
        VALUES (${s.runId}, ${s.day}, ${s.modelId}, ${r.promptId}, ${r.outcome}, ${r.answer}, ${r.tier}, ${r.score},
          ${r.attempts}, ${r.msToAccept})
        ON CONFLICT (run_id, prompt_id) DO UPDATE SET outcome = excluded.outcome, answer = excluded.answer,
          tier = excluded.tier, score = excluded.score, attempts = excluded.attempts, ms_to_accept = excluded.ms_to_accept`;
    }
    yield* sql`UPDATE runs SET total_score = ${s.totalScore}, steps = ${s.steps}, input_tokens = ${s.inputTokens},
        output_tokens = ${s.outputTokens}, cost_usd = ${s.costUsd}, pi_outcome = ${s.piOutcome},
        self_report = ${s.selfReport}
      WHERE run_id = ${s.runId}`;
    yield* markRunStatus(s.runId, s.status, s.error ?? undefined);
  });

/** Rank the counted run per model for a real (non-trial) day. */
export const finalizeDay = (day: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const runs = yield* runsOfBatch(day);
    // Counted run per model: the latest attempt that isn't an infra error; if every
    // attempt was, the latest one (score 0). Every rostered model gets a row.
    const counted = new Map<string, RunRow>();
    for (const r of runs) {
      if (r.trial === 1 || r.status === "queued" || r.status === "running") continue;
      const prev = counted.get(r.model_id);
      const prevInfra = prev?.status === "infra_error";
      const infra = r.status === "infra_error";
      if (!prev || (prevInfra && !infra) || (prevInfra === infra && r.attempt > prev.attempt)) {
        counted.set(r.model_id, r);
      }
    }
    const ranked = [...counted.values()].sort((a, b) => (b.total_score ?? 0) - (a.total_score ?? 0));
    let rank = 0;
    let lastScore = Number.NaN;
    for (const [i, r] of ranked.entries()) {
      const score = r.total_score ?? 0;
      if (score !== lastScore) rank = i + 1;
      lastScore = score;
      yield* sql`INSERT INTO daily_scores (day, model_id, run_id, total_score, rank)
        VALUES (${day}, ${r.model_id}, ${r.run_id}, ${score}, ${rank})
        ON CONFLICT (day, model_id) DO UPDATE SET run_id = excluded.run_id, total_score = excluded.total_score,
          rank = excluded.rank`;
    }
    yield* sql`UPDATE games SET status = 'complete' WHERE day = ${day}`;
    return ranked.length;
  });

// ── Batches (admin portal) ───────────────────────────────────────────────────

export interface BatchRow {
  readonly batch: string;
  readonly day: string | null;
  readonly trial: number;
  readonly models: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

export const registerBatch = (b: {
  batch: string;
  day: string | null;
  trial: boolean;
  models: ReadonlyArray<string> | null;
  createdBy: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`INSERT INTO batches (batch, day, trial, models, created_by, created_at)
      VALUES (${b.batch}, ${b.day}, ${b.trial ? 1 : 0}, ${b.models ? JSON.stringify(b.models) : null}, ${b.createdBy}, ${now()})
      ON CONFLICT (batch) DO NOTHING`;
  });

export const setBatchDay = (batch: string, day: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    yield* sql`UPDATE batches SET day = ${day} WHERE batch = ${batch} AND day IS NULL`;
  });

/** Newest first via the batches_created index. */
export const recentBatches = (limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql<BatchRow>`SELECT batch, day, trial, models, created_by, created_at FROM batches
      ORDER BY created_at DESC LIMIT ${limit}`;
  });

// ── Leaderboard (frontend) ───────────────────────────────────────────────────

/** Krillion's own share emojis (from the game bundle's TIERS / MISS_EMOJI). */
export const TIER_EMOJI: Record<string, string> = {
  plankton: "🫧",
  tooclever: "🤡",
  schooler: "🐟",
  rare: "🦑",
  deepcut: "🏮",
  krillion: "🌟",
};
export const MISS_EMOJI = "⬛";

export interface LeaderboardEntry {
  readonly id: string;
  readonly model: string;
  readonly modelId: string;
  readonly day: string;
  readonly round: number;
  readonly score: number;
  readonly rank: number;
  /** One per prompt in game order: the tier emoji, or ⬛ for a miss. */
  readonly emojis: ReadonlyArray<string>;
}

/**
 * Ranked results for the last `days` real days. Reads `daily_scores` by its
 * `(day, model_id)` PK range, then each counted run's 7 `results` rows by PK.
 */
export const leaderboard = (sinceDay: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{
      day: string;
      model_id: string;
      run_id: string;
      total_score: number;
      rank: number;
      day_number: number;
      label: string;
    }>`SELECT ds.day, ds.model_id, ds.run_id, ds.total_score, ds.rank, g.day_number, m.label
      FROM daily_scores ds
      JOIN games g ON g.day = ds.day
      JOIN models m ON m.model_id = ds.model_id
      WHERE ds.day >= ${sinceDay}`;
    if (rows.length === 0) return [];
    const results = yield* sql<{ run_id: string; prompt_id: string; tier: string | null; outcome: string }>`
      SELECT r.run_id, r.prompt_id, r.tier, r.outcome
      FROM results r
      JOIN prompts p ON p.day = r.day AND p.prompt_id = r.prompt_id
      WHERE r.run_id IN ${sql.in(rows.map((r) => r.run_id))}
      ORDER BY r.run_id, p.position`;
    const emojis = new Map<string, string[]>();
    for (const r of results) {
      const slot = r.outcome === "accepted" && r.tier ? (TIER_EMOJI[r.tier] ?? MISS_EMOJI) : MISS_EMOJI;
      const list = emojis.get(r.run_id);
      if (list) list.push(slot);
      else emojis.set(r.run_id, [slot]);
    }
    return rows.map(
      (r): LeaderboardEntry => ({
        id: r.run_id,
        model: r.label,
        modelId: r.model_id,
        day: r.day,
        round: r.day_number,
        score: r.total_score,
        rank: r.rank,
        emojis: emojis.get(r.run_id) ?? [],
      }),
    );
  });

// ── Runtime ──────────────────────────────────────────────────────────────────

export type AppRuntime = ManagedRuntime.ManagedRuntime<SqlClient | D1Client.D1Client, never>;

export const makeRuntime = (env: Env): AppRuntime => ManagedRuntime.make(Layer.orDie(D1Client.layer({ db: env.DB })));
