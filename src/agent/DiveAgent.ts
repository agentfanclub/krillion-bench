import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { createRegistry, type EntryRecord, Harness } from "@earendil-works/pi-durable";
import { Browser, browserRun } from "agents/browser";
import { PiHarness, type PiOperationResult } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Cause, Clock, Context, type Data, Effect, Match, Option, Schema } from "effect";
import { durableObjectRunner } from "../App";
import { JobQueue, stored } from "../Cloudflare";
import { Database, type SubmissionResult } from "../Database";
import { type PromptResult, RunInput, type RunSummary, type TerminalStatus } from "../domain";
import { clip, logRecovered } from "../Logging";
import { type AgentStatus, type DiveStart, DivePhase, Objects } from "../Objects";
import { type CapturedSubmission, type GameState, RunPage } from "./browser";
import { gatewayBinding, type GatewayHooks, rosterModel, subscriptionFetch } from "./gateway";
import { OPENAI_ROSTER_PREFIX, subscriptionProvider } from "./openaiSubscription";
import { NUDGE, PROMPT } from "./prompt";
import { browserExtension } from "./tools";
import { scorePrompt } from "../scoring";

const WATCH_EVERY_MS = 10_000;
/** Hard ceiling per run, independent of the coordinator's deadline. A dive takes ~4 min. */
const RUN_WALL_MS = 20 * 60_000;
const MAX_TURNS = 150;
/** Times a model that ends its turn mid-dive is told to keep going. */
const MAX_NUDGES = 3;

/** Why a run ended: the model stopped, the dive is complete, time ran out, or we failed. */
const FinalizeReason = Schema.Literals(["ended", "complete", "deadline", "error"]);
type FinalizeReason = typeof FinalizeReason.Type;

const Job = Schema.Union([
  Schema.Struct({ fn: Schema.Literal("begin") }),
  Schema.Struct({ fn: Schema.Literal("watch") }),
  Schema.Struct({ fn: Schema.Literal("finalize"), payload: FinalizeReason }),
]);
type Job = typeof Job.Type;

/** The agent's durable state (same keys as every earlier version, plus the finalize keys). */
const runState = (kv: SyncKvStorage) => ({
  input: stored(kv, "run:input", RunInput),
  phase: stored(kv, "run:phase", DivePhase),
  startedAt: stored(kv, "run:startedAt", Schema.Number),
  steps: stored(kv, "run:steps", Schema.Number, 0),
  /** Nudges actually handed to Pi (set after each submit), so the last operation is real. */
  nudges: stored(kv, "run:nudges", Schema.Number, 0),
  /** The last provider error message the gateway wrapper saw (its own words, not Pi's). */
  providerError: stored(kv, "run:lastProviderError", Schema.String),
  /** Set once any provider call of this run was rate limited. */
  rateLimited: stored(kv, "run:rateLimited", Schema.Boolean, false),
  providerAuthFailed: stored(kv, "run:providerAuthFailed", Schema.Boolean, false),
  /** Why the run ended, recorded once before finalize starts; the first reason wins. */
  finalizeReason: stored(kv, "run:finalizeReason", FinalizeReason),
  /** Our own error that ended the run (a failed begin). */
  finalizeError: stored(kv, "run:finalizeError", Schema.String),
});
type RunState = ReturnType<typeof runState>;

/** This agent: its state, harness, browser, and job queue. */
class Dive extends Context.Service<
  Dive,
  {
    readonly state: RunState;
    readonly harness: PiHarness;
    readonly browser: Browser;
    readonly page: RunPage;
    readonly modelFor: (id: string) => Model<Api>;
    readonly jobs: JobQueue<Job>;
    /** (Re)install the browser tools: the vision flag comes from the stored input. */
    readonly installTools: () => void;
  }
>()("krillion/Dive") {}

/**
 * Decoded from the stored keys: New → Accepted → Running → Finalizing → Finalized.
 * Accepted can go straight to Finalizing (a failed begin, or an abort before the prompt).
 */
type DiveState = Data.TaggedEnum<{
  New: {};
  Accepted: { readonly input: RunInput };
  Running: { readonly input: RunInput; readonly startedAt: number };
  Finalizing: { readonly input: RunInput; readonly reason: FinalizeReason; readonly error: string | undefined };
  Finalized: { readonly input: RunInput };
}>;

