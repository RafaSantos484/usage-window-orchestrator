import { InvocationStatus, type ProviderMetadata, type ProviderOutcome } from "../../core/invocation.ts";
import { safeSummary } from "../../core/logging.ts";
import type { ProcessRunResult } from "../../adapters/process-runner.ts";

/**
 * The subset of `claude -p --output-format json` output we rely on.
 *
 * Every field is optional on purpose: the CLI is an external contract that can
 * change between releases, and a shape change must degrade to UNKNOWN_FAILURE
 * rather than crash the run.
 */
export interface ClaudeCliEnvelope {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

/**
 * Extracts the CLI's JSON result envelope.
 *
 * Tolerates leading noise and line-delimited output by scanning backwards for
 * the last parsable JSON object, since the result envelope is emitted last.
 */
export function parseCliEnvelope(stdout: string): ClaudeCliEnvelope | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const direct = tryParseObject(trimmed);
  if (direct?.type === "result") return direct;

  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = tryParseObject(lines[i]!.trim());
    if (candidate?.type === "result") {
      return candidate;
    }
  }
  return undefined;
}

function tryParseObject(text: string): ClaudeCliEnvelope | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ClaudeCliEnvelope;
    }
  } catch {
    /* not JSON; caller falls back */
  }
  return undefined;
}

interface Signal {
  readonly code: string;
  readonly status: InvocationStatus;
  readonly pattern: RegExp;
  readonly summary: string;
}

/**
 * Matches an HTTP-ish status code only when it is preceded by error context.
 *
 * A bare `\b429\b` would also match a `duration_ms` of 429 in the CLI's own
 * JSON, silently turning a successful-looking run into a "usage limit" - or
 * worse, a `5xx` duration into a retryable transient failure that spends
 * allowance a second time.
 */
function statusCode(pattern: string): string {
  return `(?:error|status|http|code)\\D{0,4}${pattern}\\b`;
}

/**
 * Ordered failure signals. First match wins, so the more specific and more
 * consequential classifications come first.
 *
 * These patterns are matched against CLI output only. They are the single
 * place in the codebase that knows what Claude's error text looks like; the
 * orchestrator sees only the normalized status.
 */
const SIGNALS: readonly Signal[] = Object.freeze([
  {
    code: "credit_balance_low",
    status: InvocationStatus.AUTH_FAILURE,
    pattern: /credit balance is too low|insufficient credit/i,
    summary:
      "Claude reported a low credit balance, which indicates usage-billed API credentials rather than the subscription token. Check that CLAUDE_CODE_OAUTH_TOKEN is set and ANTHROPIC_API_KEY is not.",
  },
  {
    code: "auth_failed",
    status: InvocationStatus.AUTH_FAILURE,
    pattern: new RegExp(
      [
        "invalid api key",
        "authentication_error",
        "unauthorized",
        statusCode("40[13]"),
        "oauth token (?:has )?expired",
        "expired token",
        "invalid token",
        "token (?:is )?(?:invalid|revoked)",
        "please run \\/login",
        "not logged in",
        "no credentials found",
      ].join("|"),
      "i",
    ),
    summary: "Claude rejected the supplied credentials. Regenerate and update CLAUDE_CODE_OAUTH_TOKEN.",
  },
  {
    code: "usage_limit_reached",
    status: InvocationStatus.USAGE_LIMIT_REACHED,
    pattern: /usage limit reached|quota exceeded|limit will reset/i,
    summary: "Claude reported that the subscription usage limit is currently reached.",
  },
  {
    code: "provider_rate_limited",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern: new RegExp(["rate_limit_error", "rate limit exceeded", statusCode("429")].join("|"), "i"),
    summary: "Claude rate-limited the invocation; the output does not prove which limit was reached.",
  },
  {
    code: "preconnect_network_failure",
    status: InvocationStatus.TRANSIENT_FAILURE,
    pattern: /ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i,
    summary:
      "The provider connection could not be established; the invocation was not accepted and may be retried conservatively.",
  },
  {
    code: "ambiguous_upstream",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern: new RegExp(
      [
        "overloaded_error",
        "overloaded",
        "api_error",
        statusCode("5\\d{2}"),
        "service unavailable",
        "internal server error",
        "bad gateway",
        "gateway timeout",
      ].join("|"),
      "i",
    ),
    summary: "Claude returned an upstream failure; the request may have reached the model, so it was not retried.",
  },
  {
    code: "ambiguous_network",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern:
      /ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|fetch failed|network error/i,
    summary: "The connection failed after invocation began; the request may have reached the model, so it was not retried.",
  },
]);

const NOT_FOUND_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR"]);

export interface ClassifyInput {
  readonly run: ProcessRunResult;
  /** Values that must never appear in the diagnostic summary. */
  readonly secrets: readonly (string | undefined)[];
}

