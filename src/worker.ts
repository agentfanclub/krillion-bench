import { handleAdmin } from "./admin";
import { DayCoordinator } from "./coordinator";
import { DiveAgent } from "./agent/DiveAgent";
import { easternNow } from "./clock";
import { leaderboard, makeRuntime } from "./services";

export { DayCoordinator, DiveAgent };

/** Edge-cache the leaderboard: results change once a day, D1 bills per row read. */
const SCORES_TTL_S = 300;
const MAX_DAYS = 90;

export default {
  async scheduled(controller, env, ctx) {
    // Fires at 04:05 and 05:05 UTC; exactly one of them is 00:05 in New York.
    const { date, hour } = easternNow(controller.scheduledTime);
    if (hour !== 0) return;
    ctx.waitUntil(
      env.DAY_COORDINATOR.getByName(date).start({ day: date, trial: false, models: null, createdBy: "cron" }),
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx);

    // GET /api/scores?days=N: ranked results for the last N real days (frontend data).
    if (request.method === "GET" && url.pathname === "/api/scores") {
      const cache = caches.default;
      const hit = await cache.match(request);
      if (hit) return hit;
      const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get("days")) || 30));
      const since = easternNow(Date.now() - days * 86_400_000).date;
      const runtime = makeRuntime(env);
      const results = await runtime.runPromise(leaderboard(since));
      ctx.waitUntil(runtime.dispose());
      const response = new Response(JSON.stringify({ benchmark: "Krillion", since, results }), {
        headers: { "content-type": "application/json", "cache-control": `public, max-age=${SCORES_TTL_S}` },
      });
      ctx.waitUntil(cache.put(request, response.clone()));
      return response;
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
