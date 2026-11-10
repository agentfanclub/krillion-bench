import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";
import { diveAgentName } from "./agent/DiveAgent";
import { PROMPT_VERSION } from "./agent/prompt";
import { ModelEntry, type RunInput, TERMINAL, type TodayGame } from "./domain";
import {
  fetchGameFor,
  fetchToday,
  finalizeDay,
  insertRun,
  loadRoster,
  makeRuntime,
  markRunStatus,
  type RunRow,
  registerBatch,
  runsOfBatch,
  setBatchDay,
  upsertGame,
  upsertModel,
} from "./services";

const CONFIG_KEY = "batch:config";
const GAME_KEY = "batch:game";
const PHASE_KEY = "batch:phase"; // undefined → "dispatched" → "finalized" | "failed"

/** How long to wait for the site to roll over to the new day before giving up. */
const ROLLOVER_GRACE_MS = 20 * 60_000;
/** After dispatch, runs still going are stopped. A dive takes ~4 min; runs are staggered. */
const DEADLINE_MS = 40 * 60_000;
/** After stopping stragglers, give them this long to report before forcing them closed. */
const FORCE_CLOSE_MS = 5 * 60_000;
/** Browser Run allows 3 new browsers per second. */
const STAGGER_MS = 400;

export interface BatchConfig {
  /** ET day for real runs. Trials take whatever day the site is on. */
  readonly day: string | null;
  readonly trial: boolean;
  /** Restrict to these roster ids (trials). */
  readonly models: ReadonlyArray<string> | null;
  /** "cron" or the admin's email. */
  readonly createdBy: string;
  readonly createdAt: number;
}

/**
 * One batch of runs: a real day (named by its ET date) or a manual trial
 * (`day#trial-…`). Fetches the game, fans out one DiveAgent per model, retries
 * infra failures once, enforces the deadline, and ranks the day.
 */
export class DayCoordinator extends DurableObject<Env> {
  readonly lifecycle = Lifecycle.install(this);
  readonly runtime = makeRuntime(this.env);

