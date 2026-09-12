import { InvocationStatus, type ProviderMetadata, type ProviderOutcome } from "../../core/invocation.ts";
import { summarize } from "../../core/logging.ts";
import type { ProcessRunResult } from "../../adapters/process-runner.ts";

/**
 * The subset of `codex exec --json` events we rely on.
 *
 * Every field is optional on purpose: the JSONL stream is an external contract
 * that can change between releases, and a shape change must degrade to
 * UNKNOWN_FAILURE rather than crash the run.
 */
export interface CodexEvent {
  readonly type?: string;
  /** Present on `turn.failed`. `codexErrorInfo` carries a stable error token. */
  readonly error?: { readonly message?: string; readonly codexErrorInfo?: unknown };
  /** Present on a top-level `error` event. */
  readonly message?: string;
  /** Optional typed error information on a top-level `error` event. */
  readonly codexErrorInfo?: unknown;
  /** Present on `turn.completed`. */
  readonly usage?: {
    readonly input_tokens?: number;
    readonly cached_input_tokens?: number;
    readonly output_tokens?: number;
    readonly reasoning_output_tokens?: number;
  };
  readonly item?: { readonly id?: string; readonly type?: string; readonly text?: string };
}

/** Bound on the distinct event types remembered for a fallback diagnostic. */
const MAX_EVENT_TYPES = 12;

/** Event types safe to expose as bounded CLI metadata. */
const KNOWN_EVENT_TYPES = new Set([
  "thread.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "item.started",
  "item.updated",
  "item.completed",
  "error",
]);
const UNKNOWN_EVENT_TYPE = "(unknown)";
const TRUSTED_ERROR_KINDS = new Set(["UsageLimitExceeded"]);

export interface CodexStream {
  readonly startedTurns: number;
  readonly completedTurns: number;
  readonly failedTurns: number;
  /** A known event violated the minimum turn lifecycle or ordering. */
  readonly lifecycleViolation: boolean;
  /** Number of valid JSON objects whose event type is not understood. */
  readonly unknownEventCount: number;
  /** Number of error-bearing events, without retaining their payloads. */
  readonly errorEventCount: number;
  /** Exact typed error discriminants, never arbitrary event payloads. */
  readonly errorKinds: readonly string[];
  /** Matched signal codes from allowlisted scalar message fields. */
  readonly errorSignalCodes: readonly string[];
  readonly usage: CodexEvent["usage"];
  readonly agentMessages: number;
  readonly agentMessageChars: number;
  /** Distinct event types, in first-seen order, bounded. Types only, no payloads. */
  readonly eventTypes: readonly string[];
  /** Type of the last event on the stream, which is the stable outcome marker. */
  readonly lastEventType?: string;
  /** All non-empty lines that were not parsable JSON objects. */
  readonly malformedLines: number;
  /** Lines that were JSON-shaped or valid JSON but not JSON objects. */
  readonly malformedJsonLines: number;
  /** Plain-text protocol noise, tolerated when structured evidence is clean. */
  readonly nonJsonNoiseLines: number;
  /** Plain-text output after a terminal turn event; never accepted as success. */
  readonly nonJsonLinesAfterTerminal: number;
}

/**
 * Parses the JSON Lines stream.
 *
 * Tolerates interleaved plain-text noise. Unknown event types are recorded so
 * classification can fail closed, while JSON-shaped malformed lines are
 * tracked separately because they can hide a later error or terminal event
 * and therefore disqualify success.
 */
