import type { Api, Model } from "@earendil-works/pi-ai";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { type AI, createAI } from "agents/models/pi-ai";
import { Effect, Option, Predicate, Schema } from "effect";
import type { App } from "../App";
import { WorkerEnv } from "../Cloudflare";
import { clip, logRecovered } from "../Logging";

/**
 * The AI binding as DiveAgent uses it: every model call goes through here, so this is
 * where provider failures are logged (with the gateway log id to look them up), and
 * where Gemini is made to work.
 *
 * Gemini through AI Gateway (`google-ai-studio`, BYOK key on the gateway):
 * `agents/models/pi-ai` routes only Anthropic/OpenAI wire formats to the gateway, so
 * Gemini goes over Google's OpenAI-compatible endpoint. Two gaps in that endpoint are
 * patched on the gateway fetch:
 * - Gemini 3+ rejects a tool-call turn replayed without its `thought_signature`
 *   (`extra_content.google`), which Pi's chat-completions converter drops. Signatures
 *   are captured from responses by tool-call id and put back on requests; a call whose
 *   signature was lost (isolate restart) gets Google's documented skip value.
 * - Streamed tool-call deltas carry no `index`, so parallel calls would merge into one.
 */

/** Roster ids `google/<model>`; Pi AI's Google catalog supplies cost/limits. */
const GOOGLE_PREFIX = "google/";
const OPENAI_COMPAT_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const SKIP_SIGNATURE = "skip_thought_signature_validator";
const MAX_SIGNATURES = 10_000;

const googleCatalog: ReadonlyArray<Model<Api>> = Object.values(GOOGLE_MODELS);

/**
 * Gemini models Google serves that Pi AI's catalog doesn't list yet, with limits from
 * Google's `models.get`. Pricing is not published there, so cost is recorded as 0.
 */
const GOOGLE_EXTRA: Readonly<Record<string, { name: string; contextWindow: number; maxTokens: number }>> = {
  "gemini-4-carbon": { name: "Gemini 4 Carbon", contextWindow: 1_048_576, maxTokens: 32_768 },
};

/**
 * AI Gateway catalog models Pi AI 1.5.2 doesn't list yet, as a copy of the nearest
 * listed sibling (same wire format, thinking compat and price) under the vendor's id.
 * Sent over the provider-native path, so the gateway's BYOK key pays.
 */
const CATALOG_EXTRA: Readonly<Record<string, { base: string; vendorId: string; name: string }>> = {
  "anthropic/claude-fable-5.2": { base: "claude-fable-5-1", vendorId: "claude-fable-5-2", name: "Claude Fable 5.2" },
};

/** The Pi model for a roster id: Gemini and catalog extras built here, everything else by `ai(id)`. */
export function rosterModel(ai: AI, id: string): Model<Api> {
  const extra = CATALOG_EXTRA[id];
  if (extra) {
    const base = Object.values(CLOUDFLARE_AI_GATEWAY_MODELS).find((m) => m.id === extra.base);
    if (!base) throw new TypeError(`base model "${extra.base}" for "${id}" is missing from Pi AI's gateway catalog`);
    return ai({ ...base, id: extra.vendorId, name: extra.name, provider: "cloudflare" });
  }
  if (!id.startsWith(GOOGLE_PREFIX)) return ai(id);
  const vendorId = id.slice(GOOGLE_PREFIX.length);
  const route = { api: "openai-completions", baseUrl: OPENAI_COMPAT_BASE, provider: "cloudflare" } as const;
  const entry = googleCatalog.find((m) => m.id === vendorId);
  if (entry) {
    const { compat: _compat, ...rest } = entry;
    return ai({ ...rest, ...route });
  }
  const google = GOOGLE_EXTRA[vendorId];
  if (!google) throw new TypeError(`"${id}" is not in Pi AI's Google catalog or GOOGLE_EXTRA`);
  return ai({
    id: vendorId,
    ...google,
    ...route,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
}

/** One pickable model in the admin portal's "add model" list. */
export const CatalogEntry = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["workers-ai", "ai-gateway"]),
  description: Schema.String,
  functionCalling: Schema.Boolean,
  vision: Schema.Boolean,
  reasoning: Schema.Boolean,
  deprecates: Schema.NullOr(Schema.String),
});
export type CatalogEntry = typeof CatalogEntry.Type;

/**
 * The admin portal's "add model" list: Workers AI text-generation models, plus the
 * Anthropic, OpenAI and Google models routed through the AI Gateway (BYOK keys on the gateway).
 */
