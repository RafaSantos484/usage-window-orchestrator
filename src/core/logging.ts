export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

/** Structured logging port. The core never touches console/stdout directly. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const REDACTED = "[redacted]";

/**
 * Patterns that look like credentials regardless of which secret values we
 * happen to know about. Defence in depth behind the exact-value redaction.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_\-]{6,}/g, // Anthropic API keys
  /sk-[A-Za-z0-9_\-]{20,}/g, // generic API keys
  /\b[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/g, // JWT-shaped
  /(?<=(?:authorization|bearer|token|api[_-]?key|secret|password)["'\s:=]{1,4})[A-Za-z0-9_\-.]{12,}/gi,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes known secret values and credential-shaped substrings from text
 * before it can reach a log line, a job summary, or a result object.
 *
 * Short values are ignored: redacting a 3-character string would blank out
 * unrelated text without protecting anything meaningful.
 */
export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    output = output.replaceAll(secret, REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/** Redacts string values before serialization, so JSON escaping cannot hide a secret. */
export function redactValue(
  value: unknown,
  secrets: readonly (string | undefined)[] = [],
): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key, secrets), redactValue(item, secrets)]),
    );
  }
  return value;
}

/** Collapses whitespace and truncates, so diagnostics stay one readable line. */
export function summarize(text: string, maxLength = 240): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1)}…`;
}

/** Redact, then collapse and truncate. The only way text should reach a log. */
export function safeSummary(
  text: string,
  secrets: readonly (string | undefined)[] = [],
  maxLength = 240,
): string {
  return summarize(redact(text, secrets), maxLength);
}

/** Discards everything. Used by tests and by callers that want silence. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
