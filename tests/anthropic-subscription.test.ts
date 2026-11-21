import { describe, expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  anthropicRosterId,
  anthropicSubscriptionModels,
  anthropicSubscriptionProvider,
} from "../src/agent/anthropicSubscription";
import roster from "../config/models.json";

// Deliberately fake. The mock transport never contacts Anthropic.
const token = "sk-ant-oat01-benchmark-test";

function registry(secret: string | undefined, fetchResponses: typeof fetch, errors: string[]) {
  const models = createModels();
  models.setProvider(anthropicSubscriptionProvider(
    { CLAUDE_CODE_OAUTH_TOKEN: secret } as Env,
    fetchResponses,
    (message) => errors.push(message),
  ));
  return models;
}

describe("Claude subscription", () => {
  test("every Claude roster entry maps to a native model without changing its roster ID", () => {
    for (const { id } of roster.models.filter(({ id }) => id.startsWith("anthropic/"))) {
      const native = anthropicSubscriptionModels.find((m) => m.id === id.slice("anthropic/".length).replaceAll(".", "-"));
      expect(native).toBeDefined();
      expect(anthropicRosterId(native!.id)).toBe(id);
      expect(native!.provider).toBe("anthropic");
    }
  });

  test("setup-token selects Bearer authentication and streams tool calls through Pi", async () => {
    let request: { headers: Headers; body: any } | undefined;
    const fetchResponses = (async (input, init) => {
      const req = new Request(input, init);
      request = { headers: req.headers, body: await req.json() };
      expect(`${new URL(req.url).origin}${new URL(req.url).pathname}`).toBe("https://api.anthropic.com/v1/messages");
      const events = [
        { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", content: [], model: "claude-sonnet-4-6", usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool_test", name: "benchmark_action", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"action":"play"}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 8 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const errors: string[] = [];
    const models = registry(` ${token}\n`, fetchResponses, errors);
    const model = models.getModel("anthropic", "claude-sonnet-4-6")!;
    const reply = await models.completeSimple(model, {
      systemPrompt: "Play the benchmark game.",
      messages: [{ role: "user", content: "Start", timestamp: 0 }],
      tools: [{ name: "benchmark_action", description: "Play a move", parameters: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } }],
    });
    expect(reply.errorMessage).toBeUndefined();
    expect(reply.stopReason).toBe("toolUse");
    expect(reply.content).toContainEqual({ type: "toolCall", id: "tool_test", name: "benchmark_action", arguments: { action: "play" } });
    expect(request!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(request!.headers.has("x-api-key")).toBe(false);
    expect(request!.headers.get("x-app")).toBe("cli");
    expect(request!.headers.get("anthropic-beta")).toContain("oauth-2025-04-20");
    expect(request!.body.system.some((block: { text: string }) => block.text.includes("You are Claude Code"))).toBe(true);
    expect(request!.body.system.some((block: { text: string }) => block.text.includes("Play the benchmark game."))).toBe(true);
    expect(reply.usage.input).toBe(10);
    expect(errors).toEqual([]);
  });

  test.each([undefined, "", "sk-ant-api03-not-an-oauth-token", "sk-ant-oat01-has whitespace"])(
    "rejects missing or invalid secrets without contacting the API: %s",
    async (secret) => {
      const errors: string[] = [];
      const models = registry(secret, (() => { throw new Error("Unexpected network call"); }) as typeof fetch, errors);
      await expect(models.getAuth("anthropic")).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
      expect(errors).toHaveLength(1);
      expect(errors[0]).not.toContain("sk-ant-");
    },
  );
});
