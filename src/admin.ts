import { createRemoteJWKSet, jwtVerify } from "jose";
import { Effect, Schema } from "effect";
import { easternNow } from "./clock";
import { ModelsDoc } from "./domain";
import { makeRuntime, recentBatches, ROSTER_KEY } from "./services";

/**
 * Admin portal: `/admin` (page, from public/admin/) and `/admin/api/*`.
 *
 * Cloudflare Access (app "krillion-bench admin", path `<host>/admin`) gates these at
 * the edge. The Worker checks again, so a misconfigured or deleted Access app fails
 * closed: it requires a valid Access token for this app's AUD and an email in
 * ADMIN_EMAILS.
 */

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

async function adminEmail(request: Request, env: Env, ctx: ExecutionContext): Promise<string | undefined> {
  const allowed = env.ADMIN_EMAILS.split(",").map((e) => e.trim().toLowerCase());
  let email: string | undefined;
  if (ctx.access && ctx.access.aud === env.ACCESS_AUD) {
    email = (await ctx.access.getIdentity())?.email;
  } else {
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) return undefined;
    jwks ??= createRemoteJWKSet(new URL(`${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    try {
      const { payload } = await jwtVerify(token, jwks, { issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
      email = typeof payload.email === "string" ? payload.email : undefined;
    } catch {
      return undefined;
    }
  }
  return email && allowed.includes(email.toLowerCase()) ? email : undefined;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const RunRequest = Schema.Struct({
  kind: Schema.Literals(["trial", "day"]),
  models: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  day: Schema.optional(Schema.String),
});

export async function handleAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const email = await adminEmail(request, env, ctx);
  if (!email) return new Response("forbidden", { status: 403 });

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/admin/api/")) return env.ASSETS.fetch(request);
  const route = `${request.method} ${url.pathname.slice("/admin/api".length)}`;

  switch (route) {
    case "GET /me":
      return json({ email });

    // Roster: the KV document the cron reads. Saved whole after validation.
    case "GET /models": {
      const doc = await env.CONFIG.get(ROSTER_KEY, "json");
      return json(doc ?? { version: 1, models: [] });
    }
    case "PUT /models": {
      const decoded = Schema.decodeUnknownExit(ModelsDoc)(await request.json().catch(() => null));
      if (decoded._tag === "Failure") return json({ error: `invalid roster: ${String(decoded.cause)}` }, 400);
      const ids = decoded.value.models.map((m) => m.id);
      if (new Set(ids).size !== ids.length) return json({ error: "duplicate model id" }, 400);
      await env.CONFIG.put(ROSTER_KEY, JSON.stringify(decoded.value, null, 2));
      return json(decoded.value);
    }

    // Workers AI text-generation models, for the "add model" picker.
    case "GET /catalog": {
      const models = await env.AI.models({ task: "Text Generation", per_page: 500 });
      // Property values arrive as strings or JSON booleans depending on the property.
      const prop = (m: AiModelsSearchObject, id: string): unknown =>
        m.properties.find((p) => p.property_id === id)?.value;
      const flag = (m: AiModelsSearchObject, id: string) => String(prop(m, id)) === "true";
      return json(
        models
          .map((m) => ({
            id: m.name,
            description: m.description,
            functionCalling: flag(m, "function_calling"),
            vision: flag(m, "vision"),
            reasoning: flag(m, "reasoning"),
            deprecates: (prop(m, "planned_deprecation_date") as string | undefined) ?? null,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    }

    // Manual runs. A trial plays today's game and is never ranked; a day run is the
    // same batch the cron would start for that ET date (no-op if it already ran).
    case "POST /runs": {
      const decoded = Schema.decodeUnknownExit(RunRequest)(await request.json().catch(() => null));
      if (decoded._tag === "Failure") return json({ error: "body must be {kind: 'trial'|'day', models?, day?}" }, 400);
      const { kind, models, day } = decoded.value;
      const today = easternNow(Date.now()).date;
      if (kind === "trial") {
        const batch = `${today}#trial-${Date.now()}`;
        return json(
          await env.DAY_COORDINATOR.getByName(batch).start({
            day: null,
            trial: true,
            models: models?.length ? models : null,
            createdBy: email,
          }),
        );
      }
      const target = day ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return json({ error: "day must be YYYY-MM-DD" }, 400);
      return json(
        await env.DAY_COORDINATOR.getByName(target).start({ day: target, trial: false, models: null, createdBy: email }),
      );
    }

    case "GET /batches": {
      const runtime = makeRuntime(env);
      const rows = await runtime.runPromise(recentBatches(30).pipe(Effect.map((r) => [...r])));
      ctx.waitUntil(runtime.dispose());
      return json(rows);
    }
    case "GET /batch": {
      const name = url.searchParams.get("name");
      if (!name) return json({ error: "name required" }, 400);
      return json(await env.DAY_COORDINATOR.getByName(name).status());
    }
    case "GET /agent": {
      const name = url.searchParams.get("name");
      if (!name) return json({ error: "name required" }, 400);
      const agent = env.DIVE_AGENT.getByName(name);
      return json(url.searchParams.has("transcript") ? await agent.transcript() : await agent.status());
    }
    default:
      return json({ error: "not found" }, 404);
  }
}
