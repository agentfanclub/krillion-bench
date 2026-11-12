import type { ElementHandle, KeyInput, Page } from "@cloudflare/puppeteer";
import type { Extension, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";
import { Schema } from "effect";

/** A tool's validated arguments (pi-durable doesn't export `ToolArgs`). */
type ArgsOf<P extends object> = Parameters<ToolRegistration<P>["execute"]>[0];

/** An element inside `evaluate` callbacks: they run in the page, and the Worker's types have no DOM lib. */
type PageElement = { click(): void; focus(): void; select?: () => void };

/**
 * Generic page tools (not Krillion-specific). Every action returns a fresh
 * snapshot so the model sees the effect without spending another call: a step
 * saved is seconds saved on a 25 s clock.
 */

const MAX_TEXT = 4_000;
const SETTLE_MS = 350;

/** Runs in the page. Tags interactive elements with stable `data-kb-ref` ids. */
const SNAPSHOT_JS = `(() => {
  const w = window;
  w.__kbNext = w.__kbNext || 1;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=textbox],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
  const elements = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!visible(el)) continue;
    let ref = el.getAttribute("data-kb-ref");
    if (!ref) { ref = "e" + w.__kbNext++; el.setAttribute("data-kb-ref", ref); }
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" || tag === "textarea" ? "textbox" : tag);
    const name = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || "")
      .replace(/\\s+/g, " ").trim().slice(0, 80);
    const states = [];
    if (el.disabled) states.push("disabled");
    if (tag === "input" || tag === "textarea") states.push("value=" + JSON.stringify(el.value));
    if (document.activeElement === el) states.push("focused");
    elements.push("[" + ref + "] " + role + " " + JSON.stringify(name) + (states.length ? " (" + states.join(", ") + ")" : ""));
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n\\s*\\n+/g, "\\n").trim();
  return { url: location.href, title: document.title, elements, text };
})()`;

const Snapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  elements: Schema.Array(Schema.String),
  text: Schema.String,
});
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);

async function snapshotText(page: Page): Promise<string> {
  if (page.url() === "about:blank") return "URL: about:blank (empty page)";
  const s = decodeSnapshot(await page.evaluate<[], () => unknown>(SNAPSHOT_JS));
  const text = s.text.length > MAX_TEXT ? `${s.text.slice(0, MAX_TEXT)}\n…(truncated)` : s.text;
  return [
    `URL: ${s.url}`,
    `Title: ${s.title}`,
    "",
    "Interactive elements (use the [ref] with click/type):",
    s.elements.length ? s.elements.join("\n") : "(none)",
    "",
    "Visible text:",
    text,
  ].join("\n");
}

const ok = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }] });

async function afterAction(page: Page, note: string): Promise<ToolExecutionResult> {
  await scheduler.wait(SETTLE_MS);
  return ok(`${note}\n\n${await snapshotText(page)}`);
}

async function byRef(page: Page, ref: string): Promise<ElementHandle<Element>> {
  if (!/^e\d+$/.test(ref)) throw new Error(`"${ref}" is not a ref; refs look like e12 (take a snapshot first)`);
  const el = await page.$(`[data-kb-ref="${ref}"]`);
  if (!el) throw new Error(`no element ${ref} on the page now; take a new snapshot`);
  return el;
}

export interface BrowserToolsOptions {
  readonly page: () => Promise<Page>;
  readonly vision: boolean;
  /** Called once per tool call, for step accounting. */
  readonly onStep: () => void;
}

