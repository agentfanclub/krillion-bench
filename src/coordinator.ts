import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Clock, Context, type Data, Effect, Match, Option, Result, Schema, Semaphore } from "effect";
import { PROMPT_VERSION } from "./agent/prompt";
import { durableObjectRunner } from "./App";
import { JobQueue, stored } from "./Cloudflare";
import { Database } from "./Database";
import { BatchConfig, type BatchRequest, isTerminal, type ModelEntry, TodayGame } from "./domain";
import { Krillion } from "./Krillion";
import { logRecovered } from "./Logging";
import { BatchPhase, type BatchStatus, diveName, Objects, type Rerun, type StartResult } from "./Objects";
import { Roster } from "./Roster";

/** How long dispatch keeps retrying (the site rolls over late, D1 or KV hiccups) before giving up. */
const DISPATCH_GRACE_MS = 20 * 60_000;
/** A failed job runs again this much later. */
const RETRY_MS = 60_000;
/** After dispatch, runs still going are stopped. A dive takes ~4 min; runs are staggered. */
const DEADLINE_MS = 40 * 60_000;
/** After stopping stragglers, give them this long to report before forcing them closed. */
const FORCE_CLOSE_MS = 5 * 60_000;
/** Browser Run allows 3 new browsers per second. */
const STAGGER = "400 millis";

const Job = Schema.Union([
  Schema.Struct({ fn: Schema.Literal("dispatch") }),
  Schema.Struct({ fn: Schema.Literal("deadline") }),
  Schema.Struct({ fn: Schema.Literal("force-close") }),
]);
type Job = typeof Job.Type;

/** The batch's durable state (same keys as every earlier version). */
const batchKeys = (kv: SyncKvStorage) => ({
  config: stored(kv, "batch:config", BatchConfig),
  game: stored(kv, "batch:game", TodayGame),
  phase: stored(kv, "batch:phase", BatchPhase),
});

/** This coordinator's batch: its name, durable state, and job queue. */
class Batch extends Context.Service<
  Batch,
  ReturnType<typeof batchKeys> & { readonly name: string; readonly jobs: JobQueue<Job> }
>()("krillion/Batch") {}

/**
 * Decoded from the stored keys. No config: New. No phase: Pending (the game is stored once
 * fetched, so a retried dispatch reuses it). "dispatched": Dispatched. "finalized", or
 * "failed" after the game was stored: Closed (a real day can be rerun). "failed" without
 * a game: Abandoned. The game is always stored before the phase becomes "dispatched".
 */
type BatchState = Data.TaggedEnum<{
  New: {};
  Pending: { readonly config: BatchConfig; readonly game: Option.Option<TodayGame> };
  Dispatched: { readonly config: BatchConfig; readonly game: TodayGame };
  Closed: { readonly config: BatchConfig; readonly game: TodayGame };
  Abandoned: { readonly config: BatchConfig };
}>;

/** What a batch that has its game runs on. */
type Played = { readonly config: BatchConfig; readonly game: TodayGame };

const batchState = Batch.useSync(({ config, game, phase }): BatchState => {
  const c = config.getUnsafe();
  if (Option.isNone(c)) return { _tag: "New" };
  const g = game.getUnsafe();
  const p = phase.getUnsafe();
  if (Option.isNone(p)) return { _tag: "Pending", config: c.value, game: g };
  if (Option.isNone(g)) return { _tag: "Abandoned", config: c.value };
  return { _tag: p.value === "dispatched" ? "Dispatched" : "Closed", config: c.value, game: g.value };
});

/**
 * Insert the runs' rows (one D1 batch), then start their agents one after another: Browser
 * Run limits how fast browsers start. Idempotent: a (model, attempt) keeps the run id of
 * its first insert, and an agent ignores a second start.
 */
