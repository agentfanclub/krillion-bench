import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { Browser, browserRun } from "agents/browser";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle";
import { createAI } from "agents/models/pi-ai";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import type { RunInput, RunStatus } from "../domain";
import {
  insertSubmission,
  makeRuntime,
  markRunning,
  markRunStatus,
  type ResultRow,
  submissionsOfRun,
  writeRunSummary,
} from "../services";
import { type CapturedSubmission, RunPage } from "./browser";
import { NUDGE, PROMPT } from "./prompt";
import { browserExtension } from "./tools";

const INPUT_KEY = "run:input";
const PHASE_KEY = "run:phase"; // undefined → "running" → "finalized"
const STARTED_KEY = "run:startedAt";
const STEPS_KEY = "run:steps";
const NUDGES_KEY = "run:nudges";
const LAST_OP_KEY = "run:lastOperation";

const WATCH_EVERY_MS = 10_000;
/** Hard ceiling per run, independent of the coordinator's deadline. A dive takes ~4 min. */
const RUN_WALL_MS = 20 * 60_000;
const MAX_TURNS = 150;
/** Times a model that ends its turn mid-dive is told to keep going. */
const MAX_NUDGES = 3;

/** DO name for one attempt. */
export const diveAgentName = (batch: string, modelId: string, attempt: number) => `${batch}|${modelId}|${attempt}`;

type FinalizeReason = "ended" | "complete" | "deadline" | "error";

/**
 * One model's attempt at one day's dive: a Pi harness driving one Browser Run
 * browser, plus a harness-only listener recording every submission.
 */
export class DiveAgent extends DurableObject<Env> {
  readonly ai = createAI({ binding: this.env.AI, id: "default" });
  readonly browser = new Browser({
    provider: browserRun(this.env.BROWSER, {
      keepAliveMs: 5 * 60_000,
      recording: true,
      guardrails: { allowedDomains: ["krillion.io"] },
    }),
  });
  readonly registry = createRegistry();
  readonly runtime = makeRuntime(this.env);
  readonly page = new RunPage(this.env.BROWSER, this.browser, this.ctx.storage, (s) => this.#record(s));
  readonly #writes = new Set<Promise<unknown>>();

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      this.#installTools();
      const models = createModels();
      models.setProvider(this.#provider());
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

  /**
   * The Cloudflare provider, plus this run's model when Pi AI's catalog doesn't list
   * it (older/smaller Workers AI models). Pi resolves a session's model through the
   * registry on every request, so an unlisted model would fail with `no_model`.
   * Read lazily: the factory can run before `start()` stores the input.
   */
  #provider(): Provider {
    const base = this.ai.provider;
    const extra = (): Model<Api>[] => {
      const id = this.#input?.model.id;
      return id && !base.getModels().some((m) => m.id === id) ? [this.ai(id)] : [];
    };
    return Object.create(base, {
      getModels: { value: () => [...base.getModels(), ...extra()] },
      getAllModels: { value: () => [...(base.getAllModels?.() ?? base.getModels()), ...extra()] },
    });
  }

  get #input(): RunInput | undefined {
    return this.ctx.storage.kv.get<RunInput>(INPUT_KEY);
  }