export const modelCatalog = Effect.gen(function* () {
  const env = yield* WorkerEnv;
  const models = yield* Effect.promise(() => env.AI.models({ task: "Text Generation", per_page: 500 }));
  // Property values arrive as strings or JSON booleans depending on the property.
  const prop = (m: AiModelsSearchObject, id: string) => m.properties.find((p) => p.property_id === id)?.value;
  const flag = (m: AiModelsSearchObject, id: string) => String(prop(m, id)) === "true";
  const workersAi = models.map(
    (m): CatalogEntry => ({
      id: m.name,
      source: "workers-ai",
      description: m.description,
      functionCalling: flag(m, "function_calling"),
      vision: flag(m, "vision"),
      reasoning: flag(m, "reasoning"),
      deprecates: Option.getOrNull(Schema.decodeUnknownOption(Schema.String)(prop(m, "planned_deprecation_date"))),
    }),
  );
  const byok = (id: string, m: Model<Api>): CatalogEntry => ({
    id,
    source: "ai-gateway",
    description: `${m.name} · $${m.cost.input}/$${m.cost.output} per M tokens · BYOK`,
    functionCalling: true,
    vision: m.input.includes("image"),
    reasoning: m.reasoning,
    deprecates: null,
  });
  const gateway = createAI({ binding: env.AI, id: env.AI_GATEWAY })
    .provider.getModels()
    .filter((m) => /^(anthropic|openai)\//.test(m.id))
    .map((m) => byok(m.id, m));
  const google = googleCatalog.map((m) => byok(`${GOOGLE_PREFIX}${m.id}`, m));
  return [...workersAi, ...gateway, ...google].sort((a, b) => a.id.localeCompare(b.id));
});

// ── Wire formats (only the fields touched here; everything else is preserved) ──

/** A JSON object with these fields; every other key passes through untouched. */
const Open = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)]);

const ToolCall = Open({
  id: Schema.optional(Schema.String),
  index: Schema.optional(Schema.Number),
  extra_content: Schema.optional(Open({ google: Schema.optional(Open({ thought_signature: Schema.optional(Schema.String) })) })),
});
type ToolCall = typeof ToolCall.Type;

/** Request body as Pi's chat-completions wire builds it. */
const ChatRequest = Open({
  model: Schema.optional(Schema.String),
  messages: Schema.Array(Open({ role: Schema.optional(Schema.String), tool_calls: Schema.optional(Schema.Array(ToolCall)) })),
});

/**
 * One streamed SSE `data:` payload, across the vendors' formats: chat-completions
 * chunks, and the error events OpenAI Responses (`error`, `response.failed`) and
 * Anthropic Messages (`error`) send inside an HTTP 200 stream.
 */
const StreamEvent = Open({
  type: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Unknown),
  response: Schema.optional(Open({ error: Schema.optional(Schema.Unknown), incomplete_details: Schema.optional(Schema.Unknown) })),
  choices: Schema.optional(
    Schema.Array(Open({ delta: Schema.optional(Open({ tool_calls: Schema.optional(Schema.Array(ToolCall)) })) })),
  ),
});
type StreamEvent = typeof StreamEvent.Type;

/** A provider error as vendors shape it: `{message, code}` / `{message, type}`. */
const ShapedError = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(Schema.Unknown),
  type: Schema.optional(Schema.Unknown),
});
const WrappedError = Schema.Struct({ error: Schema.Unknown });
const StatusError = Schema.Struct({ status: Schema.Number });

const decodeChatRequest = Schema.decodeUnknownOption(Schema.fromJsonString(ChatRequest));
const decodeStreamEvent = Schema.decodeUnknownOption(Schema.fromJsonString(StreamEvent));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const signatures = new Map<string, string>();

function remember(id: string, signature: string): void {
  if (signatures.size >= MAX_SIGNATURES) {
    const oldest = signatures.keys().next().value;
    if (oldest !== undefined) signatures.delete(oldest);
  }
  signatures.set(id, signature);
}

const withSignature = (call: ToolCall, thought_signature: string): ToolCall => ({
  ...call,
  extra_content: { google: { thought_signature } },
});