const launch = Effect.fn("Batch.launch")(function* (
  { config, game }: Played,
  runs: ReadonlyArray<{ readonly model: ModelEntry; readonly attempt: number }>,
) {
  const batch = yield* Batch;
  const db = yield* Database;
  const objects = yield* Objects;
  const inserted = yield* db.insertRuns(
    { batch: batch.name, day: game.date, trial: config.trial, promptVersion: PROMPT_VERSION },
    runs,
  );
  yield* Effect.forEach(
    inserted,
    ({ model, attempt, runId }, i) => {
      const start = objects
        .dive(diveName(batch.name, model.id, attempt))
        .start({ runId, batch: batch.name, day: game.date, attempt, trial: config.trial, model, prompts: game.prompts })
        .pipe(
          Effect.catchTag("RpcError", (e) =>
            logRecovered("dive agent start failed")(e).pipe(
              Effect.andThen(db.markRunStatus(runId, "infra_error", `agent start failed: ${e.message}`)),
            ),
          ),
          Effect.annotateLogs({ runId, modelId: model.id, attempt }),
        );
      return i === 0 ? start : Effect.andThen(Effect.sleep(STAGGER), start);
    },
    { discard: true },
  );
});

/** (Re)open the batch: dispatched, with a fresh deadline that replaces any earlier one. */
const open = Effect.gen(function* () {
  const { phase, jobs } = yield* Batch;
  yield* phase.set("dispatched");
  yield* jobs.cancel("force-close");
  yield* jobs.push({ fn: "deadline" }, DEADLINE_MS);
});

/** Rank the day, then close. Until the phase is set, the deadline jobs still pending retry a failed ranking. */
const finalize = Effect.fn("Batch.finalize")(function* ({ config, game }: Played) {
  const batch = yield* Batch;
  if (!config.trial) yield* (yield* Database).finalizeDay(game.date);
  yield* batch.phase.set("finalized");
  yield* batch.jobs.cancel("deadline");
  yield* batch.jobs.cancel("force-close");
});

/** Retry every first-attempt infra failure once; finalize when every run is terminal. */
const reconcile = Effect.gen(function* () {
  const state = yield* batchState;
  if (state._tag !== "Dispatched") return;
  const { name } = yield* Batch;
  const db = yield* Database;
  let runs = yield* db.runsOfBatch(name);
  const retriedModels = new Set(runs.filter((r) => r.attempt === 2).map((r) => r.modelId));
  const retries = runs.filter((r) => r.status === "infra_error" && r.attempt === 1 && !retriedModels.has(r.modelId));
  if (retries.length > 0) {
    yield* Effect.forEach(
      retries,
      (r) => Effect.logWarning("retrying run after infra error").pipe(Effect.annotateLogs({ runId: r.runId, modelId: r.modelId })),
      { discard: true },
    );
    yield* launch(state, retries.map((r) => ({ model: r.modelConfig, attempt: 2 })));
    runs = yield* db.runsOfBatch(name); // a retry whose agent didn't start is already terminal
  }
  if (runs.every((r) => isTerminal(r.status))) yield* finalize(state);
}).pipe(Effect.withSpan("Batch.reconcile"));

/** Idempotent: the cron's two daily firings, retries, and manual calls all land here. */
const start = Effect.fn("Batch.start")(function* (request: BatchRequest) {
  const batch = yield* Batch;
  if ((yield* batchState)._tag !== "New") return { batch: batch.name, accepted: false };
  const config: BatchConfig = { ...request, createdAt: yield* Clock.currentTimeMillis };
  yield* batch.config.set(config);
  yield* batch.jobs.push({ fn: "dispatch" });
  // Listed at once for the admin page; dispatch registers it again with its day.
  yield* (yield* Database)
    .registerBatch(batch.name, config, config.day)
    .pipe(Effect.catchTag("SqlError", logRecovered("batch registration failed")));
  return { batch: batch.name, accepted: true };
});

const status = Effect.gen(function* () {
  const batch = yield* Batch;
  return {
    batch: batch.name,
    phase: Option.getOrNull(yield* batch.phase.get),
    config: Option.getOrNull(yield* batch.config.get),
    runs: yield* (yield* Database).runsOfBatch(batch.name),
  };
}).pipe(Effect.withSpan("Batch.status"));

