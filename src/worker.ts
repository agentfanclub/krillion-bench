import { DateTime, Effect } from "effect";
import { DiveAgent } from "./agent/DiveAgent";
import { AppRuntime } from "./App";
import { DayCoordinator } from "./coordinator";
import { eastern } from "./domain";
import { handler } from "./http/server";
import { logRecovered } from "./Logging";
import { Objects } from "./Objects";

export { DayCoordinator, DiveAgent };

/** Fires at 04:05 and 05:05 UTC; exactly one of them is 00:05 in New York. A real day's batch is named by the day. */
const startDailyBatch = Effect.fn("startDailyBatch")(function* (scheduledTime: number) {
  const { day, hour } = eastern(DateTime.makeUnsafe(scheduledTime));
  if (hour !== 0) return;
  yield* (yield* Objects)
    .coordinator(day)
    .start({ day, trial: false, models: null, createdBy: "cron" })
    .pipe(
      Effect.catchTag("RpcError", logRecovered("cron batch start failed")),
      Effect.annotateLogs({ day }),
    );
});

export default {
  scheduled: (controller, _env, ctx) => ctx.waitUntil(AppRuntime.runPromise(startDailyBatch(controller.scheduledTime))),
  fetch: (request) => handler(request),
} satisfies ExportedHandler<Env>;
