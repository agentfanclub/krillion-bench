import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const hostFile = new URL("../.wrangler/openai-chatgpt-host-id", import.meta.url);
const rosterFile = new URL("../config/models.json", import.meta.url);

async function hostId() {
  await mkdir(new URL(".", hostFile), { recursive: true });
  try {
    await writeFile(hostFile, randomUUID(), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return (await readFile(hostFile, "utf8")).trim();
}

async function checkModels(access) {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${access}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Model list returned HTTP ${response.status}`);
  const { models } = await response.json();
  const available = new Set(models.map(({ slug }) => slug));
  const roster = JSON.parse(await readFile(rosterFile, "utf8"));
  const missing = roster.models.filter(({ id, enabled }) =>
    enabled && id.startsWith("openai/") && !available.has(id.slice("openai/".length)),
  );
  if (missing.length) {
    console.error("Enabled models in config/models.json absent from the account's model list:");
    for (const { id } of missing) console.error(`  ${id}`);
  } else {
    console.error("The account lists every enabled OpenAI model in config/models.json.");
  }
}

async function main() {
  const output = process.argv[2];
  if (!output) {
    console.error("Usage: node scripts/openai-subscription.mjs <credential-output-file>");
    process.exitCode = 1;
    return;
  }

  const models = createModels();
  models.setProvider(openaiProvider());
  const deviceId = await hostId();
  const credential = await models.login("openai", "oauth", {
    signal: AbortSignal.timeout(5 * 60_000),
    prompt: async ({ signal }) => {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await terminal.question("If the browser cannot connect after sign-in, paste the full URL from its address bar here.\n> ", { signal });
      } finally {
        terminal.close();
      }
    },
    notify: (event) => {
      if (event.type === "auth_url") console.error(`Open this URL in a browser on your own machine:\n${event.url}`);
    },
  }, { getDeviceId: () => deviceId, agentName: "Krillion Bench" });

  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(credential), { flag: "wx", mode: 0o600 });
  console.error(`Wrote ChatGPT credential to ${output}.`);
  await checkModels(credential.access).catch(() => console.error("Could not verify the account's model list."));
}

main().catch((error) => {
  console.error(error.code === "EEXIST"
    ? "The output file already exists. Choose a new path."
    : "Could not create a ChatGPT credential. Verify that the account grants plan usage and paste the full callback URL if signing in remotely.");
  process.exitCode = 1;
});