  get #config(): BatchConfig | undefined {
    return this.ctx.storage.kv.get<BatchConfig>(CONFIG_KEY);
  }

  /** Idempotent: the cron's two daily firings, retries, and manual calls all land here. */
  async start(config: Omit<BatchConfig, "createdAt">): Promise<{ batch: string; accepted: boolean }> {
    await this.lifecycle.start();
    const batch = this.lifecycle.name;
    if (this.#config) return { batch, accepted: false };
    this.ctx.storage.kv.put(CONFIG_KEY, { ...config, createdAt: Date.now() });
    await this.runtime.runPromise(
      registerBatch({ batch, day: config.day, trial: config.trial, models: config.models, createdBy: config.createdBy }),
    );
    await this.lifecycle.jobs.push({ id: "dispatch", fn: "dispatch", time: Date.now() });
    return { batch, accepted: true };
  }

  async status(): Promise<{ batch: string; phase: string | undefined; config: BatchConfig | undefined; runs: RunRow[] }> {
    await this.lifecycle.start();
    const batch = this.lifecycle.name;
    const runs = await this.runtime.runPromise(runsOfBatch(batch));
    return { batch, phase: this.ctx.storage.kv.get<string>(PHASE_KEY), config: this.#config, runs: [...runs] };
  }

  /** A DiveAgent reports a finished run. */
  async runFinished(_runId: string): Promise<void> {
    await this.lifecycle.start();
    await this.#reconcile();
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    switch (context.job.fn) {
      case "dispatch":
        return this.#dispatch();
      case "deadline":
        await this.#deadline();
        return undefined;
      case "force-close":
        await this.#forceClose();
        return undefined;
      default:
        return undefined;
    }
  }

  async #dispatch(): Promise<LifecycleJobOutcome> {
    const config = this.#config;
    if (!config || this.ctx.storage.kv.get(PHASE_KEY)) return undefined;
    const batch = this.lifecycle.name;

    const game = await this.runtime.runPromise(
      Effect.result(config.day ? fetchGameFor(config.day) : fetchToday),
    );
    if (game._tag === "Failure") {
      if (Date.now() - config.createdAt < ROLLOVER_GRACE_MS) {
        console.warn("game not ready, retrying", batch, game.failure.message);
        return { rescheduleAt: Date.now() + 60_000 };
      }
      console.error("giving up on batch: no game", batch, game.failure.message);
      this.ctx.storage.kv.put(PHASE_KEY, "failed");
      return undefined;
    }
    this.ctx.storage.kv.put(GAME_KEY, game.success);
    await this.runtime.runPromise(setBatchDay(batch, game.success.date));

    const roster = await this.runtime.runPromise(Effect.result(loadRoster(this.env.CONFIG)));
    if (roster._tag === "Failure") {
      console.error("giving up on batch: roster", batch, roster.failure.message);
      this.ctx.storage.kv.put(PHASE_KEY, "failed");
      return undefined;
    }
    const models = config.models ? roster.success.filter((m) => config.models?.includes(m.id)) : roster.success;

    await this.runtime.runPromise(upsertGame(game.success));
    const existing = await this.runtime.runPromise(runsOfBatch(batch));
    for (const [i, model] of models.entries()) {
      if (i > 0) await scheduler.wait(STAGGER_MS);
      const run = existing.find((r) => r.model_id === model.id && r.attempt === 1);
      await this.#launch(game.success, model, 1, run?.run_id);
    }

    this.ctx.storage.kv.put(PHASE_KEY, "dispatched");
    await this.lifecycle.jobs.push({ id: "deadline", fn: "deadline", time: Date.now() + DEADLINE_MS });
    await this.#reconcile(); // an empty roster finalizes at once
    return undefined;
  }

  /** Insert the run row (unless it exists) and start its agent. Both steps are idempotent. */
  async #launch(game: TodayGame, model: ModelEntry, attempt: number, existingRunId?: string): Promise<void> {
    const config = this.#config;
    if (!config) return;
    const batch = this.lifecycle.name;
    const runId = existingRunId ?? crypto.randomUUID();
    if (!existingRunId) {
      await this.runtime.runPromise(
        Effect.gen(function* () {
          yield* upsertModel(model);
          yield* insertRun({ runId, batch, day: game.date, model, attempt, trial: config.trial, promptVersion: PROMPT_VERSION });
        }),
      );
    }
    const input: RunInput = {
      runId,
      batch,
      day: game.date,
      attempt,
      trial: config.trial,
      model,
      prompts: game.prompts,
    };
    try {
      await this.env.DIVE_AGENT.getByName(diveAgentName(batch, model.id, attempt)).start(input);
    } catch (e) {
      await this.runtime.runPromise(markRunStatus(runId, "infra_error", `agent start failed: ${String(e)}`));
    }
  }

  /** Retry first-attempt infra failures once; finalize when every run is terminal. */
  async #reconcile(): Promise<void> {
    if (this.ctx.storage.kv.get(PHASE_KEY) !== "dispatched") return;
    const batch = this.lifecycle.name;
    const game = this.ctx.storage.kv.get<TodayGame>(GAME_KEY);
    const runs = await this.runtime.runPromise(runsOfBatch(batch));

    for (const r of runs) {
      const retried = runs.some((o) => o.model_id === r.model_id && o.attempt === 2);
      if (game && r.status === "infra_error" && r.attempt === 1 && !retried) {
        const model = Schema.decodeUnknownSync(Schema.fromJsonString(ModelEntry))(r.model_config);
        await this.#launch(game, model, 2);
        return; // the retry's own report reconciles again
      }
    }
    if (runs.every((r) => TERMINAL[r.status])) await this.#finalize();
  }

  async #deadline(): Promise<void> {
    if (this.ctx.storage.kv.get(PHASE_KEY) !== "dispatched") return;
    const batch = this.lifecycle.name;
    const runs = await this.runtime.runPromise(runsOfBatch(batch));
    for (const r of runs) {
      if (TERMINAL[r.status]) continue;
      await this.env.DIVE_AGENT.getByName(diveAgentName(batch, r.model_id, r.attempt))
        .abort()
        .catch((e: unknown) => console.error("abort failed", r.run_id, e));
    }
    await this.lifecycle.jobs.push({ id: "force-close", fn: "force-close", time: Date.now() + FORCE_CLOSE_MS });
  }

  /** Runs that never reported after their abort are closed as timed out. */
  async #forceClose(): Promise<void> {
    if (this.ctx.storage.kv.get(PHASE_KEY) !== "dispatched") return;
    const runs = await this.runtime.runPromise(runsOfBatch(this.lifecycle.name));
    for (const r of runs) {
      if (!TERMINAL[r.status]) await this.runtime.runPromise(markRunStatus(r.run_id, "timed_out", "no report after abort"));
    }
    await this.#finalize();
  }

  async #finalize(): Promise<void> {
    const config = this.#config;
    if (!config || this.ctx.storage.kv.get(PHASE_KEY) === "finalized") return;
    const game = this.ctx.storage.kv.get<TodayGame>(GAME_KEY);
    if (!config.trial && game) await this.runtime.runPromise(finalizeDay(game.date));
    this.ctx.storage.kv.put(PHASE_KEY, "finalized");
    await this.lifecycle.jobs.cancel("deadline");
    await this.lifecycle.jobs.cancel("force-close");
  }
}