const decodeState = (state: RunState): DiveState => {
  const input = state.input.getUnsafe();
  if (Option.isNone(input)) return { _tag: "New" };
  const phase = state.phase.getUnsafe();
  if (Option.contains(phase, "finalized")) return { _tag: "Finalized", input: input.value };
  const reason = state.finalizeReason.getUnsafe();
  if (Option.isSome(reason)) {
    const error = Option.getOrUndefined(state.finalizeError.getUnsafe());
    return { _tag: "Finalizing", input: input.value, reason: reason.value, error };
  }
  const startedAt = state.startedAt.getUnsafe();
  return Option.contains(phase, "running") && Option.isSome(startedAt)
    ? { _tag: "Running", input: input.value, startedAt: startedAt.value }
    : { _tag: "Accepted", input: input.value };
};

const diveState = Dive.useSync(({ state }) => decodeState(state));

/**
 * Accepted → Running, unless the run moved on meanwhile (an abort while begin awaited).
 * One synchronous read-and-write, so nothing interleaves between the check and the transition.
 */
const markStarted = (now: number) =>
  Dive.useSync(({ state }) => {
    if (decodeState(state)._tag !== "Accepted") return;
    state.startedAt.setUnsafe(now);
    state.phase.setUnsafe("running");
  });

/**
 * Accepted | Running → Finalizing: record why the run ended, unless an earlier end
 * already did (first reason wins). Synchronous, like `markStarted`. The reason to
 * finalize with, or undefined when there is no run to finalize.
 */
const recordEnd = (reason: FinalizeReason, error?: unknown) =>
  Dive.useSync(({ state }): FinalizeReason | undefined => {
    const current = decodeState(state);
    switch (current._tag) {
      case "Accepted":
      case "Running":
        state.finalizeReason.setUnsafe(reason);
        if (error !== undefined) state.finalizeError.setUnsafe(String(error));
        return reason;
      case "Finalizing":
        return current.reason;
      default:
        return undefined;
    }
  });

/**
 * End the run: record why, then queue the finalize job. Finalize runs only as that job
 * (jobs run one at a time), so no two ends can both run it; an eviction mid-finalize
 * leaves the job and the reason in place, and the retried job resumes it.
 */
const endRun = Effect.fn("Dive.endRun")(function* (reason: FinalizeReason, error?: unknown) {
  const recorded = yield* recordEnd(reason, error);
  if (recorded !== undefined) yield* (yield* Dive).jobs.push({ fn: "finalize", payload: recorded });
});

/** Pi operation id of the prompt (nudge 0) or of a nudge. */
const operationOf = (runId: string, nudge: number) => (nudge === 0 ? runId : `${runId}:nudge-${nudge}`);

/** Run `self`; on failure log `message` with the cause and use `fallback`. */
const orWarn =
  <B>(message: string, fallback: B) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, never, R> =>
    Effect.catchCause(self, (cause) => Effect.as(Effect.logWarning(message, cause), fallback));

/** One failed model request, from an assistant message Pi marked as an error. A type, so it can annotate logs. */
type ModelFailure = {
  readonly errorMessage: string;
  readonly stopReason: string;
  readonly api?: string;
  readonly model?: string;
  readonly responseModel?: string;
  readonly at: string;
  readonly diagnostics?: unknown;
};

const modelFailures = (entries: readonly EntryRecord[]): Array<ModelFailure> =>
  entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "assistant" && (message.stopReason === "error" || message.errorMessage)
        ? [
            {
              errorMessage: clip(message.errorMessage ?? `stopReason ${message.stopReason}`),
              stopReason: message.stopReason,
              api: message.api,
              model: message.model,
              responseModel: message.responseModel,
              at: new Date(message.timestamp).toISOString(),
              diagnostics: message.diagnostics,
            },
          ]
        : [],
    ),
  );

/** Pi's reasons for an unanswered operation that mean the model never really got to play. */
const isPiBreakdown = Schema.is(Schema.Literals(["model_error", "no_model", "interrupted", "restart_limit"]));

/**
 * Model failures are results; failures on our side, the provider's, or the
 * site's are `infra_error` (and get one retry from the coordinator). A run that died
 * on a model error after a rate limit or credential failure is infra too,
 * however far it got.
 */