/**
 * Maps a completed CLI run onto the provider-neutral outcome vocabulary.
 *
 * Order of reasoning:
 *   1. could the binary run at all?        -> PROVIDER_UNAVAILABLE
 *   2. did we kill it on the deadline?     -> TIMEOUT
 *   3. does the JSON envelope say success? -> SUCCESS
 *   4. do any known signals match?         -> that signal's status
 *   5. otherwise                           -> UNKNOWN_FAILURE
 */
export function classifyClaudeRun(input: ClassifyInput): ProviderOutcome {
  const { run, secrets } = input;

  if (run.spawnErrorCode && NOT_FOUND_CODES.has(run.spawnErrorCode)) {
    return {
      status: InvocationStatus.PROVIDER_UNAVAILABLE,
      diagnostic: {
        code: "cli_not_executable",
        summary: safeSummary(
          `The Claude CLI could not be executed (${run.spawnErrorCode}). Install @anthropic-ai/claude-code or set AGENT_CLAUDE_BIN.`,
          secrets,
        ),
      },
    };
  }

  if (run.spawnErrorCode) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "cli_spawn_failed",
        summary: safeSummary(
          `The Claude CLI failed to start (${run.spawnErrorCode}): ${run.spawnErrorMessage ?? "no detail"}`,
          secrets,
        ),
      },
    };
  }

  if (run.timedOut) {
    return {
      status: InvocationStatus.TIMEOUT,
      diagnostic: {
        code: "cli_timeout",
        summary: "The Claude CLI did not complete within the configured timeout and was terminated.",
      },
    };
  }

  const envelope = parseCliEnvelope(run.stdout);
  const metadata = extractMetadata(envelope);

  // Exit code 127 is the shell's "command not found"; treat it like a missing CLI.
  if (run.exitCode === 127) {
    return {
      status: InvocationStatus.PROVIDER_UNAVAILABLE,
      diagnostic: {
        code: "cli_not_found",
        summary: "The Claude CLI exited with 127 (command not found).",
      },
    };
  }

  const isSuccessfulResponse =
    envelope?.type === "result" &&
    envelope.subtype === "success" &&
    envelope.is_error === false &&
    typeof envelope.result === "string" &&
    run.exitCode === 0;
  const isCompletedAtTurnLimit =
    envelope?.type === "result" &&
    envelope.subtype === "error_max_turns" &&
    envelope.is_error === false &&
    run.exitCode === 0;

  if (isSuccessfulResponse || isCompletedAtTurnLimit) {
    // `error_max_turns` still means the model ran and allowance was consumed,
    // so it is a success for our purpose - retrying would only spend more.
    const code = isSuccessfulResponse ? "ok" : "ok_error_max_turns";
    return {
      status: InvocationStatus.SUCCESS,
      diagnostic: {
        code,
        summary: isSuccessfulResponse
          ? "Claude accepted the minimal invocation and returned a response."
          : "Claude executed the minimal invocation and stopped at the configured turn limit.",
      },
      metadata,
    };
  }

  // When the envelope parsed, `run.stdout` *is* that JSON - rescanning it would
  // only expose numeric fields (durations, token counts) to the patterns above.
  const haystack = envelope
    ? [envelope.result ?? "", run.stderr].join("\n")
    : [run.stderr, run.stdout].join("\n");
  for (const signal of SIGNALS) {
    if (signal.pattern.test(haystack)) {
      return {
        status: signal.status,
        diagnostic: { code: signal.code, summary: signal.summary },
        metadata,
      };
    }
  }

  const detail = envelope?.result?.trim() || run.stderr.trim() || run.stdout.trim();
  return {
    status: InvocationStatus.UNKNOWN_FAILURE,
    diagnostic: {
      code: "unclassified",
      summary: safeSummary(
        `Claude CLI exited with code ${run.exitCode ?? "null"} and no recognised signal. Output: ${
          detail || "(empty)"
        }`,
        secrets,
      ),
    },
    metadata,
  };
}

/**
 * Safe facts only. The response text, the prompt, and the session id are
 * deliberately excluded; `responseChars` is enough to confirm a real answer
 * came back without putting content into logs.
 */
function extractMetadata(envelope: ClaudeCliEnvelope | undefined): ProviderMetadata | undefined {
  if (!envelope) return undefined;
  const metadata: Record<string, string | number | boolean> = {};
  if (typeof envelope.subtype === "string") metadata.cliSubtype = envelope.subtype;
  if (typeof envelope.duration_ms === "number") metadata.cliDurationMs = envelope.duration_ms;
  if (typeof envelope.num_turns === "number") metadata.numTurns = envelope.num_turns;
  if (typeof envelope.total_cost_usd === "number") metadata.reportedCostUsd = envelope.total_cost_usd;
  if (typeof envelope.usage?.input_tokens === "number") metadata.inputTokens = envelope.usage.input_tokens;
  if (typeof envelope.usage?.output_tokens === "number") metadata.outputTokens = envelope.usage.output_tokens;
  if (typeof envelope.result === "string") metadata.responseChars = envelope.result.length;
  return Object.keys(metadata).length > 0 ? Object.freeze(metadata) : undefined;
}