export function parseCodexStream(stdout: string): CodexStream {
  let startedTurns = 0;
  let completedTurns = 0;
  let failedTurns = 0;
  let lifecycleViolation = false;
  let unknownEventCount = 0;
  let errorEventCount = 0;
  let malformedLines = 0;
  let malformedJsonLines = 0;
  let nonJsonNoiseLines = 0;
  let nonJsonLinesAfterTerminal = 0;
  let agentMessages = 0;
  let agentMessageChars = 0;
  let usage: CodexEvent["usage"];
  let lastEventType: string | undefined;
  let sawTerminalEvent = false;
  let turnState: "before_turn" | "in_turn" | "terminal" = "before_turn";
  let sawThreadStarted = false;
  const itemStates = new Map<string, "started" | "completed">();
  const errorKinds: string[] = [];
  const errorSignalCodes: string[] = [];
  const eventTypes: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const parsed = tryParseObject(line);
    if (!parsed.event) {
      malformedLines += 1;
      if (parsed.isJson || line.startsWith("{") || line.startsWith("[")) malformedJsonLines += 1;
      else if (sawTerminalEvent) nonJsonLinesAfterTerminal += 1;
      else nonJsonNoiseLines += 1;
      continue;
    }
    const event = parsed.event;
    let validItemCompletion = false;

    const rawType = typeof event.type === "string" ? event.type : undefined;
    const type = rawType ?? "(untyped)";
    if (rawType === undefined || !KNOWN_EVENT_TYPES.has(rawType)) {
      unknownEventCount += 1;
      lastEventType = UNKNOWN_EVENT_TYPE;
      if (!eventTypes.includes(UNKNOWN_EVENT_TYPE) && eventTypes.length < MAX_EVENT_TYPES) {
        eventTypes.push(UNKNOWN_EVENT_TYPE);
      }
    } else {
      lastEventType = rawType;
      if (!eventTypes.includes(rawType) && eventTypes.length < MAX_EVENT_TYPES) eventTypes.push(rawType);
    }

    if (rawType !== undefined && KNOWN_EVENT_TYPES.has(rawType)) {
      if (turnState === "terminal") lifecycleViolation = true;

      switch (rawType) {
        case "thread.started":
          if (sawThreadStarted || turnState !== "before_turn") lifecycleViolation = true;
          sawThreadStarted = true;
          break;
        case "turn.started":
          startedTurns += 1;
          if (turnState !== "before_turn") lifecycleViolation = true;
          turnState = "in_turn";
          break;
        case "item.started": {
          const itemId = readItemId(event);
          if (turnState !== "in_turn" || !itemId || itemStates.has(itemId)) {
            lifecycleViolation = true;
          } else {
            itemStates.set(itemId, "started");
          }
          break;
        }
        case "item.updated": {
          const itemId = readItemId(event);
          if (turnState !== "in_turn" || !itemId || itemStates.get(itemId) !== "started") {
            lifecycleViolation = true;
          }
          break;
        }
        case "item.completed": {
          const itemId = readItemId(event);
          if (turnState !== "in_turn" || !itemId || itemStates.get(itemId) !== "started") {
            lifecycleViolation = true;
          } else {
            itemStates.set(itemId, "completed");
            validItemCompletion = true;
          }
          break;
        }
        case "turn.completed":
          if (turnState !== "in_turn") lifecycleViolation = true;
          if ([...itemStates.values()].some((state) => state === "started")) lifecycleViolation = true;
          turnState = "terminal";
          break;
        case "turn.failed":
          if (turnState !== "in_turn") lifecycleViolation = true;
          turnState = "terminal";
          break;
        case "error":
          // An error can precede a turn failure, but a structured error after
          // a terminal event is contradictory lifecycle evidence.
          break;
      }
    }

    if (type === "turn.completed") {
      completedTurns += 1;
      sawTerminalEvent = true;
      // Keep the last reported usage; a single-turn run reports it once.
      usage = readUsage(event.usage);
    } else if (type === "turn.failed") {
      failedTurns += 1;
      sawTerminalEvent = true;
    } else if (type === "item.completed" && validItemCompletion && event.item?.type === "agent_message") {
      agentMessages += 1;
      if (typeof event.item.text === "string") agentMessageChars += event.item.text.length;
    }

    if (type === "error" || type === "turn.failed") {
      errorEventCount += 1;
      const errorKind = readErrorKind(type === "turn.failed" ? event.error?.codexErrorInfo : event.codexErrorInfo);
      if (errorKind && !errorKinds.includes(errorKind)) errorKinds.push(errorKind);

      const message = type === "turn.failed" ? event.error?.message : event.message;
      if (typeof message === "string") {
        for (const code of matchingSignalCodes(message)) {
          if (!errorSignalCodes.includes(code)) errorSignalCodes.push(code);
        }
      }
    }
  }

  return {
    startedTurns,
    completedTurns,
    failedTurns,
    lifecycleViolation,
    unknownEventCount,
    errorEventCount,
    errorKinds: Object.freeze(errorKinds),
    errorSignalCodes: Object.freeze(errorSignalCodes),
    usage,
    agentMessages,
    agentMessageChars,
    eventTypes: Object.freeze(eventTypes),
    lastEventType,
    malformedLines,
    malformedJsonLines,
    nonJsonNoiseLines,
    nonJsonLinesAfterTerminal,
  };
}

