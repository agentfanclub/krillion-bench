import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Clock, Context, Effect, Match, Option, Result, Schema } from "effect";
import { PROMPT_VERSION } from "./agent/prompt";
import { durableObjectRunner } from "./App";
import { JobQueue, type Stored, stored } from "./Cloudflare";
import { Database } from "./Database";
import { BatchConfig, type BatchRequest, isTerminal, type ModelEntry, TodayGame } from "./domain";
import { Krillion } from "./Krillion";
import { logRecovered } from "./Logging";
import { BatchPhase, type BatchStatus, diveName, Objects, type Rerun, type StartResult } from "./Objects";
import { Roster } from "./Roster";

/** How long to wait for the site to roll over to the new day before giving up. */
const ROLLOVER_GRACE_MS = 20 * 60_000;
const ROLLOVER_RETRY_MS = 60_000;
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

/** This coordinator's batch: its name, durable state, and job queue. */
class Batch extends Context.Service<
  Batch,
  {
    readonly name: string;
    readonly config: Stored<Option.Option<BatchConfig>, BatchConfig>;
    readonly game: Stored<Option.Option<TodayGame>, TodayGame>;
    readonly phase: Stored<Option.Option<BatchPhase>, BatchPhase>;
    readonly jobs: JobQueue<Job>;
  }
>()("krillion/Batch") {}

const isDispatched = Batch.use((batch) => Effect.map(batch.phase.get, Option.contains<BatchPhase>("dispatched")));

/** Insert the run row (unless `runId` names an existing one) and start its agent. Both steps are idempotent. */
const launch = Effect.fn("Batch.launch")(function* (run: {
  readonly game: TodayGame;
  readonly config: BatchConfig;
  readonly model: ModelEntry;
  readonly attempt: number;
  readonly runId?: string | undefined;
}) {
  const batch = yield* Batch;
  const db = yield* Database;
  const { game, config, model, attempt } = run;
  const runId = run.runId ?? crypto.randomUUID();
  if (run.runId === undefined) {
    yield* db.upsertModel(model);
    yield* db.insertRun({ runId, batch: batch.name, day: game.date, model, attempt, trial: config.trial, promptVersion: PROMPT_VERSION });
  }
  yield* (yield* Objects)
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
});

/** One model after another: Browser Run limits how fast browsers start. */
const staggered = <E, R>(models: ReadonlyArray<ModelEntry>, f: (model: ModelEntry) => Effect.Effect<void, E, R>) =>
  Effect.forEach(models, (model, i) => (i === 0 ? f(model) : Effect.andThen(Effect.sleep(STAGGER), f(model))), {
    discard: true,
  });

const finalize = Effect.gen(function* () {
  const batch = yield* Batch;
  const config = yield* batch.config.get;
  if (Option.isNone(config) || Option.contains(yield* batch.phase.get, "finalized")) return;
  const game = yield* batch.game.get;
  if (!config.value.trial && Option.isSome(game)) yield* (yield* Database).finalizeDay(game.value.date);
  yield* batch.phase.set("finalized");
  yield* batch.jobs.cancel("deadline");
  yield* batch.jobs.cancel("force-close");
}).pipe(Effect.withSpan("Batch.finalize"));

/** Retry first-attempt infra failures once; finalize when every run is terminal. */
const reconcile = Effect.gen(function* () {
  if (!(yield* isDispatched)) return;
  const batch = yield* Batch;
  const runs = yield* (yield* Database).runsOfBatch(batch.name);
  const retry = runs.find(
    (r) => r.status === "infra_error" && r.attempt === 1 && !runs.some((o) => o.modelId === r.modelId && o.attempt === 2),
  );
  const game = yield* batch.game.get;
  const config = yield* batch.config.get;
  if (retry !== undefined && Option.isSome(game) && Option.isSome(config)) {
    yield* Effect.logWarning("retrying run after infra error").pipe(
      Effect.annotateLogs({ runId: retry.runId, modelId: retry.modelId }),
    );
    yield* launch({ game: game.value, config: config.value, model: retry.modelConfig, attempt: 2 });
    return; // the retry's own report reconciles again
  }
  if (runs.every((r) => isTerminal(r.status))) yield* finalize;
}).pipe(Effect.withSpan("Batch.reconcile"));