export function browserExtension({ page: getPage, vision, onStep }: BrowserToolsOptions): Extension {
  /**
   * A tool on the run's one tab: runs alone, counts as a step, and returns errors to the
   * model as tool errors it can react to, with the page state.
   */
  const pageTool = <P extends object>(spec: {
    readonly name: string;
    readonly description: string;
    readonly parameters: P;
    /** Safe to rerun after an interruption (read-only, or idempotent). */
    readonly replay?: "safe";
    readonly run: (page: Page, args: ArgsOf<P>) => Promise<ToolExecutionResult>;
  }): ToolRegistration<P> => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    replay: spec.replay,
    executionMode: "sequential",
    execute: async (args) => {
      onStep();
      const page = await getPage();
      try {
        return await spec.run(page, args);
      } catch (e) {
        const snap = await snapshotText(page).catch(() => "(page unavailable)");
        return { output: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}\n\n${snap}` }], isError: true };
      }
    },
  });

  const tools: ToolRegistration[] = [
    pageTool({
      name: "navigate",
      description: "Open a URL in the browser tab and return a snapshot of the page.",
      parameters: obj({ url: str({ description: "Absolute http(s) URL" }) }),
      replay: "safe",
      run: async (page, { url }) => {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        return afterAction(page, `Opened ${url}`);
      },
    }),
    pageTool({
      name: "snapshot",
      description: "Read the current page: URL, interactive elements with [ref] ids for click/type, and the visible text.",
      parameters: obj({}),
      replay: "safe",
      run: async (page) => ok(await snapshotText(page)),
    }),
    pageTool({
      name: "click",
      description: "Click an element by its [ref]. Returns the page snapshot after the click.",
      parameters: obj({ ref: str({ description: "Element ref from the latest snapshot, e.g. e12" }) }),
      run: async (page, { ref }) => {
        const el = await byRef(page, ref);
        await el.click().catch(() => el.evaluate((node) => (node as unknown as PageElement).click()));
        return afterAction(page, `Clicked ${ref}`);
      },
    }),
    pageTool({
      name: "type",
      description:
        "Replace the contents of a text box with `text`; with submit=true also press Enter. Returns the page snapshot after.",
      parameters: obj({
        ref: str({ description: "Text box ref from the latest snapshot" }),
        text: str({ description: "Text to enter (replaces what is in the box)" }),
        submit: opt(bool({ description: "Press Enter after typing" })),
      }),
      run: async (page, { ref, text, submit }) => {
        const el = await byRef(page, ref);
        await el.evaluate((node) => {
          const input = node as unknown as PageElement;
          input.focus();
          input.select?.();
        });
        // One CDP Input.insertText instead of a round trip per character: harness latency
        // shouldn't eat into the model's 25 s.
        await page.keyboard.sendCharacter(text);
        if (submit) await page.keyboard.press("Enter");
        return afterAction(page, `Typed ${JSON.stringify(text)} into ${ref}${submit ? " and pressed Enter" : ""}`);
      },
    }),
    pageTool({
      name: "press",
      description: "Press a keyboard key in the focused element. Returns the page snapshot after.",
      parameters: obj({ key: str({ description: "Key name, e.g. Enter, Tab, Escape, ArrowDown" }) }),
      run: async (page, { key }) => {
        // Unknown key names make Puppeteer throw, which reaches the model as a tool error.
        await page.keyboard.press(key as KeyInput);
        return afterAction(page, `Pressed ${key}`);
      },
    }),
    pageTool({
      name: "wait",
      description: "Wait, then return a snapshot. Use when the page is animating or loading.",
      parameters: obj({ ms: int({ minimum: 100, maximum: 5_000, description: "Milliseconds to wait (100-5000)" }) }),
      replay: "safe",
      run: async (page, { ms }) => {
        await scheduler.wait(ms);
        return ok(await snapshotText(page));
      },
    }),
  ];
  if (vision) {
    tools.push(
      pageTool({
        name: "screenshot",
        description: "Take a screenshot of the visible part of the page.",
        parameters: obj({}),
        replay: "safe",
        run: async (page) => {
          const data = await page.screenshot({ type: "jpeg", quality: 60, encoding: "base64" });
          return { output: [{ type: "image", data: String(data), mimeType: "image/jpeg" }] };
        },
      }),
    );
  }
  return { name: "browser", tools };
}
