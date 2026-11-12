import { Context, Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSecurity } from "effect/http-api";
import { CatalogEntry } from "../agent/gateway";
import { AgentStatus, BatchStatus, RerunResult, StartResult } from "../Objects";
import { BatchRow, LeaderboardEntry } from "../Database";
import { Day, ModelsDoc } from "../domain";

// Errors carry `error`: the admin page shows `body.error`.
export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { error: Schema.String },
  { httpApiStatus: 400 },
) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { error: Schema.String },
  { httpApiStatus: 403 },
) {}
export class Conflict extends Schema.TaggedError<Conflict>()("Conflict", { error: Schema.String }, { httpApiStatus: 409 }) {}

/** The signed-in admin, provided by `AdminAuth`. */
export class AdminEmail extends Context.Service<AdminEmail, string>()("krillion/http/AdminEmail") {}

/**
 * Cloudflare Access (app "krillion-bench admin", path `<host>/admin`) gates `/admin*` at
 * the edge. The Worker checks again, so a misconfigured or deleted Access app fails
 * closed: a valid Access token for this app's AUD and an email in ADMIN_EMAILS.
 */
export class AdminAuth extends HttpApiMiddleware.Service<AdminAuth, { provides: AdminEmail }>()(
  "krillion/http/AdminAuth",
  {
    error: Forbidden,
    security: { access: HttpApiSecurity.apiKey({ key: "cf-access-jwt-assertion", in: "header" }) },
  },
) {}

/** Edge-cache the response: results change once a day, D1 bills per row read. */
export class EdgeCache extends HttpApiMiddleware.Service<EdgeCache>()("krillion/http/EdgeCache") {}

/** Request decoding failures as `BadRequest`, so the admin page can show why. */
export class RequestErrors extends HttpApiMiddleware.Service<RequestErrors>()("krillion/http/RequestErrors", {
  error: BadRequest,
}) {}

export class PublicApi extends HttpApiGroup.make("public").add(
  // Ranked results for the last `days` real days (frontend data).
  HttpApiEndpoint.get("scores", "/api/scores", {
    query: { days: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 }))) },
    success: Schema.Struct({
      benchmark: Schema.Literal("Krillion"),
      since: Day,
      results: Schema.Array(LeaderboardEntry),
    }),
  }).middleware(EdgeCache),
) {}

export class AdminApi extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.get("me", "/me", { success: Schema.Struct({ email: Schema.String }) }),
    // Roster: the KV document every batch reads. Saved whole after validation. A stored
    // roster that doesn't decode is a 409 that says why (the page then refuses to save over it).
    HttpApiEndpoint.get("roster", "/models", { success: ModelsDoc, error: Conflict }),
    HttpApiEndpoint.put("saveRoster", "/models", { payload: ModelsDoc, success: ModelsDoc }),
    HttpApiEndpoint.get("catalog", "/catalog", { success: Schema.Array(CatalogEntry) }),
    // A trial plays today's game and is never ranked; a day run is the batch the cron
    // would start for that ET date (no-op if it already ran).
    HttpApiEndpoint.post("startRun", "/runs", {
      payload: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("trial"), models: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))) }),
        Schema.Struct({ kind: Schema.Literal("day"), day: Schema.optional(Day) }),
      ]),
      success: StartResult,
    }),
    // Re-play a real day for chosen models (after fixing their config); re-ranks the day.
    HttpApiEndpoint.post("rerun", "/reruns", {
      payload: Schema.Struct({ day: Day, models: Schema.NonEmptyArray(Schema.String) }),
      success: RerunResult,
      error: Conflict,
    }),
    HttpApiEndpoint.get("batches", "/batches", { success: Schema.Array(Schema.toType(BatchRow)) }),
    HttpApiEndpoint.get("batch", "/batch", { query: { name: Schema.String }, success: BatchStatus }),
    HttpApiEndpoint.get("agent", "/agent", { query: { name: Schema.String }, success: AgentStatus }),
    // Pi's transcript, for debugging.
    HttpApiEndpoint.get("transcript", "/agent/transcript", { query: { name: Schema.String }, success: Schema.Unknown }),
  )
  .middleware(AdminAuth)
  .prefix("/admin/api") {}

export class Api extends HttpApi.make("krillion-bench").add(PublicApi).add(AdminApi).middleware(RequestErrors) {}
