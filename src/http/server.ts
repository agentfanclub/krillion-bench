import { waitUntil } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Cause, Clock, Context, DateTime, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import { modelCatalog } from "../agent/gateway";
import { AppLayer, AppRuntime } from "../App";
import { WorkerEnv } from "../Cloudflare";
import { Database } from "../Database";
import { eastern, easternToday } from "../domain";
import { Objects } from "../Objects";
import { Roster } from "../Roster";
import { AdminAuth, AdminEmail, Api, BadRequest, Conflict, EdgeCache, Forbidden, RequestErrors } from "./Api";

const SCORES_TTL_S = 300;
const DEFAULT_DAYS = 30;

/** The admin's email for a Cloudflare Access token, or `Forbidden`. */
class AccessVerifier extends Context.Service<AccessVerifier, (token: string) => Effect.Effect<string, Forbidden>>()(
  "krillion/http/AccessVerifier",
) {
  static readonly layer = Layer.effect(
    AccessVerifier,
    Effect.gen(function* () {
      const env = yield* WorkerEnv;
      // Read on first use, so a broken Access setting fails the admin routes only, not the leaderboard.
      const access = yield* Effect.cached(
        Effect.sync(() => ({
          allowed: env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase()),
          jwks: createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)),
        })),
      );
      const forbidden = new Forbidden({ error: "forbidden" });
      return Effect.fn("AccessVerifier")(function* (token: string) {
        if (token === "") return yield* forbidden;
        const { allowed, jwks } = yield* access;
        const { payload } = yield* Effect.tryPromise({
          try: () => jwtVerify(token, jwks, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD }),
          catch: () => forbidden,
        });
        const email = Schema.decodeUnknownOption(Schema.String)(payload.email);
        if (Option.isNone(email) || !allowed.includes(email.value.toLowerCase())) return yield* forbidden;
        return email.value;
      });
    }),
  );
}

const AdminAuthLive = Layer.effect(
  AdminAuth,
  Effect.gen(function* () {
    const verify = yield* AccessVerifier;
    return AdminAuth.of({
      access: (httpEffect, { credential }) =>
        verify(Redacted.value(credential)).pipe(
          Effect.flatMap((email) => Effect.provideService(httpEffect, AdminEmail, email)),
          Effect.map(HttpServerResponse.setHeader("cache-control", "no-store")),
        ),
    });
  }),
);

const EdgeCacheLive = Layer.succeed(EdgeCache)((httpEffect) =>
  Effect.gen(function* () {
    const request = yield* Effect.orDie(HttpServerRequest.toWeb(yield* HttpServerRequest.HttpServerRequest));
    const hit = yield* Effect.promise(() => caches.default.match(request));
    if (hit !== undefined) return HttpServerResponse.fromWeb(hit);
    const response = HttpServerResponse.toWeb(
      HttpServerResponse.setHeader(yield* httpEffect, "cache-control", `public, max-age=${SCORES_TTL_S}`),
    );
    if (response.ok) waitUntil(caches.default.put(request, response.clone()));
    return HttpServerResponse.fromWeb(response);
  }),
);

const PublicHandlers = HttpApiBuilder.group(
  Api,
  "public",
  Effect.fn(function* (handlers) {
    const db = yield* Database;
    return handlers.handle("scores", ({ query }) =>
      Effect.gen(function* () {
        const since = eastern(DateTime.subtract(yield* DateTime.now, { days: query.days ?? DEFAULT_DAYS })).day;
        const results = yield* Effect.orDie(db.leaderboard(since));
        return { benchmark: "Krillion" as const, since, results };
      }),
    );
  }),
);