function readItemId(event: CodexEvent): string | undefined {
  const id = event.item?.id;
  return typeof id === "string" && id.trim() ? id : undefined;
}

function readErrorKind(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const type = (value as { readonly type?: unknown }).type;
  return typeof type === "string" && TRUSTED_ERROR_KINDS.has(type) ? type : undefined;
}

function readUsage(value: unknown): CodexEvent["usage"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const [sourceKey, targetKey] of [
    ["input_tokens", "input_tokens"],
    ["cached_input_tokens", "cached_input_tokens"],
    ["output_tokens", "output_tokens"],
    ["reasoning_output_tokens", "reasoning_output_tokens"],
  ] as const) {
    const number = source[sourceKey];
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) {
      usage[targetKey] = number;
    }
  }
  return Object.keys(usage).length > 0 ? Object.freeze(usage) : undefined;
}

function tryParseObject(text: string): { readonly event?: CodexEvent; readonly isJson: boolean } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { event: parsed as CodexEvent, isJson: true };
    }
  } catch {
    return { isJson: false };
  }
  return { isJson: true };
}

interface Signal {
  readonly code: string;
  readonly status: InvocationStatus;
  readonly pattern: RegExp;
  readonly summary: string;
}

/**
 * Matches an HTTP-ish status code only when it is preceded by error context,
 * so a number that happens to appear elsewhere in an error payload cannot be
 * read as a status code. Mirrors the Claude adapter's guard.
 */
function statusCode(pattern: string): string {
  return `(?:error|status|http|code)\\D{0,6}${pattern}\\b`;
}

/**
 * Ordered failure signals. First match wins, so the more specific and more
 * consequential classifications come first.
 *
 * These patterns are matched against CLI error output only. They are the
 * single place in the codebase that knows what Codex failures look like; the
 * orchestrator sees only the normalized status.
 *
 * The structured `UsageLimitExceeded` discriminant is handled separately by
 * exact field equality. These patterns are only for allowlisted scalar
 * messages and stderr; they never become diagnostic content.
 */
const SIGNALS: readonly Signal[] = Object.freeze([
  {
    code: "api_billing_path_detected",
    status: InvocationStatus.AUTH_FAILURE,
    pattern:
      /insufficient_quota|exceeded your current quota|check your plan and billing|billing_(?:not_active|hard_limit_reached)/i,
    summary:
      "Codex reported an OpenAI Platform billing error, which indicates an API key rather than a Codex access token. Check that CODEX_ACCESS_TOKEN holds a Codex access token and that CODEX_API_KEY and OPENAI_API_KEY are not set.",
  },
  {
    code: "auth_failed",
    status: InvocationStatus.AUTH_FAILURE,
    pattern: new RegExp(
      [
        // A bare "forbidden" is deliberately absent: sandbox and permission
        // errors use that word too, and a real 403 is already covered by the
        // status-code guard below.
        "\\bunauthorized\\b",
        "authentication_failed",
        "authentication_error",
        "not logged in",
        "please run `?(?:codex )?login`?",
        "codex login --with-access-token",
        "invalid api key",
        "invalid(?: access)? token",
        "access token (?:has )?expired",
        "token (?:is )?(?:invalid|expired|revoked)",
        "no credentials found",
        statusCode("40[13]"),
      ].join("|"),
      "i",
    ),
    summary:
      "Codex rejected the supplied credentials. Regenerate CODEX_ACCESS_TOKEN at https://chatgpt.com/admin/access-tokens and update the repository secret.",
  },
  {
    code: "provider_rate_limited",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern: new RegExp(
      ["rate_limit_exceeded", "rate limit exceeded", "too many requests", statusCode("429")].join("|"),
      "i",
    ),
    summary: "Codex rate-limited the invocation; the output does not prove which limit was reached.",
  },
  {
    code: "ambiguous_upstream",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern: new RegExp(
      [
        "HttpConnectionFailed",
        "InternalServerError",
        "ResponseTooManyFailedAttempts",
        statusCode("5\\d{2}"),
        "service unavailable",
        "internal server error",
        "bad gateway",
        "gateway timeout",
        "server_error",
      ].join("|"),
      "i",
    ),
    summary: "Codex returned an upstream failure; the request may have reached the model, so it was not retried.",
  },
  {
    code: "ambiguous_stream",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern: new RegExp(
      [
        "ResponseStreamDisconnected",
        "ResponseStreamConnectionFailed",
        "model response stream ended unexpectedly",
        "stream (?:error|disconnected)",
        "ECONNRESET",
        "ETIMEDOUT",
        "EPIPE",
        "broken pipe",
        "fetch failed",
        "network error",
        "request timed out",
      ].join("|"),
      "i",
    ),
    summary:
      "The response stream failed after the invocation began; the request may have reached the model, so it was not retried.",
  },
  {
    code: "invalid_request",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern:
      /ContextWindowExceeded|BadRequest|invalid_request_error|unsupported(?:_| )model|model .{0,40}(?:not found|not available)/i,
    summary:
      "Codex rejected the request itself. Check AGENT_MODEL (or vars.AGENT_CODEX_MODEL in GitHub Actions) and AGENT_PROMPT; this is a configuration problem, not a transient one.",
  },
  {
    code: "sandbox_error",
    status: InvocationStatus.UNKNOWN_FAILURE,
    pattern: /SandboxError|sandbox (?:error|denied|setup failed)|landlock|seccomp/i,
    summary:
      "Codex could not establish its sandbox on this runner. The invocation is deliberately run read-only; it was not retried.",
  },
]);