/**
 * Play a real day again for some models (e.g. after a config fix), with their current
 * roster entry, as a new attempt each. The day reopens if it was finalized (or failed)
 * and gets a fresh deadline, so the new runs aren't stopped by the old one; it is
 * re-ranked when they finish, and the counting rule picks the new attempt unless it
 * is an infra error. Null unless this batch is a real day that has its game.
 */
const rerun = Effect.fn("Batch.rerun")(function* (modelIds: ReadonlyArray<string>) {
  const batch = yield* Batch;
  const state = yield* batchState;
  if ((state._tag !== "Dispatched" && state._tag !== "Closed") || state.config.trial) return null;

  const models = (yield* (yield* Roster).enabled).filter((m) => modelIds.includes(m.id));
  const skipped = modelIds.filter((id) => !models.some((m) => m.id === id));
  if (skipped.length > 0) {
    yield* Effect.logWarning("rerun skipped models not enabled in the roster").pipe(Effect.annotateLogs({ skipped }));
  }
  if (models.length > 0) {
    const lastAttempt = new Map<string, number>();
    for (const r of yield* (yield* Database).runsOfBatch(batch.name)) {
      lastAttempt.set(r.modelId, Math.max(r.attempt, lastAttempt.get(r.modelId) ?? 0));
    }
    const runs = models.map((model) => ({ model, attempt: (lastAttempt.get(model.id) ?? 0) + 1 }));
    yield* Effect.forEach(
      runs,
      ({ model, attempt }) =>
        Effect.logInfo("rerunning model for day").pipe(Effect.annotateLogs({ modelId: model.id, attempt })),
      { discard: true },
    );
    yield* open;
    yield* launch(state, runs);
    yield* reconcile; // finalizes at once if no agent started
  }
  return { batch: batch.name, launched: models.map((m) => m.id), skipped };
});

/** The day's game: fetched once (waiting for the site's rollover), recorded in D1, then stored. */
const fetchGame = Effect.fn("Batch.fetchGame")(function* (config: BatchConfig) {
  const batch = yield* Batch;
  const db = yield* Database;
  const krillion = yield* Krillion;
  const game = yield* (config.day ? krillion.gameFor(config.day) : krillion.today);
  yield* Effect.all([db.upsertGame(game), db.registerBatch(batch.name, config, game.date)], {
    concurrency: 2,
    discard: true,
  });
  yield* batch.game.set(game);
  return game;
});

/**
 * Fetch the game, launch every rostered model, open the batch. A failure retries a minute
 * later (every step is idempotent) until the grace period ends, then fails the batch.
 */
const dispatch = Effect.gen(function* () {
  const state = yield* batchState;
  if (state._tag !== "Pending") return undefined;
  const { config } = state;
  const played = yield* Effect.gen(function* () {
    const game = Option.isSome(state.game) ? state.game.value : yield* fetchGame(config);
    const roster = yield* (yield* Roster).enabled;
    const only = config.models;
    const models = only ? roster.filter((m) => only.includes(m.id)) : roster;
    yield* launch({ config, game }, models.map((model) => ({ model, attempt: 1 })));
  }).pipe(Effect.result);
  if (Result.isFailure(played)) {
    const now = yield* Clock.currentTimeMillis;
    const fields = { day: config.day, errorMessage: played.failure.message };
    if (now - config.createdAt < DISPATCH_GRACE_MS) {
      yield* Effect.logWarning("dispatch failed, retrying").pipe(Effect.annotateLogs(fields));
      return { rescheduleAt: now + RETRY_MS };
    }
    yield* Effect.logError("giving up on batch").pipe(Effect.annotateLogs(fields));
    yield* (yield* Batch).phase.set("failed");
    return undefined;
  }
  yield* open;
  yield* reconcile; // an empty roster, or agents that all failed to start, finalize at once
  return undefined;
}).pipe(Effect.withSpan("Batch.dispatch"));

