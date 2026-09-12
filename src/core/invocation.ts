/**
 * Provider-neutral invocation vocabulary.
 *
 * Terminology note: this project deliberately avoids "ping". A ping implies a
 * non-consuming liveness probe; what we do here is a *minimal authenticated
 * invocation* that intentionally consumes a small amount of the user's own
 * subscription allowance. See docs/adr/0001-architecture.md.
 */

/** Who asked for this invocation. */
export type TriggerSource = "scheduled" | "manual";

/**
 * Normalized outcome of an invocation attempt.
 *
 * This set is intentionally small and provider-neutral. Adapters map their
 * native failure modes onto it; the orchestrator reasons about nothing else.
 */
export const InvocationStatus = {
  /** The provider accepted the request and produced a response. Allowance was consumed. */
  SUCCESS: "success",
  /** The provider refused because the subscription's usage limit is currently reached. */
  USAGE_LIMIT_REACHED: "usage_limit_reached",
  /** Credentials are missing, invalid, expired, or not usable for this billing path. */
  AUTH_FAILURE: "auth_failure",
  /** The provider did not answer within the configured budget. */
  TIMEOUT: "timeout",
  /** The provider's entry point could not be executed at all (not installed / not on PATH). */
  PROVIDER_UNAVAILABLE: "provider_unavailable",
  /** A clearly transient pre-acceptance failure proving the invocation was not accepted. */
  TRANSIENT_FAILURE: "transient_failure",
  /** Anything the adapter could not confidently classify. */
  UNKNOWN_FAILURE: "unknown_failure",
  /** No provider call was made because this was a dry run. */
  SKIPPED: "skipped",
} as const;

export type InvocationStatus = (typeof InvocationStatus)[keyof typeof InvocationStatus];

/**
 * Severity drives how the execution platform should present the run.
 *
 * `neutral` exists because a usage limit is an expected *operational* outcome,
 * not an infrastructure defect - see docs/adr/0001-architecture.md.
 */
export type Severity = "ok" | "neutral" | "error";

/**
 * Process exit codes. Distinct codes let the workflow (or any other caller)
 * distinguish "worked", "deliberately did nothing", and the different reasons
 * for failing, without parsing logs.
 */
export const ExitCode = {
  SUCCESS: 0,
  SKIPPED: 0,
  USAGE_LIMIT_REACHED: 10,
  CONFIG_ERROR: 20,
  AUTH_FAILURE: 21,
  PROVIDER_UNAVAILABLE: 22,
  TIMEOUT: 30,
  TRANSIENT_FAILURE: 31,
  UNKNOWN_FAILURE: 40,
} as const;

export interface StatusPolicy {
  /** May the orchestrator try again within the same logical run? */
  readonly retryable: boolean;
  readonly severity: Severity;
  readonly exitCode: number;
}

/**
 * The single source of truth for how each normalized status is treated.
 *
 * Retry policy is conservative by design. Only TRANSIENT_FAILURE is retried:
 * every other failure either cannot be fixed by retrying (auth, usage limit,
 * missing binary) or leaves us unable to prove that nothing was consumed
 * (timeout, unknown), where a retry risks double-spending allowance.
 */
const POLICY: Readonly<Record<InvocationStatus, StatusPolicy>> = Object.freeze({
  [InvocationStatus.SUCCESS]: {
    retryable: false,
    severity: "ok",
    exitCode: ExitCode.SUCCESS,
  },
  [InvocationStatus.USAGE_LIMIT_REACHED]: {
    retryable: false,
    severity: "neutral",
    exitCode: ExitCode.USAGE_LIMIT_REACHED,
  },
  [InvocationStatus.AUTH_FAILURE]: {
    retryable: false,
    severity: "error",
    exitCode: ExitCode.AUTH_FAILURE,
  },
  [InvocationStatus.TIMEOUT]: {
    retryable: false,
    severity: "error",
    exitCode: ExitCode.TIMEOUT,
  },
  [InvocationStatus.PROVIDER_UNAVAILABLE]: {
    retryable: false,
    severity: "error",
    exitCode: ExitCode.PROVIDER_UNAVAILABLE,
  },
  [InvocationStatus.TRANSIENT_FAILURE]: {
    retryable: true,
    severity: "error",
    exitCode: ExitCode.TRANSIENT_FAILURE,
  },
  [InvocationStatus.UNKNOWN_FAILURE]: {
    retryable: false,
    severity: "error",
    exitCode: ExitCode.UNKNOWN_FAILURE,
  },
  [InvocationStatus.SKIPPED]: {
    retryable: false,
    severity: "neutral",
    exitCode: ExitCode.SKIPPED,
  },
});

export function policyFor(status: InvocationStatus): StatusPolicy {
  return POLICY[status];
}

/** What the orchestrator hands to a provider adapter. */
export interface InvocationRequest {
  readonly invocationId: string;
  readonly providerId: string;
  readonly triggerSource: TriggerSource;
  /** Deterministic, minimal prompt. */
  readonly prompt: string;
  /** Provider model identifier or alias, when the provider supports selection. */
  readonly model?: string;
  readonly timeoutMs: number;
}

/**
 * Safe, human-readable diagnostic.
 *
 * `code` is a stable machine token; `summary` is a bounded, secret-safe
 * explanation suitable for logs and job summaries. Providers may use fixed
 * summaries rather than quoting provider output. Neither ever carries
 * credentials.
 */
export interface Diagnostic {
  readonly code: string;
  readonly summary: string;
}

/** Structured facts an adapter may attach. Must never contain secrets or response text. */
export type ProviderMetadata = Readonly<Record<string, string | number | boolean>>;

/** What an adapter returns for a single attempt. */
export interface ProviderOutcome {
  readonly status: InvocationStatus;
  readonly diagnostic: Diagnostic;
  readonly metadata?: ProviderMetadata;
}

/** Immutable, provider-neutral record of one logical run. */
export interface InvocationResult {
  readonly providerId: string;
  readonly invocationId: string;
  readonly triggerSource: TriggerSource;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly retried: boolean;
  readonly status: InvocationStatus;
  readonly severity: Severity;
  readonly exitCode: number;
  readonly diagnostic: Diagnostic;
  readonly metadata?: ProviderMetadata;
}