function matchingSignalCodes(text: string): readonly string[] {
  return SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => signal.code);
}

/**
 * Selects the highest-priority signal observed anywhere in the stream.
 * Event order is deliberately ignored: a later authentication or billing
 * error must not be hidden by earlier usage-limit prose.
 */
function highestPrioritySignal(codes: readonly string[]): Signal | undefined {
  const observed = new Set(codes);
  return SIGNALS.find((signal) => observed.has(signal.code));
}

const NOT_FOUND_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR"]);
const MAX_DIAGNOSTIC_LENGTH = 240;

/** Keeps dynamic, content-free diagnostics within the shared bound. */
function boundedSummary(text: string): string {
  return summarize(text, MAX_DIAGNOSTIC_LENGTH);
}

/**
 * Maps a completed CLI run onto the provider-neutral outcome vocabulary.
 *
 * Order of reasoning:
 *   1. could the binary run at all?            -> PROVIDER_UNAVAILABLE
 *   2. did we kill it on the deadline?         -> TIMEOUT
 *   3. did credential or wrong-billing evidence appear? -> AUTH_FAILURE
 *   4. did exactly one clean turn lifecycle produce one response, terminate the known
 *      stream, and exit 0?                          -> SUCCESS
 *   5. did the stream contain unknown or malformed JSON? -> UNKNOWN_FAILURE
 *   6. did a typed limit conflict with completion evidence? -> UNKNOWN_FAILURE
 *   7. did a typed limit appear without completion evidence? -> USAGE_LIMIT_REACHED
 *   8. do any safe fallback signals match?             -> that signal's status
 *   9. otherwise                                       -> UNKNOWN_FAILURE
 *
 * A zero exit code is never sufficient on its own: `codex exec` can emit
 * `error` and `turn.failed` events, and the classifier requires positive
 * evidence of exactly one ordered `turn.started` -> item lifecycle ->
 * `turn.completed` sequence with one non-empty response.
 */