const classify = (
  reason: FinalizeReason,
  outcome: PiOperationResult | undefined,
  submissions: number,
  providerUnavailable: boolean,
): TerminalStatus =>
  Match.value(reason).pipe(
    Match.withReturnType<TerminalStatus>(),
    Match.when("complete", () => "completed"),
    Match.when("deadline", () => "timed_out"),
    Match.when("error", () => "infra_error"),
    Match.when("ended", () => {
      if (outcome?.status === "done" || outcome?.reason === "turn_limit") return "completed";
      if (outcome?.reason === "model_error" && providerUnavailable) return "infra_error";
      if (isPiBreakdown(outcome?.reason)) return submissions === 0 ? "infra_error" : "failed";
      return "failed";
    }),
    Match.exhaustive,
  );

/**
 * Per prompt: the accepted submission we captured; else the game's own record (a
 * submission made while we were disconnected, e.g. an eviction gap); else timed out
 * or never reached.
 */
const promptResults = (
  input: RunInput,
  subs: ReadonlyArray<SubmissionResult>,
  game: GameState | undefined,
): Array<PromptResult> =>
  input.prompts.map((p, i): PromptResult => {
    const fromGame = game?.results?.find((r) => r.promptId === p.id);
    const result = scorePrompt(p.id, subs, fromGame !== undefined || (game?.roundIndex ?? -1) > i);
    if (result.outcome === "accepted" || !fromGame?.answer || !fromGame.score) return result;
    return { ...result, outcome: "accepted", answer: fromGame.answer, tier: fromGame.tier ?? null, score: fromGame.score };
  });

/** The page's game state, when it is this run's dive. */
const todaysGame = (input: RunInput) =>
  Dive.use((dive) => Effect.tryPromise(() => dive.page.gameState())).pipe(
    Effect.map(Option.filter((game) => game.date === input.day)),
  );

/** The run's error message: ours, else the provider's, else Pi's outcome for infra errors. */
const runError = (
  error: string | undefined,
  failures: ReadonlyArray<ModelFailure>,
  providerError: string | undefined,
  status: TerminalStatus,
  piOutcome: string,
): string | null => {
  if (error !== undefined) return error;
  if (failures.length > 0) return providerError ?? failures.at(-1)?.errorMessage ?? null;
  return status === "infra_error" ? piOutcome : null;
};

/**
 * Stop the model, score the run from captured submissions, record it, close the browser,
 * tell the coordinator. Runs only as the finalize job; safe to rerun until it marks the
 * run finalized (the summary write is an upsert).
 */
const finalize = Effect.fn("Dive.finalize")(function* ({
  input,
  reason,
  error,
}: Data.TaggedEnum.Value<DiveState, "Finalizing">) {
  const dive = yield* Dive;
  const { state, harness } = dive;
  const db = yield* Database;

  if (reason !== "ended") {
    yield* Effect.tryPromise(() => harness.abort()).pipe(
      Effect.ignore({ log: "Warn", message: "harness abort failed" }),
    );
  }
  const lastOp = operationOf(input.runId, yield* state.nudges.get);
  const outcome = yield* Effect.tryPromise((signal) => harness.wait(lastOp, { signal })).pipe(
    Effect.timeout("30 seconds"),
    orWarn("harness wait failed; outcome unknown", undefined),
    Effect.annotateLogs({ operationId: lastOp }),
  );
  const game = yield* todaysGame(input).pipe(orWarn("could not read game state at finalize", Option.none()));
  // Stop capture before reading submissions: once this returns, every submission the
  // page saw is in D1 and no tool can reopen the connection.
  yield* Effect.promise(() => dive.page.close());

  const subs = yield* db.submissionsOfRun(input.runId);
  const results = promptResults(input, subs, Option.getOrUndefined(game));
  const usage = yield* Effect.tryPromise(async () => (await harness.pi()).usage(BACKGROUND_CONTEXT)).pipe(
    orWarn("could not read usage", undefined),
  );
  const tokens = Object.values(usage?.models ?? {}).reduce(
    (t, u) => ({ input: t.input + u.input, output: t.output + u.output, cost: t.cost + u.cost.total }),
    { input: 0, output: 0, cost: 0 },
  );
  // Provider/model failures as Pi recorded them on assistant messages (one per failed
  // request, retries included), so a `failed`/`infra_error` run says why.
  const failures = yield* Effect.tryPromise(() => harness.messages()).pipe(
    Effect.map(modelFailures),
    orWarn("could not read transcript for model errors", []),
  );
  yield* Effect.forEach(failures.slice(-5), (f) => Effect.logError("model request failed").pipe(Effect.annotateLogs(f)), {
    discard: true,
  });

  const piOutcome = outcome ? (outcome.reason ? `${outcome.status}:${outcome.reason}` : outcome.status) : "unknown";
  const rateLimited = yield* state.rateLimited.get;
  const providerAuthFailed = yield* state.providerAuthFailed.get;
  const providerError = Option.getOrUndefined(yield* state.providerError.get);
  const status = classify(reason, outcome, subs.length, rateLimited || providerAuthFailed);
  const costUsd = Object.keys(usage?.models ?? {}).some((id) => id.startsWith(OPENAI_ROSTER_PREFIX)) ? null : tokens.cost;
  const summary: RunSummary = {
    runId: input.runId,
    day: input.day,
    modelId: input.model.id,
    status,
    error: runError(error, failures, providerError, status, piOutcome),
    totalScore: results.reduce((sum, r) => sum + r.score, 0),
    steps: yield* state.steps.get,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    costUsd,
    piOutcome,
    selfReport: outcome?.text ?? null,
    results,
  };
  yield* (status === "completed" ? Effect.logInfo("dive finished") : Effect.logError("dive finished with error")).pipe(
    Effect.annotateLogs({
      finalizeReason: reason,
      status,
      piOutcome,
      totalScore: summary.totalScore,
      accepted: results.filter((r) => r.outcome === "accepted").length,
      submissions: subs.length,
      steps: summary.steps,
      modelErrors: failures.length,
      lastProviderError: providerError,
      rateLimited,
      runError: summary.error ?? undefined,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      costUsd,
    }),
  );
  yield* db.writeRunSummary(summary).pipe(
    Effect.catchTag("SqlError", (e) =>
      logRecovered("run summary write failed")(e).pipe(
        Effect.andThen(db.markRunStatus(input.runId, "infra_error", `summary write failed: ${e.message}`)),
      ),
    ),
  );
  yield* state.phase.set("finalized");

  yield* Effect.tryPromise(() => dive.browser.close()).pipe(Effect.ignore);
  yield* (yield* Objects)
    .coordinator(input.batch)
    .runFinished(input.runId)
    .pipe(Effect.catchTag("RpcError", logRecovered("coordinator notify failed")));
});