/** Put signatures back on replayed assistant tool calls. Google validates the first call of each step only. */
const patchGeminiRequest = Effect.fnUntraced(function* (body: string) {
  const request = decodeChatRequest(body);
  if (Option.isNone(request)) {
    yield* Effect.logWarning("gemini request body not patched: not a chat-completions body").pipe(
      Effect.annotateLogs({ body: clip(body, 500) }),
    );
    return body;
  }
  const messages = [];
  for (const message of request.value.messages) {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      messages.push(message);
      continue;
    }
    const calls = message.tool_calls.map((call) => {
      const known = call.id === undefined ? undefined : signatures.get(call.id);
      return known === undefined ? call : withSignature(call, known);
    });
    const [first, ...rest] = calls;
    if (first !== undefined && !calls.some((c) => c.extra_content?.google?.thought_signature)) {
      yield* Effect.logWarning("gemini thought signature missing, sent skip value").pipe(
        Effect.annotateLogs({ toolCallIds: calls.map((c) => c.id) }),
      );
      messages.push({ ...message, tool_calls: [withSignature(first, SKIP_SIGNATURE), ...rest] });
    } else {
      messages.push({ ...message, tool_calls: calls });
    }
  }
  return JSON.stringify({ ...request.value, messages });
});

/** The provider error inside a stream event, if it is one. */
function streamError(event: StreamEvent): unknown {
  if (event.type === "error" || event.error != null) return event.error ?? event;
  if (event.type === "response.failed") return event.response?.error ?? event.response;
  if (event.type === "response.incomplete") return event.response?.incomplete_details ?? event.response;
  return undefined;
}

/** A provider error's own message, from `{message, code}`, `{error: {message}}`, or Google's `[{error: {...}}]`. */
function providerMessage(error: unknown): string | undefined {
  const first = Array.isArray(error) ? error[0] : error;
  if (Predicate.isString(first)) return first;
  const shaped = Schema.decodeUnknownOption(ShapedError)(first);
  if (Option.isSome(shaped)) {
    const code = shaped.value.code ?? shaped.value.type;
    return code == null ? shaped.value.message : `${String(code)}: ${shaped.value.message}`;
  }
  const wrapped = Schema.decodeUnknownOption(WrappedError)(first);
  return Option.isSome(wrapped) ? providerMessage(wrapped.value.error) : undefined;
}

/** Rate limits as OpenAI (`rate_limit_exceeded`), Anthropic (`rate_limit_error`) and Google (`RESOURCE_EXHAUSTED`) spell them. */
const isRateLimit = (error: unknown): boolean =>
  /rate_limit|RESOURCE_EXHAUSTED/.test(Predicate.isString(error) ? error : (JSON.stringify(error) ?? ""));

/** What the run wrapping the binding supplies. */
export interface GatewayHooks {
  /** Runs this wrapper's Effects (logging) the way the owning object runs its own, with its log fields. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, App>) => Promise<A>;
  /**
   * A provider's own error message, as it arrives (Pi's message for these is often
   * generic), and whether it was a rate limit (HTTP 429 or the vendor's rate-limit code).
   */
  readonly onProviderError: (message: string, rateLimited: boolean) => void;
}

/** The AI binding also proxies AI Gateway over `fetch` (what `agents` uses); the type omits it. */
type GatewayAi = Ai & { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };

/**
 * The AI binding with every model call logged on failure and Gemini requests patched.
 *
 * Two paths reach a provider: `run` (Workers AI, and the gateway catalog's Anthropic and
 * OpenAI models, returning a raw `Response`) and `fetch` (provider-native gateway path:
 * Gemini and any other model object). Both are watched the same way.
 */
