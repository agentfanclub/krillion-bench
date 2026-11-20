import type { Provider } from "@earendil-works/pi-ai/models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Schema } from "effect";
import { OPENAI_CREDENTIAL_OBJECT } from "./OpenAICredentials";

export const OPENAI_ROSTER_PREFIX = "openai/";
// Pi 1.5.2 predates GPT-6.2. Keep the sibling's wire settings and use OpenAI's
// published context and pricing. Requests still use the exact 6.2 model IDs.
const extraModels = [
  {
    ...OPENAI_MODELS["gpt-6-astra"],
    id: "gpt-6.2-astra",
    name: "GPT-6.2 Astra",
    contextWindow: 1_050_000,
    cost: {
      input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
      tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
    },
  },
  {
    ...OPENAI_MODELS["gpt-6.1-sol"],
    id: "gpt-6.2-sol",
    name: "GPT-6.2 Sol",
    contextWindow: 1_050_000,
  },
];

export const subscriptionModels = [...Object.values(OPENAI_MODELS), ...extraModels].map((model) => ({
  ...model,
  compat: { ...model.compat, supportsToolSearch: false },
}));

const Fields = Schema.Record(Schema.String, Schema.Unknown);
const RequestItem = Schema.StructWithRest(Schema.Struct({ role: Schema.optional(Schema.String) }), [Fields]);
const decodeRequest = Schema.decodeUnknownSync(Schema.StructWithRest(Schema.Struct({
  input: Schema.Array(RequestItem),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
}), [Fields]));

/** Older Pi catalog entries use system messages and flat function tools. Adapt them for plan usage. */
function planPayload(payload: unknown) {
  const request = decodeRequest(payload);
  return {
    ...request,
    input: request.input.map((item) => item.role === "system" ? { ...item, role: "developer" } : item),
    ...(request.tools?.length ? {
      tools: [{
        type: "namespace",
        name: "benchmark",
        description: "Tools for playing the benchmark game",
        tools: request.tools,
      }],
    } : {}),
  };
}

/** Pi's native OpenAI transport with request auth resolved by the credential object. */
export function subscriptionProvider(env: Env, fetchResponses: typeof fetch, onAuthError: (error: string) => void): Provider {
  const provider: Provider = openaiProvider();
  return {
    ...provider,
    getModels: () => subscriptionModels,
    getAllModels: () => subscriptionModels,
    auth: {
      apiKey: {
        name: "ChatGPT subscription",
        check: async () => env.OPENAI_CHATGPT_CREDENTIAL === undefined
          ? undefined
          : { type: "oauth", source: "ChatGPT subscription" },
        resolve: async () => {
          const credentials = env.OPENAI_CREDENTIALS.getByName(OPENAI_CREDENTIAL_OBJECT);
          try {
            return { auth: { apiKey: await credentials.accessToken() }, source: "ChatGPT subscription" };
          } catch (error) {
            onAuthError(error instanceof Error ? error.message : "ChatGPT credential is unavailable");
            throw error;
          }
        },
      },
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, {
        ...options,
        fetch: fetchResponses,
        onPayload: async (payload, model) => planPayload(await options?.onPayload?.(payload, model) ?? payload),
      });
    },
  };
}
