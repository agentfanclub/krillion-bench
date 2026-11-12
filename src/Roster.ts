import { Context, Effect, Layer, Option, Schema } from "effect";
import { ModelsDoc } from "./domain";
import { WorkerEnv } from "./Cloudflare";

export class RosterError extends Schema.TaggedError<RosterError>()("RosterError", {
  message: Schema.String,
}) {}

const KEY = "models";
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelsDoc));

/** The model roster: KV key `models`, edited in the admin portal, read by every batch. */
export class Roster extends Context.Service<Roster>()("krillion/Roster", {
  make: Effect.gen(function* () {
    const kv = (yield* WorkerEnv).CONFIG;

    const read = Effect.tryPromise({
      try: () => kv.get(KEY, "text"),
      catch: (e) => new RosterError({ message: `KV read failed: ${String(e)}` }),
    }).pipe(
      Effect.flatMap((text) =>
        text === null
          ? Effect.succeedNone
          : decode(text).pipe(
              Effect.map(Option.some),
              Effect.mapError((e) => new RosterError({ message: `invalid roster: ${e.message}` })),
            ),
      ),
      Effect.withSpan("Roster.read"),
    );

    return {
      read,
      /** Enabled entries; a missing roster is an error. */
      enabled: read.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new RosterError({ message: `KV key '${KEY}' is missing` })),
            onSome: (doc) => Effect.succeed(doc.models.filter((m) => m.enabled)),
          }),
        ),
      ),
      // Pretty-printed: people read this key in the dashboard.
      save: (doc: ModelsDoc) =>
        Effect.tryPromise({
          try: () => kv.put(KEY, JSON.stringify(Schema.encodeSync(ModelsDoc)(doc), null, 2)),
          catch: (e) => new RosterError({ message: `KV write failed: ${String(e)}` }),
        }).pipe(Effect.withSpan("Roster.save")),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
