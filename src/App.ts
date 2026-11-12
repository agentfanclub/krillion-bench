import type { LifecycleJobContext, LifecycleJobOutcome } from "agents/lifecycle";
import { type Context, Effect, Layer, ManagedRuntime, Option, Scheduler } from "effect";
import { type JobQueue, WorkerEnv } from "./Cloudflare";
import { Database } from "./Database";
import { Krillion } from "./Krillion";
import { LoggerLive } from "./Logging";
import { Objects } from "./Objects";
import { Roster } from "./Roster";

/**
 * Workers may drop timers owned by a finished request, which would strand fibers that
 * outlive it (the shared layer build, background submission writes); Effect recommends
 * the sync scheduler there.
 */
const SchedulerLive = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));

/** Everything the Worker, the coordinator, and the agents run on. */
export const AppLayer = Layer.mergeAll(Database.layer, Roster.layer, Krillion.layer, Objects.layer).pipe(
  Layer.provideMerge(WorkerEnv.layer),
  Layer.provideMerge(LoggerLive),
  Layer.provideMerge(SchedulerLive),
);
export type App = Layer.Success<typeof AppLayer>;

/** One per isolate. The HTTP handler builds its layers through the same `memoMap`. */
export const AppRuntime = ManagedRuntime.make(AppLayer);

export interface DurableObjectRunner<I> {
  /** Run with the app and the object's context service. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, App | I>) => Promise<A>;
  /** An RPC method: start the object's Lifecycle, then run. */
  readonly rpc: <A, E>(effect: Effect.Effect<A, E, App | I>) => Promise<A>;
  /** Lifecycle's job hook: decode the job and run its program; unknown jobs complete. */
  readonly onJob: (context: LifecycleJobContext) => Promise<LifecycleJobOutcome>;
}

/**
 * How a Durable Object runs Effects: the app, its own context service (built per call,
 * since it reads the object's state), its log fields, and its typed job queue.
 */
export const durableObjectRunner = <I, S, J extends { readonly fn: string }>(options: {
  readonly tag: Context.Key<I, S>;
  readonly service: () => S;
  readonly annotations: () => Readonly<Record<string, unknown>>;
  readonly start: () => Promise<void>;
  readonly jobs: JobQueue<J>;
  readonly runJob: (job: J) => Effect.Effect<LifecycleJobOutcome, unknown, App | I>;
}): DurableObjectRunner<I> => {
  const run = <A, E>(effect: Effect.Effect<A, E, App | I>): Promise<A> =>
    AppRuntime.runPromise(
      effect.pipe(Effect.provideService(options.tag, options.service()), Effect.annotateLogs(options.annotations())),
    );
  return {
    run,
    rpc: async (effect) => {
      await options.start();
      return run(effect);
    },
    onJob: (context) =>
      Option.match(options.jobs.decode(context), {
        onNone: () => Promise.resolve(undefined),
        onSome: (job) => run(options.runJob(job)),
      }),
  };
};