/** Idempotent: the cron's two daily firings, retries, and manual calls all land here. */
const start = Effect.fn("Batch.start")(function* (request: BatchRequest) {
  const batch = yield* Batch;
  if (Option.isSome(yield* batch.config.get)) return { batch: batch.name, accepted: false };
  const config: BatchConfig = { ...request, createdAt: yield* Clock.currentTimeMillis };
  yield* batch.config.set(config);
  yield* (yield* Database).registerBatch(batch.name, config);
  yield* batch.jobs.push({ fn: "dispatch" });
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
 * is an infra error. Null when this batch is not a dispatched real day.
 */
const rerun = Effect.fn("Batch.rerun")(function* (modelIds: ReadonlyArray<string>) {
  const batch = yield* Batch;
  const config = yield* batch.config.get;
  const game = yield* batch.game.get;
  if (Option.isNone(config) || config.value.trial || Option.isNone(game)) return null;

  const models = (yield* (yield* Roster).enabled).filter((m) => modelIds.includes(m.id));
  const skipped = modelIds.filter((id) => !models.some((m) => m.id === id));
  const runs = yield* (yield* Database).runsOfBatch(batch.name);

  if (models.length > 0) {
    yield* batch.phase.set("dispatched");
    yield* batch.jobs.cancel("force-close");
    yield* batch.jobs.push({ fn: "deadline" }, DEADLINE_MS);
  }
  yield* staggered(models, (model) => {
    const attempt = Math.max(0, ...runs.filter((r) => r.modelId === model.id).map((r) => r.attempt)) + 1;
    return Effect.logInfo("rerunning model for day").pipe(
      Effect.annotateLogs({ modelId: model.id, attempt }),
      Effect.andThen(launch({ game: game.value, config: config.value, model, attempt })),
    );
  });
  if (skipped.length > 0) {
    yield* Effect.logWarning("rerun skipped models not enabled in the roster").pipe(Effect.annotateLogs({ skipped }));
  }
  return { batch: batch.name, launched: models.map((m) => m.id), skipped };
});

/** Fetch the game (waiting for the site's rollover), launch every rostered model, start the deadline. */
const dispatch = Effect.gen(function* () {
  const batch = yield* Batch;
  const stored = yield* batch.config.get;
  if (Option.isNone(stored) || Option.isSome(yield* batch.phase.get)) return undefined;
  const config = stored.value;
  const krillion = yield* Krillion;
  const db = yield* Database;

  const fetched = yield* Effect.result(config.day ? krillion.gameFor(config.day) : krillion.today);
  if (Result.isFailure(fetched)) {
    const now = yield* Clock.currentTimeMillis;
    const fields = { day: config.day, errorMessage: fetched.failure.message };
    if (now - config.createdAt < ROLLOVER_GRACE_MS) {
      yield* Effect.logWarning("game not ready, retrying").pipe(Effect.annotateLogs(fields));
      return { rescheduleAt: now + ROLLOVER_RETRY_MS };
    }
    yield* Effect.logError("giving up on batch: no game").pipe(Effect.annotateLogs(fields));
    yield* batch.phase.set("failed");
    return undefined;
  }
  const game = fetched.success;
  yield* batch.game.set(game);
  yield* db.setBatchDay(batch.name, game.date);

  const roster = yield* Effect.result((yield* Roster).enabled);
  if (Result.isFailure(roster)) {
    yield* Effect.logError("giving up on batch: roster unreadable").pipe(
      Effect.annotateLogs({ errorMessage: roster.failure.message }),
    );
    yield* batch.phase.set("failed");
    return undefined;
  }
  const models = config.models ? roster.success.filter((m) => config.models?.includes(m.id)) : roster.success;

  yield* db.upsertGame(game);
  const existing = yield* db.runsOfBatch(batch.name);
  yield* staggered(models, (model) =>
    launch({ game, config, model, attempt: 1, runId: existing.find((r) => r.modelId === model.id && r.attempt === 1)?.runId }),
  );

  yield* batch.phase.set("dispatched");
  yield* batch.jobs.push({ fn: "deadline" }, DEADLINE_MS);
  yield* reconcile; // an empty roster finalizes at once
  return undefined;
}).pipe(Effect.withSpan("Batch.dispatch"));

/** Ask every run still going to stop; force-close whatever hasn't reported a while later. */
const deadline = Effect.gen(function* () {
  if (!(yield* isDispatched)) return;
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
    { discard: true },
  );
  yield* batch.jobs.push({ fn: "force-close" }, FORCE_CLOSE_MS);
}).pipe(Effect.withSpan("Batch.deadline"));

/** Runs that never reported after their abort are closed as timed out. */
const forceClose = Effect.gen(function* () {
  if (!(yield* isDispatched)) return;
  const batch = yield* Batch;
  const db = yield* Database;
  for (const r of yield* db.runsOfBatch(batch.name)) {
    if (isTerminal(r.status)) continue;
    yield* Effect.logError("run force-closed: no report after abort").pipe(
      Effect.annotateLogs({ runId: r.runId, modelId: r.modelId, status: r.status }),
    );
    yield* db.markRunStatus(r.runId, "timed_out", "no report after abort");
  }
  yield* finalize;
}).pipe(Effect.withSpan("Batch.forceClose"));

const runJob = Match.type<Job>().pipe(
  Match.discriminatorsExhaustive("fn")({
    dispatch: () => dispatch,
    deadline: () => Effect.as(deadline, undefined),
    "force-close": () => Effect.as(forceClose, undefined),
  }),
);

/**
 * One batch of runs: a real day (named by its ET date) or a manual trial
 * (`day#trial-…`). Fetches the game, fans out one DiveAgent per model, retries
 * infra failures once, enforces the deadline, and ranks the day.
 */
export class DayCoordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
  readonly #batch = (() => {
    const kv = this.ctx.storage.kv;
    // Same keys as every earlier version, so existing batches keep working.
    return {
      config: stored(kv, "batch:config", BatchConfig),
      game: stored(kv, "batch:game", TodayGame),
      phase: stored(kv, "batch:phase", BatchPhase),
      jobs: new JobQueue(() => this.lifecycle.jobs, Job),
    };
  })();
  readonly #object = durableObjectRunner({
    tag: Batch,
    service: () => Batch.of({ ...this.#batch, name: this.lifecycle.name }),
    annotations: () => ({ batch: this.lifecycle.name }),
    start: () => this.lifecycle.start(),
    jobs: this.#batch.jobs,
    runJob,
  });

  start(request: BatchRequest): Promise<StartResult> {
    return this.#object.rpc(start(request));
  }

  status(): Promise<BatchStatus> {
    return this.#object.rpc(status);
  }

  rerun(modelIds: ReadonlyArray<string>): Promise<Rerun> {
    return this.#object.rpc(rerun(modelIds));
  }

  /** A DiveAgent reports a finished run. */
  runFinished(_runId: string): Promise<void> {
    return this.#object.rpc(reconcile);
  }

  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.#object.onJob(context);
  }
}
