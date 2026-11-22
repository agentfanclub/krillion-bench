import type { Provider } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { Schema } from "effect";

declare global {
  interface Env {
    readonly CLAUDE_CODE_OAUTH_TOKEN?: string;
  }
}

export const ANTHROPIC_ROSTER_PREFIX = "anthropic/";
// Pi's catalog omits Mythos. Each version shares its Fable sibling's Messages
// settings, context/output limits and pricing. Don't request the Fable catalog's
// optional fallback models for benchmark runs.
// https://platform.claude.com/docs/en/models/mythos-5-2/overview
const mythosModels = (["5-1", "5-2"] as const).map((version) => {
  const base = ANTHROPIC_MODELS[`claude-fable-${version}`];
  return {
    ...base,
    id: `claude-mythos-${version}`,
    name: `Claude Mythos ${version.replace("-", ".")}`,
    compat: { ...base.compat, allowedFallbackModels: [] },
  };
});
export const anthropicSubscriptionModels = [...Object.values(ANTHROPIC_MODELS), ...mythosModels];

/** The gateway roster spells versions with dots; Anthropic's native IDs use dashes. */
export const anthropicRosterId = (id: string): string =>
  `${ANTHROPIC_ROSTER_PREFIX}${id.replace(/-(\d+)-(\d+)(?=-|$)/, "-$1.$2")}`;

const isSetupToken = Schema.is(Schema.String.check(Schema.isPattern(/^sk-ant-oat\S+$/)));

/** setup-token supplies an access token without a refresh token. Rotate the secret on expiry. */
export function anthropicSubscriptionProvider(
  env: Env,
  fetchResponses: typeof fetch,
  onAuthError: (message: string) => void,
): Provider {
  const provider: Provider = anthropicProvider();
  return {
    ...provider,
    getModels: () => anthropicSubscriptionModels,
    getAllModels: () => anthropicSubscriptionModels,
    auth: {
      apiKey: {
        name: "Claude subscription",
        check: async () => env.CLAUDE_CODE_OAUTH_TOKEN === undefined
          ? undefined
          : { type: "oauth", source: "Claude subscription" },
        resolve: async () => {
          const token = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
          if (!isSetupToken(token)) {
            const message = "CLAUDE_CODE_OAUTH_TOKEN is missing or invalid. Generate a token with claude setup-token and replace the Worker secret.";
            onAuthError(message);
            throw new Error(message);
          }
          // Passing the token as apiKey lets Pi select Bearer auth and its subscription wire format.
          return { auth: { apiKey: token }, source: "Claude subscription" };
        },
      },
    },
    streamSimple(model, context, options) {
      return provider.streamSimple(model, context, { ...options, fetch: fetchResponses });
    },
  };
}
