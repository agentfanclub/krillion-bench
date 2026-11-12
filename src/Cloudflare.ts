import type { LifecycleJobContext, LifecycleJobs } from "agents/lifecycle";
import { env } from "cloudflare:workers";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";

/** The Worker's bindings, from `cloudflare:workers` (the same object every handler and DO sees). */
export class WorkerEnv extends Context.Service<WorkerEnv, Env>()("krillion/WorkerEnv") {
  static readonly layer = Layer.succeed(WorkerEnv, env);
}

/** One schema-typed key in a Durable Object's synchronous KV storage. */
export interface Stored<Get, Set = Get> {
  readonly get: Effect.Effect<Get>;
  readonly set: (value: Set) => Effect.Effect<void>;
  /** For callbacks outside Effect (Pi factories, Puppeteer events). */
  getUnsafe(): Get;
  setUnsafe(value: Set): void;
}

/**
 * A stored value: `Option` when unset, or `fallback`. Values that don't decode (e.g.
 * written by an incompatible older version) read as unset.
 */
export function stored<S extends Schema.Codec<any, any>>(
  kv: SyncKvStorage,
  key: string,
  schema: S,
): Stored<Option.Option<S["Type"]>, S["Type"]>;
export function stored<S extends Schema.Codec<any, any>>(
  kv: SyncKvStorage,
  key: string,
  schema: S,
  fallback: S["Type"],
): Stored<S["Type"]>;
export function stored<S extends Schema.Codec<any, any>>(
  kv: SyncKvStorage,
  key: string,
  schema: S,
  ...fallback: [] | [S["Type"]]
): Stored<unknown, S["Type"]> {
  const decode = Schema.decodeUnknownOption(schema);
  const encode = Schema.encodeSync(schema);
  const getUnsafe = () => {
    const value = decode(kv.get(key));
    return fallback.length === 0 ? value : Option.getOrElse(value, () => fallback[0]);
  };
  const setUnsafe = (value: S["Type"]) => kv.put(key, encode(value));
  return {
    getUnsafe,
    setUnsafe,
    get: Effect.sync(getUnsafe),
    set: (value) => Effect.sync(() => setUnsafe(value)),
  };
}

/** A job as Lifecycle stores it: the function name it dispatches on, and a JSON payload. */
export interface EncodedJob {
  readonly fn: string;
  readonly payload?: unknown;
}

/**
 * A Durable Object's Lifecycle job queue with schema-typed jobs. A job's id is its
 * `fn`, so pushing a job again replaces the pending one.
 */
export class JobQueue<J extends { readonly fn: string }> {
  constructor(
    private readonly jobs: () => LifecycleJobs,
    private readonly schema: Schema.Codec<J, EncodedJob>,
  ) {}

  readonly push = (job: J, delayMs = 0): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.promise(() => this.jobs().push({ ...Schema.encodeSync(this.schema)(job), id: job.fn, time: now + delayMs })),
    );

  readonly cancel = (fn: J["fn"]): Effect.Effect<void> => Effect.promise(() => this.jobs().cancel(fn));

  /** None for jobs this version doesn't know. */
  decode(context: LifecycleJobContext): Option.Option<J> {
    return Schema.decodeUnknownOption(this.schema)({ fn: context.job.fn, payload: context.job.payload });
  }
}