/**
 * Open the browser, set the model, start the clock, hand Pi the prompt, then start watching.
 * Resumable: rerun after an eviction from Running, it resubmits the prompt (Pi admits an
 * operation id once) and schedules the watch it may never have scheduled.
 */
const begin = Effect.gen(function* () {
  const dive = yield* Dive;
  const { harness } = dive;
  const accepted = yield* diveState;
  if (accepted._tag === "Accepted") {
    const { input } = accepted;
    yield* Effect.tryPromise(() => dive.page.page()); // open the browser before the model's clock starts
    yield* (yield* Database).markRunning(input.runId, yield* Effect.tryPromise(() => dive.page.sessionId()));
    yield* Effect.tryPromise(() => harness.session().setModel(dive.modelFor(input.model.id)));
    const thinkingLevel = input.model.thinkingLevel;
    if (thinkingLevel) {
      yield* Effect.tryPromise(async () => {
        const root = await (await harness.pi()).root(BACKGROUND_CONTEXT);
        await root.configure({ thinkingLevel }, BACKGROUND_CONTEXT);
      });
    }
    yield* markStarted(yield* Clock.currentTimeMillis);
  }
  const current = yield* diveState;
  if (current._tag !== "Running") return; // ended (aborted) while setting up
  const { runId } = current.input;
  yield* Effect.tryPromise(() => harness.submit(PROMPT, { operationId: runId }));
  yield* dive.jobs.push({ fn: "watch" }, WATCH_EVERY_MS);
}).pipe(
  Effect.catchCause((cause) => {
    const error = Cause.squash(cause);
    return Effect.logError("dive begin failed", cause).pipe(
      Effect.andThen(endRun("error", Cause.isUnknownError(error) ? error.cause : error)),
    );
  }),
  Effect.withSpan("Dive.begin"),
);