  #installTools(): void {
    this.registry.install(
      browserExtension({
        page: () => this.page.page(),
        vision: this.#input?.model.vision ?? false,
        onStep: () => this.ctx.storage.kv.put(STEPS_KEY, (this.ctx.storage.kv.get<number>(STEPS_KEY) ?? 0) + 1),
      }),
    );
  }

  /** Idempotent: a second call for the same object is a no-op. Returns before the model runs. */
  async start(input: RunInput): Promise<{ accepted: boolean }> {
    await this.lifecycle.start();
    if (this.#input) return { accepted: false };
    this.ctx.storage.kv.put(INPUT_KEY, input);
    this.#installTools(); // vision flag is now known
    await this.lifecycle.jobs.push({ id: "begin", fn: "begin", time: Date.now() });
    return { accepted: true };
  }

  /** Coordinator deadline: stop the model and record what it has. */
  async abort(): Promise<void> {
    await this.lifecycle.start();
    if (!this.#input || this.ctx.storage.kv.get(PHASE_KEY) === "finalized") return;
    await this.lifecycle.jobs.push({ id: "finalize", fn: "finalize", time: Date.now(), payload: "deadline" });
  }

  async status(): Promise<{ phase: string | undefined; steps: number; input: RunInput | undefined }> {
    await this.lifecycle.start();
    return {
      phase: this.ctx.storage.kv.get<string>(PHASE_KEY),
      steps: this.ctx.storage.kv.get<number>(STEPS_KEY) ?? 0,
      input: this.#input,
    };
  }

  /** Pi's transcript, for debugging and a future replay view. */
  async transcript(): Promise<unknown> {
    await this.lifecycle.start();
    return this.harness.messages();
  }

  async onJob(context: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    switch (context.job.fn) {
      case "begin":
        return this.#begin();
      case "watch":
        return this.#watch();
      case "finalize":
        await this.#finalize(context.job.payload as FinalizeReason);
        return undefined;
      default:
        return undefined;
    }
  }

  async #begin(): Promise<LifecycleJobOutcome> {
    const input = this.#input;
    if (!input || this.ctx.storage.kv.get(PHASE_KEY)) return undefined;
    try {
      await this.page.page(); // open the browser before the model's clock starts
      await this.runtime.runPromise(markRunning(input.runId, await this.page.sessionId()));
      const session = this.harness.session();
      await session.setModel(this.ai(input.model.id));
      if (input.model.thinkingLevel) {
        const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
        await root.configure({ thinkingLevel: input.model.thinkingLevel }, BACKGROUND_CONTEXT);
      }
      this.ctx.storage.kv.put(STARTED_KEY, Date.now());
      this.ctx.storage.kv.put(PHASE_KEY, "running");
      await this.harness.submit(PROMPT, { operationId: input.runId });
    } catch (e) {
      console.error("begin failed", input.runId, e);
      await this.#finalize("error", e);
      return undefined;
    }
    await this.lifecycle.jobs.push({ id: "watch", fn: "watch", time: Date.now() + WATCH_EVERY_MS });
    return undefined;
  }

  async #watch(): Promise<LifecycleJobOutcome> {
    if (this.ctx.storage.kv.get(PHASE_KEY) !== "running") return undefined;
    const startedAt = this.ctx.storage.kv.get<number>(STARTED_KEY) ?? Date.now();
    if (Date.now() - startedAt > RUN_WALL_MS) {
      await this.#finalize("deadline");
      return undefined;
    }
    // The task is the daily dive. Once the game holds all of today's results, the run
    // is over even if the model keeps going (one trial model moved on to Unlimited mode).
    const input = this.#input;
    const state = await this.page.gameState().catch(() => undefined);
    const done = state?.date === input?.day && (state?.results?.length ?? 0) >= (input?.prompts.length ?? 7);
    if (done) {
      await this.#finalize("complete");
      return undefined;
    }

    const pending = await this.harness.pending();
    if (pending.length > 0) return { rescheduleAt: Date.now() + WATCH_EVERY_MS };

    // The model ended its turn before the dive is over: nudge it (same text, same cap,
    // for every model). Some models end a turn on a stray text message mid-game.
    const nudges = this.ctx.storage.kv.get<number>(NUDGES_KEY) ?? 0;
    if (input && !done && nudges < MAX_NUDGES) {
      const operationId = `${input.runId}:nudge-${nudges + 1}`;
      this.ctx.storage.kv.put(NUDGES_KEY, nudges + 1);
      this.ctx.storage.kv.put(LAST_OP_KEY, operationId);
      await this.harness.submit(NUDGE, { operationId });
      return { rescheduleAt: Date.now() + WATCH_EVERY_MS };
    }
    await this.#finalize("ended");
    return undefined;
  }

  #record({ date, ...s }: CapturedSubmission): void {
    const input = this.#input;
    if (!input || date !== input.day) return;
    const write = this.runtime
      .runPromise(insertSubmission({ ...s, runId: input.runId, day: input.day }))
      .catch((e) => console.error("submission write failed", input.runId, e))
      .finally(() => this.#writes.delete(write));
    this.#writes.add(write);
    this.ctx.waitUntil(write);
  }

  async #finalize(reason: FinalizeReason, error?: unknown): Promise<void> {
    const input = this.#input;
    if (!input || this.ctx.storage.kv.get(PHASE_KEY) === "finalized") return;

    if (reason !== "ended") await this.harness.abort().catch(() => false);
    const lastOp = this.ctx.storage.kv.get<string>(LAST_OP_KEY) ?? input.runId;
    const outcome = await this.harness
      .wait(lastOp, { signal: AbortSignal.timeout(30_000) })
      .catch(() => undefined);
    const gameState = await this.page.gameState().catch(() => undefined);
    const state = gameState?.date === input.day ? gameState : undefined;
    await Promise.allSettled([...this.#writes]);

    const subs = await this.runtime.runPromise(submissionsOfRun(input.runId));
    const results: ResultRow[] = input.prompts.map((p, i) => {
      const mine = subs.filter((s) => s.prompt_id === p.id);
      const accepted = mine.find((s) => s.kind === "accepted");
      const fromGame = state?.results?.find((r) => r.promptId === p.id);
      if (accepted) {
        return {
          promptId: p.id,
          outcome: "accepted",
          answer: accepted.canonical,
          tier: accepted.tier,
          score: accepted.score ?? 0,
          attempts: mine.length,
          msToAccept: accepted.clock_ms,
        };
      }
      // Fallback when a submission happened while we were disconnected (eviction gap).
      if (fromGame?.answer && fromGame.score) {
        return {
          promptId: p.id,
          outcome: "accepted",
          answer: fromGame.answer,
          tier: fromGame.tier ?? null,
          score: fromGame.score,
          attempts: mine.length,
          msToAccept: null,
        };
      }
      const reached = mine.length > 0 || fromGame !== undefined || (state?.roundIndex ?? -1) > i;
      return {
        promptId: p.id,
        outcome: reached ? "timed_out" : "not_reached",
        answer: null,
        tier: null,
        score: 0,
        attempts: mine.length,
        msToAccept: null,
      };
    });

    const usage = await this.harness
      .pi()
      .then((pi) => pi.usage(BACKGROUND_CONTEXT))
      .catch(() => undefined);
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    for (const u of Object.values(usage?.models ?? {})) {
      inputTokens += u.input;
      outputTokens += u.output;
      costUsd += u.cost.total;
    }

    const piOutcome = outcome ? (outcome.reason ? `${outcome.status}:${outcome.reason}` : outcome.status) : "unknown";
    const status: RunStatus = classify(reason, outcome?.status, outcome?.reason, subs.length);
    const summary = {
      runId: input.runId,
      day: input.day,
      modelId: input.model.id,
      status,
      error: error === undefined ? (status === "infra_error" ? piOutcome : null) : String(error),
      totalScore: results.reduce((sum, r) => sum + r.score, 0),
      steps: this.ctx.storage.kv.get<number>(STEPS_KEY) ?? 0,
      inputTokens,
      outputTokens,
      costUsd,
      piOutcome,
      selfReport: outcome?.text ?? null,
      results,
    };
    await this.runtime.runPromise(
      writeRunSummary(summary).pipe(
        Effect.catch((e) => markRunStatus(input.runId, "infra_error", `summary write failed: ${String(e)}`)),
      ),
    );
    this.ctx.storage.kv.put(PHASE_KEY, "finalized");

    this.page.disconnect();
    await this.browser.close().catch(() => false);
    await this.env.DAY_COORDINATOR.getByName(input.batch)
      .runFinished(input.runId)
      .catch((e: unknown) => console.error("coordinator notify failed", input.runId, e));
  }
}

/**
 * Model failures are results; failures on our side, the provider's, or the
 * site's are `infra_error` (and get one retry from the coordinator).
 */
function classify(
  reason: FinalizeReason,
  status: string | undefined,
  piReason: string | undefined,
  submissions: number,
): RunStatus {
  if (reason === "complete") return "completed";
  if (reason === "deadline") return "timed_out";
  if (reason === "error") return "infra_error";
  if (status === "done" || piReason === "turn_limit") return "completed";
  if (piReason === "model_error" || piReason === "no_model" || piReason === "interrupted" || piReason === "restart_limit") {
    return submissions === 0 ? "infra_error" : "failed";
  }
  return "failed";
}
