import { Effect, Option } from "effect";
import { AppRuntime } from "./App";
import type { ModelEntry } from "./domain";
import { Objects } from "./Objects";
import { Roster } from "./Roster";

export const migrationPath = "/api/roster-migration-20261120";
const trialName = "2026-11-19#trial-chatgpt-62-migration";
const verifier = "b09a0fae75f6d8281fddc12bd8d993cbdfd85235f2d61da5abe00fc33d5ec186";
const options = { headers: { "cache-control": "no-store" } };
const removed = new Set([
  "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano",
  "gpt-5.1", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.5", "o3",
].map((id) => `openai/${id}`));
const additions: readonly ModelEntry[] = [
  { id: "openai/gpt-6.2-astra", label: "GPT-6.2 Astra", enabled: true, vision: true },
  { id: "openai/gpt-6.2-sol", label: "GPT-6.2 Sol", enabled: true, vision: true },
];

export async function migrateRoster(request: Request): Promise<Response> {
  const bearer = request.headers.get("authorization");
  if (!bearer?.startsWith("Bearer ")) return new Response(null, { status: 404 });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer.slice(7)));
  const expected = Uint8Array.from(verifier.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  if (!crypto.subtle.timingSafeEqual(digest, expected)) return new Response(null, { status: 404 });

  return AppRuntime.runPromise(Effect.gen(function* () {
    const roster = yield* Roster;
    const current = yield* roster.read;
    if (Option.isNone(current)) return Response.json({ error: "Live roster is missing" }, { status: 409 });
    const coordinator = (yield* Objects).coordinator(trialName);
    if (request.method === "GET") {
      return Response.json({ roster: current.value, trial: yield* coordinator.status() }, options);
    }
    if (request.method === "POST") {
      const models = additions.map(({ id }) => id);
      if (!models.every((id) => current.value.models.some((model) => model.id === id && model.enabled))) {
        return Response.json({ error: "GPT-6.2 models are not enabled yet" }, { status: 409 });
      }
      return Response.json(yield* coordinator.start({
        day: null, trial: true, models, createdBy: "subscription rollout",
      }), options);
    }
    if (request.method !== "PUT") return new Response(null, { status: 405 });

    const entries = new Map(current.value.models
      .filter(({ id }) => !removed.has(id))
      .map((model) => [model.id, model] as const));
    for (const model of additions) {
      const existing = entries.get(model.id);
      entries.set(model.id, existing ? { ...existing, enabled: true } : model);
    }
    const models = [...entries.values()];
    if (JSON.stringify(models) !== JSON.stringify(current.value.models)) {
      yield* roster.save({ ...current.value, models });
    }
    return Response.json({ models: models.length }, options);
  })).catch(() => Response.json({ error: "Roster operation failed" }, { status: 500 }));
}