/** Every few seconds: end the run when the dive is done or over time; nudge a model that stopped early. */
const watch = Effect.gen(function* () {
  const { state, harness } = yield* Dive;
  const current = yield* diveState;
  if (current._tag !== "Running") return undefined;
  const { input, startedAt } = current;
  const now = yield* Clock.currentTimeMillis;
  if (now - startedAt > RUN_WALL_MS) {
    yield* endRun("deadline");
    return undefined;
  }
  // The task is the daily dive. Once the game holds all of today's results, the run
  // is over even if the model keeps going (one trial model moved on to Unlimited mode).
  const game = yield* todaysGame(input).pipe(Effect.orElseSucceed(Option.none));
  if (Option.exists(game, (g) => (g.results?.length ?? 0) >= input.prompts.length)) {
    yield* endRun("complete");
    return undefined;
  }

  const pending = yield* Effect.tryPromise(() => harness.pending());
  if (pending.length > 0) return { rescheduleAt: now + WATCH_EVERY_MS };

  // The model ended its turn before the dive is over: nudge it (same text, same cap,
  // for every model). Some models end a turn on a stray text message mid-game.
  const nudges = yield* state.nudges.get;
  if (nudges >= MAX_NUDGES) {
    yield* endRun("ended");
    return undefined;
  }
  // Count the nudge only once Pi has it: finalize waits on the last counted operation.
  // A failed submit is retried next tick under the same operation id.
  yield* Effect.tryPromise(() => harness.submit(NUDGE, { operationId: operationOf(input.runId, nudges + 1) }));
  yield* state.nudges.set(nudges + 1);
  return { rescheduleAt: now + WATCH_EVERY_MS };
}).pipe(
  // Pi unreachable for a tick: check again next tick (the wall clock still ends the run),
  // instead of failing the job, which Lifecycle drops after its retries, leaving no watch.
  Effect.catch((error) =>
    logRecovered("dive watch check failed")(error).pipe(
      Effect.andThen(Clock.currentTimeMillis),
      Effect.map((now) => ({ rescheduleAt: now + WATCH_EVERY_MS })),
    ),
  ),
  Effect.withSpan("Dive.watch"),
);

/** Finalize the run once. A job pushed without a recorded end (an older version's) records its own reason. */
const finalizeJob = Effect.fn("Dive.finalizeJob")(function* (reason: FinalizeReason) {
  yield* recordEnd(reason);
  const current = yield* diveState;
  if (current._tag === "Finalizing") yield* finalize(current);
});

const runJob = Match.type<Job>().pipe(
  Match.discriminatorsExhaustive("fn")({
    begin: () => Effect.as(begin, undefined),
    watch: () => watch,
    finalize: ({ payload }) => Effect.as(finalizeJob(payload), undefined),
  }),
);

/** Idempotent: a second call for the same object is a no-op. Returns before the model runs. */
const start = Effect.fn("Dive.start")(function* (input: RunInput) {
  const dive = yield* Dive;
  // Check and store in one synchronous step, so two concurrent starts can't both accept.
  const accepted = yield* Dive.useSync(({ state }) => {
    if (decodeState(state)._tag !== "New") return false;
    state.input.setUnsafe(input);
    return true;
  });
  if (!accepted) return { accepted: false };
  dive.installTools(); // the vision flag is known now
  yield* dive.jobs.push({ fn: "begin" });
  return { accepted: true };
});

/** Coordinator deadline: stop the model and record what it has. Also requeues a finalize that stalled. */
const abort = endRun("deadline").pipe(Effect.withSpan("Dive.abort"));

const status = Effect.gen(function* () {
  const { state } = yield* Dive;
  return {
    phase: Option.getOrNull(yield* state.phase.get),
    steps: yield* state.steps.get,
    input: Option.getOrNull(yield* state.input.get),
  };
}).pipe(Effect.withSpan("Dive.status"));

/**
 * One model's attempt at one day's dive: a Pi harness driving one Browser Run
 * browser, plus a harness-only listener recording every submission.
 */
export class DiveAgent extends DurableObject<Env> {
  readonly #state = runState(this.ctx.storage.kv);

