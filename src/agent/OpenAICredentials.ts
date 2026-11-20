import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";

// Make Pi's refresh implementation visible to Wrangler's bundler.
registerLazyOAuthFlows();

// Optional Worker secret. Keep it out of the generated types, where it would be required.
declare global {
  interface Env {
    readonly OPENAI_CHATGPT_CREDENTIAL?: string;
  }
}

export const OPENAI_CREDENTIAL_OBJECT = "openai";
const KEY = "credential:openai";
const IMPORT_KEY = "credential:import";
const ImportedCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.NonEmptyString,
  refresh: Schema.NonEmptyString,
  expires: Schema.Finite,
  clientId: Schema.NonEmptyString,
  scopes: Schema.Array(Schema.String),
});
const decodeImport = Schema.decodeUnknownOption(Schema.fromJsonString(ImportedCredential));

/** Pi runs its refresh callback inside modify, in the object that owns the token. */
function credentialStore(kv: SyncKvStorage): CredentialStore {
  let tail: Promise<unknown> = Promise.resolve();

  const serialize = <A>(task: () => Promise<A>): Promise<A> => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };

  return {
    async read(providerId, options) {
      options?.signal?.throwIfAborted();
      return providerId === "openai" ? kv.get<Credential>(KEY) : undefined;
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      const credential = kv.get<Credential>(KEY);
      return credential ? [{ providerId: "openai", type: credential.type }] : [];
    },
    modify(providerId, update, options) {
      if (providerId !== "openai") return Promise.reject(new Error("Unexpected provider in OpenAI credential store"));
      return serialize(async () => {
        options?.signal?.throwIfAborted();
        const current = kv.get<Credential>(KEY);
        const next = await update(current);
        // A refresh may already have rotated its token while the caller was waiting.
        if (next !== undefined) kv.put(KEY, next);
        return next ?? current;
      });
    },
    delete(providerId, options) {
      return serialize(async () => {
        options?.signal?.throwIfAborted();
        if (providerId === "openai") kv.delete(KEY);
      });
    },
  };
}

/** A single account for the benchmark. Only the access token crosses the internal RPC. */
export class OpenAICredentials extends DurableObject<Env> {
  readonly #models = createModels({ credentials: credentialStore(this.ctx.storage.kv) });
  #imported: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#models.setProvider(openaiProvider());
  }

  async #importCredential(secret: string): Promise<void> {
    const fingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret.trim()));
    const source = Array.from(new Uint8Array(fingerprint), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const kv = this.ctx.storage.kv;
    if (kv.get(IMPORT_KEY) === source && kv.get(KEY) !== undefined) return;

    const credential = decodeImport(secret);
    if (
      Option.isNone(credential) ||
      credential.value.access.startsWith("sk-") ||
      !credential.value.scopes.includes("chatgpt.tokens.use.direct")
    ) {
      throw new Error("Invalid OPENAI_CHATGPT_CREDENTIAL. Import a fresh Sign in with ChatGPT credential.");
    }
    this.ctx.storage.transactionSync(() => {
      kv.put(KEY, credential.value);
      kv.put(IMPORT_KEY, source);
    });
  }

  accessToken(): Promise<string> {
    const operation = this.#accessToken();
    this.ctx.waitUntil(operation.catch(() => {}));
    return operation;
  }

  async #accessToken(): Promise<string> {
    const secret = this.env.OPENAI_CHATGPT_CREDENTIAL;
    if (!secret) throw new Error("OPENAI_CHATGPT_CREDENTIAL is missing");
    this.#imported ??= this.#importCredential(secret).catch((error: unknown) => {
      this.#imported = undefined;
      throw error;
    });
    await this.#imported;

    const result = await this.#models.getAuth("openai").catch(() => {
      throw new Error("ChatGPT credential refresh failed. Check the account connection and re-import if needed.");
    });
    const token = result?.auth.apiKey;
    if (result?.source !== "OAuth" || !token || token.startsWith("sk-")) {
      throw new Error("No ChatGPT subscription access token is available");
    }
    return token;
  }
}