export function classifyCodexRun(run: ProcessRunResult): ProviderOutcome {
  if (run.spawnErrorCode && NOT_FOUND_CODES.has(run.spawnErrorCode)) {
    return {
      status: InvocationStatus.PROVIDER_UNAVAILABLE,
      diagnostic: {
        code: "cli_not_executable",
        summary: boundedSummary(
          `The Codex CLI could not be executed (${run.spawnErrorCode}). Install @openai/codex or set AGENT_CODEX_BIN.`,
        ),
      },
    };
  }

  if (run.spawnErrorCode) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "cli_spawn_failed",
        summary: boundedSummary(`The Codex CLI failed to start (${run.spawnErrorCode}).`),
      },
    };
  }

  if (run.timedOut) {
    return {
      status: InvocationStatus.TIMEOUT,
      diagnostic: {
        code: "cli_timeout",
        summary: "The Codex CLI did not complete within the configured timeout and was terminated.",
      },
    };
  }

  // Exit code 127 is the shell's "command not found"; treat it like a missing CLI.
  if (run.exitCode === 127) {
    return {
      status: InvocationStatus.PROVIDER_UNAVAILABLE,
      diagnostic: {
        code: "cli_not_found",
        summary: "The Codex CLI exited with 127 (command not found).",
      },
    };
  }

  if (run.stdoutTruncated || run.stderrTruncated) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "output_truncated",
        summary: "Codex output exceeded the capture limit; the complete invocation outcome could not be verified and was not retried.",
      },
    };
  }

  const stream = parseCodexStream(run.stdout);
  const metadata = extractMetadata(stream);
  const turnLooksClean =
    stream.startedTurns === 1 &&
    stream.completedTurns === 1 &&
    stream.failedTurns === 0 &&
    stream.unknownEventCount === 0 &&
    stream.errorEventCount === 0 &&
    stream.malformedJsonLines === 0 &&
    stream.nonJsonLinesAfterTerminal === 0 &&
    !stream.lifecycleViolation &&
    stream.lastEventType === "turn.completed";
  const responseLooksComplete = stream.agentMessages === 1 && stream.agentMessageChars > 0;
  const signal = highestPrioritySignal([...stream.errorSignalCodes, ...matchingSignalCodes(run.stderr)]);
  const credentialSignal =
    signal?.code === "api_billing_path_detected" || signal?.code === "auth_failed" ? signal : undefined;

  // Credential and billing evidence must never be hidden by protocol-change
  // diagnostics or a superficially successful completion.
  if (credentialSignal) {
    return {
      status: credentialSignal.status,
      diagnostic: { code: credentialSignal.code, summary: credentialSignal.summary },
      metadata,
    };
  }

  if (turnLooksClean && responseLooksComplete && signal) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "conflicting_terminal_evidence",
        summary:
          "Codex reported both a completed response and failure evidence; allowance consumption is ambiguous, so the run was not retried.",
      },
      metadata,
    };
  }

  if (turnLooksClean && responseLooksComplete && run.exitCode === 0) {
    return {
      status: InvocationStatus.SUCCESS,
      diagnostic: {
        code: "ok",
        summary: "Codex accepted the minimal invocation and produced one response.",
      },
      metadata,
    };
  }

  if (stream.unknownEventCount > 0) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "unknown_event_type",
        summary: "Codex emitted an unrecognised JSONL event; the invocation outcome was not trusted.",
      },
      metadata,
    };
  }

  if (stream.malformedJsonLines > 0) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "malformed_jsonl",
        summary: "Codex emitted malformed JSONL; the invocation outcome was not trusted.",
      },
      metadata,
    };
  }

  if (stream.nonJsonLinesAfterTerminal > 0) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "trailing_output",
        summary: "Codex emitted unstructured output after a terminal turn event; the outcome was not trusted.",
      },
      metadata,
    };
  }

  if (stream.completedTurns > 1) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "unexpected_turn_count",
        summary: "Codex reported more than one completed turn; the minimal single-turn contract was not satisfied.",
      },
      metadata,
    };
  }

  if (stream.lifecycleViolation) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "invalid_event_sequence",
        summary: "Codex emitted a known event sequence that did not form one valid turn lifecycle.",
      },
      metadata,
    };
  }

  if (stream.errorKinds.includes("UsageLimitExceeded")) {
    if (stream.completedTurns > 0 || stream.agentMessages > 0) {
      return {
        status: InvocationStatus.UNKNOWN_FAILURE,
        diagnostic: {
          code: "conflicting_terminal_evidence",
          summary:
            "Codex reported both completion and usage-limit evidence; allowance consumption is ambiguous, so the run was not retried.",
        },
        metadata,
      };
    }

    return {
      status: InvocationStatus.USAGE_LIMIT_REACHED,
      diagnostic: {
        code: "usage_limit_reached",
        summary: "Codex reported that an applicable ChatGPT workspace usage limit is currently reached.",
      },
      metadata,
    };
  }

  if (signal) {
    return {
      status: signal.status,
      diagnostic: { code: signal.code, summary: signal.summary },
      metadata,
    };
  }

  // A turn completed, so allowance was almost certainly consumed, but the
  // process still failed. Never retryable: repeating it would spend more.
  if (turnLooksClean) {
    if (run.exitCode === 0 && !responseLooksComplete) {
      const multipleResponses = stream.agentMessages > 1;
      return {
        status: InvocationStatus.UNKNOWN_FAILURE,
        diagnostic: {
          code: multipleResponses ? "unexpected_response_count" : "completed_turn_without_response",
          summary: multipleResponses
            ? "Codex completed a turn with more than one agent response; the minimal response contract was not satisfied."
            : "Codex completed a turn without one verifiable non-empty agent response.",
        },
        metadata,
      };
    }

    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "completed_turn_nonzero_exit",
        summary: boundedSummary(
          `Codex completed a turn but exited with code ${
            run.exitCode ?? "null"
          }. The invocation may already have consumed allowance, so it was not retried.`,
        ),
      },
      metadata,
    };
  }

  if (run.exitCode === 0) {
    return {
      status: InvocationStatus.UNKNOWN_FAILURE,
      diagnostic: {
        code: "incomplete_turn",
        summary: boundedSummary(`Codex exited successfully without a completed turn. ${describeStream(stream)}`),
      },
      metadata,
    };
  }

  return {
    status: InvocationStatus.UNKNOWN_FAILURE,
    diagnostic: {
      code: "unclassified",
      summary: boundedSummary(
        `Codex CLI exited with code ${run.exitCode ?? "null"} and no recognised signal. ${detailFor(stream)}`,
      ),
    },
    metadata,
  };
}

