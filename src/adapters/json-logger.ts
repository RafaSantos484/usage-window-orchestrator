import { LOG_LEVELS, redact, type LogFields, type LogLevel, type Logger } from "../core/logging.ts";

const RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export interface JsonLoggerOptions {
  readonly level: LogLevel;
  /** Exact values to scrub from every field before writing. */
  readonly secrets?: readonly (string | undefined)[];
  /** Defaults to stderr, keeping stdout free for the machine-readable result. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

/**
 * Newline-delimited JSON logger.
 *
 * Writes to **stderr** so that stdout carries only the final result document;
 * `node src/main.ts > result.json` therefore yields clean JSON while the
 * operational log still streams to the platform.
 *
 * Every field passes through redaction before it is serialized - there is no
 * code path that writes an unredacted value.
 */
export class JsonLogger implements Logger {
  readonly #threshold: number;
  readonly #secrets: readonly (string | undefined)[];
  readonly #write: (line: string) => void;
  readonly #now: () => Date;

  constructor(options: JsonLoggerOptions) {
    this.#threshold = RANK[options.level] ?? RANK.info;
    this.#secrets = options.secrets ?? [];
    this.#write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.#now = options.now ?? (() => new Date());
  }

  debug(message: string, fields?: LogFields): void {
    this.#emit("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#emit("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#emit("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#emit("error", message, fields);
  }

  #emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (RANK[level] < this.#threshold) return;
    const record = {
      ts: this.#now().toISOString(),
      level,
      event: message,
      ...(fields ? clean(fields) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, event: message, error: "unserializable_fields" });
    }
    this.#write(redact(line, this.#secrets));
  }
}

/** Drops undefined values so log lines stay compact and stable. */
function clean(fields: LogFields): LogFields {
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
}

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}