const AdminHandlers = HttpApiBuilder.group(
  Api,
  "admin",
  Effect.fn(function* (handlers) {
    const roster = yield* Roster;
    const db = yield* Database;
    const objects = yield* Objects;

    return handlers
      .handle("me", () => AdminEmail.useSync((email) => ({ email })))
      .handle("roster", () =>
        roster.read.pipe(
          Effect.map(Option.getOrElse(() => ({ version: 1 as const, models: [] }))),
          Effect.catchTag("RosterError", (e) => Effect.fail(new Conflict({ error: e.message }))),
        ),
      )
      .handle("saveRoster", ({ payload }) => roster.save(payload).pipe(Effect.as(payload), Effect.orDie))
      .handle("catalog", () => modelCatalog)
      .handle("startRun", ({ payload }) =>
        Effect.gen(function* () {
          const createdBy = yield* AdminEmail;
          const today = yield* easternToday;
          if (payload.kind === "day") {
            const day = payload.day ?? today;
            return yield* objects.coordinator(day).start({ day, trial: false, models: null, createdBy });
          }
          // Trials are their own batch, never ranked.
          const batch = `${today}#trial-${yield* Clock.currentTimeMillis}`;
          const models = payload.models?.length ? payload.models : null;
          return yield* objects.coordinator(batch).start({ day: null, trial: true, models, createdBy });
        }).pipe(Effect.orDie),
      )
      .handle("rerun", ({ payload }) =>
        objects
          .coordinator(payload.day)
          .rerun(payload.models)
          .pipe(
            Effect.orDie,
            Effect.flatMap((rerun) =>
              rerun === null
                ? Effect.fail(new Conflict({ error: `batch ${payload.day} is not a dispatched real day` }))
                : Effect.succeed(rerun),
            ),
          ),
      )
      .handle("batches", () => Effect.orDie(db.recentBatches(30)))
      .handle("batch", ({ query }) => Effect.orDie(objects.coordinator(query.name).status()))
      .handle("agent", ({ query }) => Effect.orDie(objects.dive(query.name).status()))
      .handle("transcript", ({ query }) => Effect.orDie(objects.dive(query.name).transcript()));
  }),
);

/** The static file for a request (from public/). */
const asset = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const env = yield* WorkerEnv;
    const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));
    return HttpServerResponse.fromWeb(yield* Effect.promise(() => env.ASSETS.fetch(web)));
  });

/**
 * Static files on the paths the Worker sees first: `/admin` and public/admin/ behind the
 * same Access check as the API (`/admin/*` also matches `/admin`), and any other
 * `/api/*` GET as the asset server would answer it.
 */
const StaticRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const verify = yield* AccessVerifier;
    const admin = (request: HttpServerRequest.HttpServerRequest) =>
      verify(request.headers["cf-access-jwt-assertion"] ?? "").pipe(
        Effect.andThen(asset(request)),
        Effect.catchTag("Forbidden", (e) => Effect.succeed(HttpServerResponse.text(e.error, { status: 403 }))),
      );
    return Layer.mergeAll(HttpRouter.add("GET", "/admin/*", admin), HttpRouter.add("GET", "/api/*", asset));
  }),
);

// Failing to encode our own response (`Body`, `ResponseHeaders`) stays a 500.
const RequestErrorsLive = HttpApiMiddleware.layerSchemaErrorTransform(RequestErrors, (e) =>
  e.kind === "Body" || e.kind === "ResponseHeaders"
    ? Effect.fail(e)
    : Effect.fail(new BadRequest({ error: `${e.kind}: ${e.cause.message}` })),
);

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([PublicHandlers, AdminHandlers]),
  Layer.provide([AdminAuthLive, EdgeCacheLive, RequestErrorsLive]),
);

/** Unmatched routes and client disconnects are answered (404, 499), not failures worth an error log. */
const isRoutine = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterruptsOnly(cause) ||
  Result.match(Cause.findError(cause), {
    onFailure: () => false,
    onSuccess: (e) => HttpServerError.isHttpServerError(e) && e.reason._tag === "RouteNotFound",
  });

export const { handler } = HttpRouter.toWebHandler(
  Layer.mergeAll(ApiLive, StaticRoutes).pipe(
    Layer.provide(AccessVerifier.layer),
    // Merged so request fibers log through the app's logger too.
    Layer.provideMerge(AppLayer),
    Layer.provide(HttpServer.layerServices),
  ),
  {
    memoMap: AppRuntime.memoMap,
    disableLogger: true,
    middleware: Effect.tapCause((cause) => (isRoutine(cause) ? Effect.void : Effect.logError("request failed", cause))),
  },
);
