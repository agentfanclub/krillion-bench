import { Cause, Effect, Logger, References } from "effect";

/** Long text for a log field. */
export const clip = (text: string, max = 2_000): string =>
  text.length > max ? `${text.slice(0, max)}… (${text.length} chars)` : text;

/**
 * Workers Logs: each line is one object whose `message` is the log message (what the
 * dashboard shows and searches); log annotations and spans (`<label>Ms`) become
 * indexed fields; a failure's cause goes in `cause`.
 */
const workersLogger = Logger.make(({ logLevel, message, cause, fiber, date }) => {
  const parts = Array.isArray(message) ? message : [message];
  const spans = fiber
    .getRef(References.CurrentLogSpans)
    .map(([label, start]) => [`${label}Ms`, date.getTime() - start] as const);
  const line = {
    message: parts.map(String).join(" "),
    level: logLevel.toLowerCase(),
    ...fiber.getRef(References.CurrentLogAnnotations),
    ...Object.fromEntries(spans),
    ...(cause.reasons.length > 0 ? { cause: clip(Cause.pretty(cause), 4_000) } : {}),
  };
  if (logLevel === "Error" || logLevel === "Fatal") console.error(line);
  else if (logLevel === "Warn") console.warn(line);
  else console.log(line);
});

export const LoggerLive = Logger.layer([workersLogger]);

/** Log a handled error with the error as the line's `cause` (not stringified into `message`). */
export const logRecovered =
  (message: string) =>
  (error: unknown): Effect.Effect<void> =>
    Effect.logError(message, Cause.fail(error));
