/**
 * Structured logging.
 *
 * Everything meaningful is logged and nothing is silent: every node execution,
 * every GPU/CPU boundary crossing, every error path. Channels keep that
 * readable, and the correlation id ties one render's lines together.
 */

export type Channel =
  | "app"
  | "graph"
  | "gpu"
  | "wasm"
  | "export"
  | "batch"
  | "io";

export type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let minLevel: Level = import.meta.env.DEV ? "debug" : "info";

export function setLevel(level: Level): void {
  minLevel = level;
}

export interface LogFields {
  readonly [key: string]: string | number | boolean | null | undefined;
}

function emit(
  level: Level,
  channel: Channel,
  message: string,
  fields?: LogFields,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const prefix = `[${channel}]`;
  const method =
    level === "error" ? console.error
    : level === "warn" ? console.warn
    : console.log;
  if (fields && Object.keys(fields).length > 0) {
    method(prefix, message, fields);
  } else {
    method(prefix, message);
  }
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Times an operation and logs its duration on both success and failure. */
  time<T>(message: string, fn: () => Promise<T> | T): Promise<T>;
}

export function logger(channel: Channel, correlationId?: string): Logger {
  const withId = (fields?: LogFields): LogFields =>
    correlationId === undefined ? (fields ?? {}) : { cid: correlationId, ...fields };

  return {
    debug: (m, f) => emit("debug", channel, m, withId(f)),
    info: (m, f) => emit("info", channel, m, withId(f)),
    warn: (m, f) => emit("warn", channel, m, withId(f)),
    error: (m, f) => emit("error", channel, m, withId(f)),
    async time<T>(message: string, fn: () => Promise<T> | T): Promise<T> {
      const start = performance.now();
      try {
        const result = await fn();
        emit("info", channel, message, withId({ ms: round(performance.now() - start) }));
        return result;
      } catch (error) {
        // No swallowed errors: log with timing, then rethrow.
        emit("error", channel, `${message} failed`, withId({
          ms: round(performance.now() - start),
          error: String(error),
        }));
        throw error;
      }
    },
  };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** Short, sortable-enough id to tie one render's log lines together. */
export function correlationId(): string {
  return Math.trunc(performance.now() * 1000).toString(36);
}
