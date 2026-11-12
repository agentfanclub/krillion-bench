import { Context, Effect, Layer, Schema } from "effect";
import type { DiveAgent } from "./agent/DiveAgent";
import { WorkerEnv } from "./Cloudflare";
import type { DayCoordinator } from "./coordinator";
import { RunRow } from "./Database";
import { BatchConfig, type BatchRequest, RunInput } from "./domain";

// ── The Durable Objects' RPC contract. Results are decoded on the caller's side, since
// the Worker and an object can run different versions during a rollout. ─────────────

/** unset → "dispatched" → "finalized" | "failed" */
export const BatchPhase = Schema.Literals(["dispatched", "finalized", "failed"]);
export type BatchPhase = typeof BatchPhase.Type;

export const StartResult = Schema.Struct({ batch: Schema.String, accepted: Schema.Boolean });
export type StartResult = typeof StartResult.Type;

export const BatchStatus = Schema.Struct({
  batch: Schema.String,
  phase: Schema.NullOr(BatchPhase),
  config: Schema.NullOr(BatchConfig),
  runs: Schema.Array(Schema.toType(RunRow)),
});
export type BatchStatus = typeof BatchStatus.Type;

export const RerunResult = Schema.Struct({
  batch: Schema.String,
  launched: Schema.Array(Schema.String),
  /** Requested ids not enabled in the roster. */
  skipped: Schema.Array(Schema.String),
});

/** Null when the batch is not a dispatched real day. */
export const Rerun = Schema.NullOr(RerunResult);
export type Rerun = typeof Rerun.Type;

/** unset → "running" → "finalized" */
export const DivePhase = Schema.Literals(["running", "finalized"]);
export type DivePhase = typeof DivePhase.Type;

export const DiveStart = Schema.Struct({ accepted: Schema.Boolean });
export type DiveStart = typeof DiveStart.Type;

export const AgentStatus = Schema.Struct({
  phase: Schema.NullOr(DivePhase),
  steps: Schema.Number,
  input: Schema.NullOr(RunInput),
});
export type AgentStatus = typeof AgentStatus.Type;

export class RpcError extends Schema.TaggedError<RpcError>()("RpcError", {
  method: Schema.String,
  message: Schema.String,
}) {}

/** DO name of one attempt of one model in one batch. */
export const diveName = (batch: string, modelId: string, attempt: number) => `${batch}|${modelId}|${attempt}`;

const call = <S extends Schema.Codec<any, any>>(
  method: string,
  result: S,
  f: () => Promise<unknown>,
): Effect.Effect<S["Type"], RpcError> =>
  Effect.tryPromise({ try: f, catch: (e) => new RpcError({ method, message: String(e) }) }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(result)(value).pipe(
        Effect.mapError((e) => new RpcError({ method, message: `unexpected result: ${e.message}` })),
      ),
    ),
    Effect.withSpan(method),
  );

/**
 * The Durable Objects, as Effects: a batch's `DayCoordinator` (named by the batch) and a
 * run's `DiveAgent` (named by `diveName`).
 */
export class Objects extends Context.Service<Objects>()("krillion/Objects", {
  make: Effect.gen(function* () {
    const env = yield* WorkerEnv;
    return {
      coordinator: (batch: string) => {
        const stub: DurableObjectStub<DayCoordinator> = env.DAY_COORDINATOR.getByName(batch);
        return {
          start: (request: BatchRequest) => call("DayCoordinator.start", StartResult, () => stub.start(request)),
          status: () => call("DayCoordinator.status", BatchStatus, () => stub.status()),
          rerun: (modelIds: ReadonlyArray<string>) => call("DayCoordinator.rerun", Rerun, () => stub.rerun(modelIds)),
          runFinished: (runId: string) => call("DayCoordinator.runFinished", Schema.Void, () => stub.runFinished(runId)),
        };
      },
      dive: (name: string) => {
        const stub: DurableObjectStub<DiveAgent> = env.DIVE_AGENT.getByName(name);
        return {
          start: (input: RunInput) => call("DiveAgent.start", DiveStart, () => stub.start(input)),
          abort: () => call("DiveAgent.abort", Schema.Void, () => stub.abort()),
          status: () => call("DiveAgent.status", AgentStatus, () => stub.status()),
          transcript: () => call("DiveAgent.transcript", Schema.Unknown, () => stub.transcript()),
        };
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
