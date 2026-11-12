import puppeteer, { type Browser as PptrBrowser, type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import type { Browser } from "agents/browser";
import { Option, Schema } from "effect";
import { KRILLION_ORIGIN, type Submission } from "../domain";

const TARGET_KEY = "browser:targetId";
const SUBMIT_PATH = "/api/submit";
const GAME_STORAGE_KEY = "krillion:game:v1";
/** Each prompt's answer clock, in ms. */
const ANSWER_WINDOW_MS = 25_000;

/** The page's `localStorage["krillion:game:v1"]`, the parts we read. */
export const GameState = Schema.Struct({
  date: Schema.optional(Schema.String),
  roundIndex: Schema.optional(Schema.Number),
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        promptId: Schema.String,
        answer: Schema.optional(Schema.NullOr(Schema.String)),
        tier: Schema.optional(Schema.NullOr(Schema.String)),
        score: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
});
export type GameState = typeof GameState.Type;

/** POST https://krillion.io/api/submit request body, as the page sends it. */
const SubmitRequest = Schema.Struct({ date: Schema.String, promptId: Schema.String, answer: Schema.String });

/** POST /api/submit response: `{accepted:false}`, `{accepted:true, answer, tier, score}`, or `{correction}`. */
const SubmitResponse = Schema.Struct({
  accepted: Schema.optional(Schema.Boolean),
  answer: Schema.optional(Schema.String),
  tier: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
  correction: Schema.optional(Schema.String),
});

const decodeGameState = Schema.decodeUnknownOption(Schema.fromJsonString(GameState));
const decodeSubmitRequest = Schema.decodeUnknownOption(Schema.fromJsonString(SubmitRequest));
const decodeSubmitResponse = Schema.decodeUnknownOption(Schema.fromJsonString(SubmitResponse));
const decodeTargetId = Schema.decodeUnknownOption(Schema.String);

export interface CapturedSubmission extends Omit<Submission, "runId" | "day"> {
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
    const wanted = decodeTargetId(await this.storage.get(TARGET_KEY));
    let page: Page | undefined;
    for (const p of await pptr.pages()) {
      if (Option.isSome(wanted) && (await targetId(p)) === wanted.value) page = p;
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
  async gameState(): Promise<Option.Option<GameState>> {
    const page = await this.page();
    if (!page.url().startsWith(KRILLION_ORIGIN)) return Option.none();
    return decodeGameState(await page.evaluate<[], () => string | null>(`localStorage.getItem("${GAME_STORAGE_KEY}")`));
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
        const raw = localStorage.getItem("${GAME_STORAGE_KEY}");
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
    const body = decodeSubmitRequest(req.postData() ?? "");
    if (Option.isNone(body)) return;
    const status = res.status();
    const parsed = Option.getOrUndefined(decodeSubmitResponse(await res.text().catch(() => "")));
    const endsAt = await start.clock;
    const kind: Submission["kind"] =
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
      clockMs: endsAt === null ? null : start.at - (endsAt - ANSWER_WINDOW_MS),
    });
  });
}