/**
 * Bounded, content-free description of what the stream contained. It gives
 * the operator useful shape information without exposing provider output.
 */
function describeStream(stream: CodexStream): string {
  const seen = stream.eventTypes.length > 0 ? stream.eventTypes.join(", ") : "none";
  return `Events seen: ${seen}. Unparsable lines: ${stream.malformedLines} (JSON: ${stream.malformedJsonLines}, noise: ${stream.nonJsonNoiseLines}, trailing: ${stream.nonJsonLinesAfterTerminal}).`;
}

/**
 * Detail for the fallback diagnostic. Provider output is never quoted: error
 * events and stderr are also untrusted and may contain prompts, responses,
 * identifiers or filesystem contents.
 */
function detailFor(stream: CodexStream): string {
  return describeStream(stream);
}

/**
 * Safe facts only. The response text, the prompt, the thread id and every item
 * payload are deliberately excluded; `responseChars` is enough to confirm a
 * real answer came back without putting content into logs.
 */
function extractMetadata(stream: CodexStream): ProviderMetadata | undefined {
  const metadata: Record<string, string | number | boolean> = {};
  if (stream.startedTurns > 0) metadata.turnStarts = stream.startedTurns;
  if (stream.completedTurns > 0) metadata.numTurns = stream.completedTurns;
  if (stream.failedTurns > 0) metadata.failedTurns = stream.failedTurns;
  if (stream.lifecycleViolation) metadata.invalidEventSequence = true;
  if (stream.unknownEventCount > 0) metadata.unknownEvents = stream.unknownEventCount;
  if (stream.agentMessages > 0) {
    metadata.agentMessages = stream.agentMessages;
    metadata.responseChars = stream.agentMessageChars;
  }
  const usage = stream.usage;
  if (typeof usage?.input_tokens === "number") metadata.inputTokens = usage.input_tokens;
  if (typeof usage?.cached_input_tokens === "number") metadata.cachedInputTokens = usage.cached_input_tokens;
  if (typeof usage?.output_tokens === "number") metadata.outputTokens = usage.output_tokens;
  if (typeof usage?.reasoning_output_tokens === "number") {
    metadata.reasoningOutputTokens = usage.reasoning_output_tokens;
  }
  if (stream.lastEventType !== undefined) metadata.cliLastEvent = stream.lastEventType;
  if (stream.malformedLines > 0) metadata.malformedOutputLines = stream.malformedLines;
  if (stream.malformedJsonLines > 0) metadata.malformedJsonLines = stream.malformedJsonLines;
  if (stream.nonJsonNoiseLines > 0) metadata.nonJsonNoiseLines = stream.nonJsonNoiseLines;
  if (stream.nonJsonLinesAfterTerminal > 0) {
    metadata.nonJsonLinesAfterTerminal = stream.nonJsonLinesAfterTerminal;
  }
  return Object.keys(metadata).length > 0 ? Object.freeze(metadata) : undefined;
}
