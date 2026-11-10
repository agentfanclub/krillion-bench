import puppeteer, { type Browser as PptrBrowser, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import type { Browser } from "agents/browser";
import { GameState, SubmitRequest, SubmitResponse } from "../domain";
import type { SubmissionRow } from "../services";
import { Schema } from "effect";

const TARGET_KEY = "browser:targetId";
const SUBMIT_PATH = "/api/submit";

export interface CapturedSubmission extends Omit<SubmissionRow, "runId" | "day"> {
  /** The game day the page submitted for; other modes (Unlimited, archive) carry other dates. */
  readonly date: string;
}

/**
 * The run's one tab, over a Puppeteer connection to the Browser Run session the
 * agents-SDK `Browser` owns. The SDK keeps the session record (guardrails,
 * keep-alive, recording, reconnect after hibernation); Puppeteer gives the tools
 * and the harness-only network listener a page object.
 *
 * After an eviction the in-memory connection is gone: `page()` reconnects to the
 * same session and finds the same tab by target id.
 */
export class RunPage {
  #pptr: PptrBrowser | undefined;
  #page: Page | undefined;
  #connecting: Promise<Page> | undefined;

  constructor(
    private readonly binding: BrowserWorker,
    private readonly browser: Browser,
    private readonly storage: DurableObjectStorage,
    private readonly onSubmission: (s: CapturedSubmission) => void,
  ) {}

  async page(): Promise<Page> {
    if (this.#page && !this.#page.isClosed() && this.#pptr?.connected) return this.#page;
    this.#connecting ??= this.#connect().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  /** Browser Run session id, for the runs row and recordings. */
  async sessionId(): Promise<string> {
    return (await this.browser.resolve()).sessionId;
  }

  async #connect(): Promise<Page> {
    const { sessionId } = await this.browser.resolve();
    const pptr = await puppeteer.connect(this.binding, sessionId);
    const wanted = await this.storage.get<string>(TARGET_KEY);
    let page: Page | undefined;
    for (const p of await pptr.pages()) {
      if (wanted && (await targetId(p)) === wanted) page = p;
    }
    if (!page) {
      page = await pptr.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await this.storage.put(TARGET_KEY, await targetId(page));
    }
    attachCapture(page, this.onSubmission);
    this.#pptr = pptr;
    this.#page = page;
    return page;
  }

  /** The game's own record of this player's dive (`localStorage["krillion:game:v1"]`). */
  async gameState(): Promise<GameState | undefined> {
    const page = await this.page();
    if (!page.url().startsWith("https://krillion.io")) return undefined;
    const raw = await page.evaluate<[], () => string | null>(`localStorage.getItem("krillion:game:v1")`);
    if (!raw) return undefined;
    const state = Schema.decodeUnknownOption(Schema.fromJsonString(GameState))(raw);
    return state._tag === "Some" ? state.value : undefined;
  }

  /** Drop the connection (not the browser). */
  disconnect(): void {
    this.#pptr?.disconnect();
    this.#pptr = undefined;
    this.#page = undefined;
  }
}

async function targetId(page: Page): Promise<string> {
  const cdp = await page.createCDPSession();
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    return targetInfo.targetId;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * Record every `/api/submit` exchange from the network. The model never sees this
 * path: it reads Krillion's own response, so scores never depend on the model's
 * account of them.
 */
function attachCapture(page: Page, onSubmission: (s: CapturedSubmission) => void): void {
  const started = new WeakMap<object, { at: number; clock: Promise<number | null> }>();

  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().endsWith(SUBMIT_PATH)) return;
    // Read the answer clock as the request leaves; the game clears it once answered.
    const clock = page
      .evaluate<[], () => number | null>(`(() => {
        const raw = localStorage.getItem("krillion:game:v1");
        const ends = raw ? JSON.parse(raw).answerEndsAt : null;
        return typeof ends === "number" ? ends : null;
      })()`)
      .catch(() => null);
    started.set(req, { at: Date.now(), clock });
  });

  page.on("response", async (res) => {
    const req = res.request();
    const start = started.get(req);
    if (!start) return;
    const body = Schema.decodeUnknownOption(Schema.fromJsonString(SubmitRequest))(req.postData() ?? "");
    if (body._tag === "None") return;
    const status = res.status();
    let parsed: SubmitResponse | undefined;
    try {
      const json = (await res.json()) as unknown;
      const decoded = Schema.decodeUnknownOption(SubmitResponse)(json);
      if (decoded._tag === "Some") parsed = decoded.value;
    } catch {
      parsed = undefined;
    }
    const endsAt = await start.clock;
    const kind: CapturedSubmission["kind"] =
      status !== 200 || !parsed
        ? "error"
        : parsed.accepted === true
          ? "accepted"
          : parsed.correction
            ? "correction"
            : "rejected";
    onSubmission({
      seq: start.at,
      date: body.value.date,
      promptId: body.value.promptId,
      submittedAt: new Date(start.at).toISOString(),
      rawAnswer: body.value.answer,
      kind,
      canonical: parsed?.answer ?? null,
      correction: parsed?.correction ?? null,
      tier: parsed?.tier ?? null,
      score: parsed?.score ?? null,
      httpStatus: status,
      latencyMs: Date.now() - start.at,
      clockMs: endsAt === null ? null : start.at - (endsAt - 25_000),
    });
  });
}