/** Ask every run still going to stop; force-close whatever hasn't reported a while later. */
const deadline = Effect.gen(function* () {
  if ((yield* batchState)._tag !== "Dispatched") return;
  const batch = yield* Batch;
  const objects = yield* Objects;
  const runs = yield* (yield* Database).runsOfBatch(batch.name);
  yield* Effect.forEach(
    runs.filter((r) => !isTerminal(r.status)),
    (r) =>
      objects
        .dive(diveName(batch.name, r.modelId, r.attempt))
        .abort()
        .pipe(
          Effect.catchTag("RpcError", logRecovered("dive agent abort failed")),
          Effect.annotateLogs({ runId: r.runId, modelId: r.modelId }),
        ),
    { concurrency: "unbounded", discard: true },
  );
  yield* batch.jobs.push({ fn: "force-close" }, FORCE_CLOSE_MS);
}).pipe(Effect.withSpan("Batch.deadline"));

/** Runs that never reported after their abort are closed as timed out. */
const forceClose = Effect.gen(function* () {
  const state = yield* batchState;
  if (state._tag !== "Dispatched") return;
  const batch = yield* Batch;
  const db = yield* Database;
  for (const r of yield* db.runsOfBatch(batch.name)) {
    if (isTerminal(r.status)) continue;
    yield* Effect.logError("run force-closed: no report after abort").pipe(
      Effect.annotateLogs({ runId: r.runId, modelId: r.modelId, status: r.status }),
    );
    yield* db.markRunStatus(r.runId, "timed_out", "no report after abort");
  }
  yield* finalize(state);
}).pipe(Effect.withSpan("Batch.forceClose"));

/** A timer job that fails runs again later instead of being dropped: the batch must still close. */
const retried = <E, R>(job: Effect.Effect<void, E, R>): Effect.Effect<LifecycleJobOutcome, never, R> =>
  job.pipe(
    Effect.as(undefined),
    Effect.catch((e) =>
      logRecovered("batch job failed, retrying")(e).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((now) => ({ rescheduleAt: now + RETRY_MS })),
      ),
    ),
  );

const runJob = Match.type<Job>().pipe(
  Match.discriminatorsExhaustive("fn")({
    dispatch: () => dispatch,
    deadline: () => retried(deadline),
    "force-close": () => retried(forceClose),
  }),
);

/**
 * One batch of runs: a real day (named by its ET date) or a manual trial
 * (`day#trial-…`). Fetches the game, fans out one DiveAgent per model, retries
 * infra failures once, enforces the deadline, and ranks the day.
 */
export class DayCoordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
  readonly #keys = batchKeys(this.ctx.storage.kv);
  readonly #jobs = new JobQueue(() => this.lifecycle.jobs, Job);
  /**
   * Jobs and RPCs that move the batch run one at a time. Lifecycle runs jobs in order, but
   * the input gate opens at every D1 query, sleep, and RPC, so a `runFinished` could
   * otherwise act on runs read before a concurrent launch inserted its rows.
   */
  readonly #exclusive = Semaphore.makeUnsafe(1);
  readonly #object = durableObjectRunner({
    tag: Batch,
    service: () => Batch.of({ ...this.#keys, jobs: this.#jobs, name: this.lifecycle.name }),
    annotations: () => ({ batch: this.lifecycle.name }),
    start: () => this.lifecycle.start(),
    jobs: this.#jobs,
    runJob: (job) => this.#exclusive.withPermit(runJob(job)),
  });

  start(request: BatchRequest): Promise<StartResult> {
    return this.#object.rpc(this.#exclusive.withPermit(start(request)));
  }

  status(): Promise<BatchStatus> {
    return this.#object.rpc(status);
  }

  rerun(modelIds: ReadonlyArray<string>): Promise<Rerun> {
    return this.#object.rpc(this.#exclusive.withPermit(rerun(modelIds)));
  }

  /** A DiveAgent reports a finished run. */
  runFinished(runId: string): Promise<void> {
    return this.#object.rpc(this.#exclusive.withPermit(reconcile).pipe(Effect.annotateLogs({ runId })));
  }

  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.#object.onJob(context);
  }
}
