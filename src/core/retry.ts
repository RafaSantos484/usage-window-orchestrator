import { type InvocationStatus, policyFor } from "./invocation.ts";

export interface RetryPolicy {
  /** Total attempts per logical run, including the first. */
  readonly maxAttempts: number;
  /** Base delay; doubled per elapsed attempt and capped. */
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 2,
  backoffMs: 5_000,
  maxBackoffMs: 30_000,
});

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly reason: string }
  | { readonly retry: false; readonly reason: string };

/**
 * Decides purely from the *normalized* status - the orchestration layer never
 * inspects provider-specific error text.
 *
 * Deliberately conservative: a retry costs real subscription allowance, so we
 * only retry failures that are both clearly transient and clearly
 * non-consuming. Everything else fails the run. Whether and when a later
 * invocation occurs is the caller's policy, not the core's.
 */
export function decideRetry(
  status: InvocationStatus,
  attemptsMade: number,
  policy: RetryPolicy,
): RetryDecision {
  if (!policyFor(status).retryable) {
    return { retry: false, reason: `status "${status}" is not retryable` };
  }
  if (attemptsMade >= policy.maxAttempts) {
    return { retry: false, reason: `attempt budget exhausted (${policy.maxAttempts})` };
  }
  const delayMs = Math.min(policy.backoffMs * 2 ** (attemptsMade - 1), policy.maxBackoffMs);
  return { retry: true, delayMs, reason: `transient failure, attempt ${attemptsMade + 1} of ${policy.maxAttempts}` };
}