  readonly #useSubscription = this.env.OPENAI_CHATGPT_CREDENTIAL !== undefined;
  readonly #providerHooks: GatewayHooks = {
    run: (effect) => this.#object.run(effect),
    onProviderError: (message, rateLimited) => {
      this.#state.providerError.setUnsafe(clip(message, 1_000));
      if (rateLimited) this.#state.rateLimited.setUnsafe(true);
    },
  };
  readonly ai = createAI({
    binding: gatewayBinding(this.env.AI, this.#providerHooks),
    id: this.env.AI_GATEWAY,
  });
  readonly browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      keepAliveMs: 5 * 60_000,
      recording: true,
      guardrails: { allowedDomains: ["krillion.io"] },
    }),
  });
  readonly registry = createRegistry();
  readonly page = new RunPage(this.env.BROWSER, this.browser, this.ctx.storage, (s) => this.#record(s));

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels();
      models.setProvider(this.#provider());
      // Also register this when disabled so a resumed subscription run reports an auth error.
      models.setProvider(subscriptionProvider(this.env, subscriptionFetch(this.#providerHooks), (message) => {
        this.#state.providerError.setUnsafe(clip(message, 1_000));
        this.#state.providerAuthFailed.setUnsafe(true);
      }));
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          onWake,
          settings: {
            // A long backoff burns the 25 s clock anyway.
            retry: { maxRetries: 2, baseDelayMs: 500 },
            afterFailedRun: "withdraw",
          },
        },
        context,
      );
    },
    defaults: { maxTurns: MAX_TURNS },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.browser).use(this.harness);
  readonly #jobs = new JobQueue(() => this.lifecycle.jobs, Job);
  readonly #object = durableObjectRunner({
    tag: Dive,
    service: () =>
      Dive.of({
        state: this.#state,
        harness: this.harness,
        browser: this.browser,
        page: this.page,
        modelFor: (id) => rosterModel(this.ai, id, this.#useSubscription),
        jobs: this.#jobs,
        installTools: () => this.#installTools(),
      }),
    annotations: () => this.#logContext(),
    start: () => this.lifecycle.start(),
    jobs: this.#jobs,
    runJob,
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Tools for the stored input (after an eviction); `start` reinstalls once the input arrives.
    this.#installTools();
  }

  /**
   * The Cloudflare provider, plus this run's model when Pi AI's Cloudflare catalog
   * doesn't list it (older/smaller Workers AI models, Gemini). Pi resolves a session's
   * model through the registry on every request, so an unlisted model would fail with
   * `no_model`. Read lazily: the factory can run before `start()` stores the input.
   */
  #provider(): Provider {
    const base = this.ai.provider;
    const extra = (): Model<Api>[] =>
      Option.match(this.#state.input.getUnsafe(), {
        onNone: () => [],
        onSome: (input) => {
          // Existing gateway models are already in the catalog. Subscription-only models
          // belong to the native provider and need no gateway registration.
          if (this.#useSubscription && input.model.id.startsWith(OPENAI_ROSTER_PREFIX)) return [];
          const model = rosterModel(this.ai, input.model.id);
          return base.getModels().some((m) => m.id === model.id) ? [] : [model];
        },
      });
    return Object.create(base, {
      getModels: { value: () => [...base.getModels(), ...extra()] },
      getAllModels: { value: () => [...(base.getAllModels?.() ?? base.getModels()), ...extra()] },
    });
  }

  /** Fields identifying this run on every log line. */
  #logContext(): Readonly<Record<string, unknown>> {
    return Option.match(this.#state.input.getUnsafe(), {
      onNone: () => ({ agentId: this.ctx.id.toString() }),
      onSome: (input) => ({
        runId: input.runId,
        batch: input.batch,
        day: input.day,
        modelId: input.model.id,
        attempt: input.attempt,
        trial: input.trial,
      }),
    });
  }

  #installTools(): void {
    this.registry.install(
      browserExtension({
        page: () => this.page.page(),
        vision: Option.exists(this.#state.input.getUnsafe(), (input) => input.model.vision === true),
        onStep: () => this.#state.steps.setUnsafe(this.#state.steps.getUnsafe() + 1),
      }),
    );
  }

  /** A captured submission for today's dive. The page awaits it, so finalize's `page.close()` covers the write. */
  #record({ date, ...s }: CapturedSubmission): Promise<void> {
    const input = Option.getOrUndefined(this.#state.input.getUnsafe());
    if (!input || date !== input.day) return Promise.resolve();
    return this.#object.run(
      Database.use((db) => db.insertSubmission({ ...s, runId: input.runId, day: input.day })).pipe(
        Effect.catchCause((cause) => Effect.logError("submission write failed", cause)),
        Effect.annotateLogs({ promptId: s.promptId }),
      ),
    );
  }

  start(input: RunInput): Promise<DiveStart> {
    return this.#object.rpc(start(input));
  }

  abort(): Promise<void> {
    return this.#object.rpc(abort);
  }

  status(): Promise<AgentStatus> {
    return this.#object.rpc(status);
  }

  /** Pi's transcript, for debugging and a future replay view. */
  transcript(): Promise<unknown> {
    return this.#object.rpc(Dive.use((dive) => Effect.promise(() => dive.harness.messages())));
  }

  onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    return this.#object.onJob(context);
  }
}
