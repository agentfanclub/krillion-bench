import { Context, Effect, Layer, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { type Day, KRILLION_ORIGIN, TodayGame } from "./domain";

export class KrillionError extends Schema.TaggedError<KrillionError>()("KrillionError", {
  message: Schema.String,
}) {}

/** The game site's own API. Orchestrator only: the agent only ever sees the UI. */
export class Krillion extends Context.Service<Krillion>()("krillion/Krillion", {
  make: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.acceptJson),
      HttpClient.filterStatusOk,
    );

    const today = client.get(`${KRILLION_ORIGIN}/api/today`).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(TodayGame)),
      Effect.retry({ schedule: Schedule.exponential("1 second"), times: 4 }),
      Effect.mapError((e) => new KrillionError({ message: `GET /api/today: ${e.message}` })),
      Effect.withSpan("Krillion.today"),
    );

    return {
      today,
      /** Today's game, insisting the site has rolled over to `day` (ET). */
      gameFor: Effect.fn("Krillion.gameFor")(function* (day: Day) {
        const game = yield* today;
        if (game.date !== day) return yield* new KrillionError({ message: `site still on ${game.date}, want ${day}` });
        return game;
      }),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer));
}