export function gatewayBinding(ai: Ai, { run, onProviderError }: GatewayHooks): Ai {
  const binding = ai as GatewayAi;

  /**
   * Pass an SSE stream through line by line: log provider error events, and for Gemini
   * capture thought signatures and number tool calls.
   */
  const watchStream = (body: ReadableStream<Uint8Array>, gemini: boolean, fields: Record<string, unknown>) => {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const indexOf = new Map<string, number>();
    let buffer = "";

    const handleLine = (line: string): string => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") return line;
      // Error events are rare; only parse what can be one, unless Gemini needs patching.
      if (!gemini && !data.includes('"error"') && !data.includes("response.incomplete")) return line;
      const decoded = decodeStreamEvent(data);
      if (Option.isNone(decoded)) return line;
      const event = decoded.value;
      const error = streamError(event);
      if (error !== undefined) {
        const message = providerMessage(error);
        void run(
          Effect.logError("ai gateway stream error event").pipe(
            Effect.annotateLogs({ ...fields, eventType: event.type, providerMessage: message, providerError: error }),
          ),
        );
        if (message) onProviderError(message, isRateLimit(error));
      }
      if (!gemini || event.choices === undefined) return line;
      const choices = event.choices.map((choice) => {
        const calls = choice.delta?.tool_calls;
        if (calls === undefined) return choice;
        const numbered = calls.map((call) => {
          if (call.id === undefined) return call;
          const signature = call.extra_content?.google?.thought_signature;
          if (signature) remember(call.id, signature);
          if (call.index !== undefined) return call;
          if (!indexOf.has(call.id)) indexOf.set(call.id, indexOf.size);
          return { ...call, index: indexOf.get(call.id) };
        });
        return { ...choice, delta: { ...choice.delta, tool_calls: numbered } };
      });
      return `data: ${JSON.stringify({ ...event, choices })}`;
    };

    return body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(bytes, controller) {
          buffer += decoder.decode(bytes, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.map(handleLine).join("\n")}\n`));
        },
        flush(controller) {
          buffer += decoder.decode();
          if (buffer !== "") controller.enqueue(encoder.encode(handleLine(buffer)));
        },
      }),
    );
  };

  /** Log a failed response with its body; watch a stream for in-band error events. */
  const inspect = Effect.fnUntraced(function* (response: Response, fields: Record<string, unknown>, gemini: boolean) {
    const withResponse = {
      ...fields,
      status: response.status,
      gatewayLogId: response.headers.get("cf-aig-log-id") ?? binding.aiGatewayLogId ?? undefined,
    };
    if (!response.ok) {
      const text = yield* Effect.promise(() =>
        response
          .clone()
          .text()
          .catch((e: unknown) => `<unreadable body: ${String(e)}>`),
      );
      const message = providerMessage(Option.getOrUndefined(decodeJson(text))) ?? `HTTP ${response.status}: ${clip(text, 300)}`;
      yield* Effect.logError("ai gateway request failed").pipe(
        Effect.annotateLogs({
          status: response.status,
          gatewayLogId: withResponse.gatewayLogId,
          retryAfter: response.headers.get("retry-after") ?? undefined,
          providerMessage: message,
          responseBody: clip(text),
        }),
      );
      onProviderError(`HTTP ${response.status} ${message}`, response.status === 429 || isRateLimit(text));
      return response;
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
    return new Response(watchStream(response.body, gemini, withResponse), response);
  });

  const fetchLogged = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = Predicate.isString(input) ? input : input instanceof URL ? input.href : input.url;
    // `…/ai-gateway/gateways/<id>/<provider>/<endpoint>`
    const [, provider, endpoint] = /\/ai-gateway\/gateways\/[^/]+\/([^/]+)\/([^?]*)/.exec(url) ?? [];
    const gemini = provider === "google-ai-studio";
    const rawBody = Predicate.isString(init?.body) ? init.body : undefined;
    const requestModel = rawBody === undefined ? undefined : Option.getOrUndefined(decodeChatRequest(rawBody))?.model;
    const fields = { path: "fetch", provider, endpoint, requestModel };
    return run(
      Effect.gen(function* () {
        const body = gemini && rawBody !== undefined ? yield* patchGeminiRequest(rawBody) : init?.body;
        // Fail with the binding's own error, so Pi sees exactly what it would without this wrapper.
        const response = yield* Effect.tryPromise({ try: () => binding.fetch(input, { ...init, body }), catch: (e) => e }).pipe(
          Effect.tapError(logRecovered("ai gateway request threw")),
        );
        return yield* inspect(response, fields, gemini);
      }).pipe(Effect.withLogSpan("duration"), Effect.annotateLogs(fields)),
    );
  };

  const runLogged = (...args: Parameters<Ai["run"]>): Promise<unknown> => {
    const requestModel = String(args[0]);
    const provider = requestModel.startsWith("@cf/") ? "workers-ai" : requestModel.split("/")[0];
    const fields = { path: "run", provider, requestModel };
    return run(
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          try: (): Promise<unknown> => binding.run(...args),
          catch: (e) => e,
        }).pipe(
          Effect.tapError((e) => {
            const message = e instanceof Error ? e.message : String(e);
            const status = Option.getOrUndefined(Schema.decodeUnknownOption(StatusError)(e))?.status;
            onProviderError(message, status === 429 || isRateLimit(message));
            return logRecovered("ai run threw")(e).pipe(
              Effect.annotateLogs({ gatewayLogId: binding.aiGatewayLogId ?? undefined, errorStatus: status }),
            );
          }),
        );
        return result instanceof Response ? yield* inspect(result, fields, false) : result;
      }).pipe(Effect.withLogSpan("duration"), Effect.annotateLogs(fields)),
    );
  };

  return new Proxy(binding, {
    get(target, prop) {
      if (prop === "fetch") return fetchLogged;
      if (prop === "run") return runLogged;
      const value: unknown = Reflect.get(target, prop, target);
      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
}
