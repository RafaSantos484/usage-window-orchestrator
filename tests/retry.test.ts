import { describe, expect, it } from "vitest";
import { DEFAULT_RETRY_POLICY, decideRetry } from "../src/core/retry.ts";
import { InvocationStatus, policyFor } from "../src/core/invocation.ts";

const policy = { maxAttempts: 3, backoffMs: 1_000, maxBackoffMs: 4_000 };

describe("decideRetry", () => {
  it("retries a transient failure while the budget allows", () => {
    const decision = decideRetry(InvocationStatus.TRANSIENT_FAILURE, 1, policy);
    expect(decision.retry).toBe(true);
    if (decision.retry) expect(decision.delayMs).toBe(1_000);
  });

  it("backs off exponentially and respects the cap", () => {
    const second = decideRetry(InvocationStatus.TRANSIENT_FAILURE, 2, policy);
    expect(second.retry && second.delayMs).toBe(2_000);

    const capped = decideRetry(InvocationStatus.TRANSIENT_FAILURE, 2, {
      ...policy,
      backoffMs: 10_000,
    });
    expect(capped.retry && capped.delayMs).toBe(4_000);
  });

  it("stops once the attempt budget is spent", () => {
    expect(decideRetry(InvocationStatus.TRANSIENT_FAILURE, 3, policy).retry).toBe(false);
  });

  it.each([
    InvocationStatus.SUCCESS,
    InvocationStatus.USAGE_LIMIT_REACHED,
    InvocationStatus.AUTH_FAILURE,
    InvocationStatus.TIMEOUT,
    InvocationStatus.PROVIDER_UNAVAILABLE,
    InvocationStatus.UNKNOWN_FAILURE,
    InvocationStatus.SKIPPED,
  ])("never retries %s", (status) => {
    expect(decideRetry(status, 1, policy).retry).toBe(false);
  });

  it("ships a conservative default policy", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(2);
  });
});

describe("status policy", () => {
  it("treats a usage limit as a neutral operational outcome, not an error", () => {
    expect(policyFor(InvocationStatus.USAGE_LIMIT_REACHED).severity).toBe("neutral");
  });

  it("gives every failure mode a distinct exit code", () => {
    const codes = [
      InvocationStatus.USAGE_LIMIT_REACHED,
      InvocationStatus.AUTH_FAILURE,
      InvocationStatus.TIMEOUT,
      InvocationStatus.PROVIDER_UNAVAILABLE,
      InvocationStatus.TRANSIENT_FAILURE,
      InvocationStatus.UNKNOWN_FAILURE,
    ].map((status) => policyFor(status).exitCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
