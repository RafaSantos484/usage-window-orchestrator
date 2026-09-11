import { describe, expect, it, vi } from "vitest";
import { UsageWindowOrchestrator, type TriggerOptions } from "../src/core/orchestrator.ts";
import { ExitCode, InvocationStatus } from "../src/core/invocation.ts";
import { DEFAULT_RETRY_POLICY } from "../src/core/retry.ts";
import { FakeProvider, RecordingLogger, ThrowingProvider, failure, ok, steppingClock } from "./helpers.ts";

const BASE_OPTIONS: TriggerOptions = {
  triggerSource: "scheduled",
  prompt: "Reply with the single word: ok",
  timeoutMs: 30_000,
  retryPolicy: DEFAULT_RETRY_POLICY,
  dryRun: false,
};

function build(provider: FakeProvider | ThrowingProvider) {
  const logger = new RecordingLogger();
  const sleep = vi.fn(async () => {});
  const orchestrator = new UsageWindowOrchestrator({
    provider,
    logger,
    now: steppingClock("2026-09-11T07:00:00.000Z"),
    sleep,
    newInvocationId: () => "inv-test",
  });
  return { orchestrator, logger, sleep };
}

describe("UsageWindowOrchestrator", () => {
  it("returns a normalized success result", async () => {
    const provider = new FakeProvider([ok()]);
    const { orchestrator } = build(provider);

    const result = await orchestrator.trigger(BASE_OPTIONS);

    expect(result.status).toBe(InvocationStatus.SUCCESS);
    expect(result.severity).toBe("ok");
    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.attempts).toBe(1);
    expect(result.retried).toBe(false);
    expect(result.providerId).toBe("fake");
  });

  it("passes the prompt and model through to the provider unchanged", async () => {
    const provider = new FakeProvider([ok()]);
    const { orchestrator } = build(provider);

    await orchestrator.trigger({ ...BASE_OPTIONS, model: "haiku" });

    expect(provider.requests[0]?.prompt).toBe(BASE_OPTIONS.prompt);
    expect(provider.requests[0]?.model).toBe("haiku");
    expect(provider.requests[0]?.timeoutMs).toBe(30_000);
  });

  it("retries a transient failure and succeeds on the second attempt", async () => {
    const provider = new FakeProvider([failure(InvocationStatus.TRANSIENT_FAILURE), ok()]);
    const { orchestrator, sleep, logger } = build(provider);

    const result = await orchestrator.trigger(BASE_OPTIONS);

    expect(result.status).toBe(InvocationStatus.SUCCESS);
    expect(result.attempts).toBe(2);
    expect(result.retried).toBe(true);
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(DEFAULT_RETRY_POLICY.backoffMs);
    expect(logger.events()).toContain("retry.scheduled");
  });

  it("stops once the attempt budget is exhausted", async () => {
    const provider = new FakeProvider([
      failure(InvocationStatus.TRANSIENT_FAILURE),
      failure(InvocationStatus.TRANSIENT_FAILURE),
    ]);
    const { orchestrator } = build(provider);

    const result = await orchestrator.trigger(BASE_OPTIONS);

    expect(result.status).toBe(InvocationStatus.TRANSIENT_FAILURE);
    expect(result.attempts).toBe(2);
    expect(result.exitCode).toBe(ExitCode.TRANSIENT_FAILURE);
    expect(provider.attemptCount).toBe(2);
  });

  it.each([
    [InvocationStatus.USAGE_LIMIT_REACHED, ExitCode.USAGE_LIMIT_REACHED, "neutral"],
    [InvocationStatus.AUTH_FAILURE, ExitCode.AUTH_FAILURE, "error"],
    [InvocationStatus.TIMEOUT, ExitCode.TIMEOUT, "error"],
    [InvocationStatus.PROVIDER_UNAVAILABLE, ExitCode.PROVIDER_UNAVAILABLE, "error"],
    [InvocationStatus.UNKNOWN_FAILURE, ExitCode.UNKNOWN_FAILURE, "error"],
  ])("never retries %s", async (status, exitCode, severity) => {
    const provider = new FakeProvider([failure(status)]);
    const { orchestrator, sleep } = build(provider);

    const result = await orchestrator.trigger(BASE_OPTIONS);

    expect(provider.attemptCount).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.status).toBe(status);
    expect(result.exitCode).toBe(exitCode);
    expect(result.severity).toBe(severity);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("skips the provider entirely on a dry run", async () => {
    const provider = new FakeProvider([ok()]);
    const { orchestrator } = build(provider);

    const result = await orchestrator.trigger({ ...BASE_OPTIONS, dryRun: true });

    expect(provider.attemptCount).toBe(0);
    expect(result.status).toBe(InvocationStatus.SKIPPED);
    expect(result.diagnostic.code).toBe("dry_run");
    expect(result.exitCode).toBe(ExitCode.SKIPPED);
  });

  it("maps a contract-violating adapter exception to a non-retryable unknown failure", async () => {
    const { orchestrator } = build(new ThrowingProvider());

    const result = await orchestrator.trigger(BASE_OPTIONS);

    expect(result.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(result.diagnostic.code).toBe("adapter_exception");
    expect(result.attempts).toBe(1);
    expect(result.diagnostic.summary).not.toContain("sk-ant-oat01");
    expect(result.diagnostic.summary).toContain("[redacted]");
  });

  it("gives up on an adapter that ignores its abort signal", async () => {
    vi.useFakeTimers();
    try {
      const provider = new FakeProvider([], { hang: true });
      const { orchestrator } = build(provider);

      const pending = orchestrator.trigger({ ...BASE_OPTIONS, timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(7_000);
      const result = await pending;

      expect(result.status).toBe(InvocationStatus.TIMEOUT);
      expect(result.diagnostic.code).toBe("adapter_unresponsive");
    } finally {
      vi.useRealTimers();
    }
  });
});
