import {
  InvocationStatus,
  type InvocationRequest,
  type InvocationResult,
  type ProviderOutcome,
  type TriggerSource,
  policyFor,
} from "./invocation.ts";
import type { AgentProvider } from "./provider.ts";
import { decideRetry, type RetryPolicy } from "./retry.ts";
import { safeSummary, type Logger } from "./logging.ts";

/**
 * Grace period added to the adapter's own deadline before the orchestrator
 * gives up on it. A well-behaved adapter aborts on the signal well inside
 * this; the backstop only exists so a misbehaving one cannot hang the job.
 */
const ABORT_GRACE_MS = 5_000;

export interface OrchestratorDeps {
  readonly provider: AgentProvider;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newInvocationId: () => string;
}

export interface TriggerOptions {
  readonly triggerSource: TriggerSource;
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly retryPolicy: RetryPolicy;
  /** Validate and orchestrate without calling the provider or spending allowance. */
  readonly dryRun: boolean;
}

/**
 * The single application use case: decide whether an invocation should happen,
 * perform it through the provider port and classify the outcome.
 *
 * Knows nothing about Claude, about child processes, or about GitHub Actions.
 */
export class UsageWindowOrchestrator {
  readonly #deps: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  async trigger(options: TriggerOptions): Promise<InvocationResult> {
    const { provider, logger, now, newInvocationId } = this.#deps;
    const startedAt = now();
    const invocationId = newInvocationId();

    const request: InvocationRequest = {
      invocationId,
      providerId: provider.id,
      triggerSource: options.triggerSource,
      prompt: options.prompt,
      model: options.model,
      timeoutMs: options.timeoutMs,
    };

    logger.info("invocation.start", {
      providerId: provider.id,
      invocationId,
      triggerSource: options.triggerSource,
      dryRun: options.dryRun,
      timeoutMs: options.timeoutMs,
      maxAttempts: options.retryPolicy.maxAttempts,
    });

    if (options.dryRun) {
      logger.info("invocation.skipped", { reason: "dry_run" });
      return this.#finish(request, startedAt, 0, {
        status: InvocationStatus.SKIPPED,
        diagnostic: {
          code: "dry_run",
          summary:
            "Dry run: non-secret configuration and provider selection validated; CLI availability and credentials were not checked.",
        },
      });
    }

    let attempts = 0;
    let outcome: ProviderOutcome;

    for (;;) {
      attempts += 1;
      logger.debug("provider.attempt", { attempt: attempts, providerId: provider.id });
      outcome = await this.#attempt(request, options.timeoutMs);
      logger.info("provider.attempt.result", {
        attempt: attempts,
        status: outcome.status,
        code: outcome.diagnostic.code,
      });

      const decision = decideRetry(outcome.status, attempts, options.retryPolicy);
      if (!decision.retry) {
        logger.debug("retry.declined", { reason: decision.reason });
        break;
      }
      logger.warn("retry.scheduled", { reason: decision.reason, delayMs: decision.delayMs });
      await this.#deps.sleep(decision.delayMs);
    }

    const result = this.#finish(request, startedAt, attempts, outcome);

    logger.info("invocation.finish", {
      providerId: result.providerId,
      invocationId: result.invocationId,
      status: result.status,
      severity: result.severity,
      exitCode: result.exitCode,
      attempts: result.attempts,
      retried: result.retried,
      durationMs: result.durationMs,
      code: result.diagnostic.code,
    });

    return result;
  }

  /** One provider call, bounded by the configured deadline. Never throws. */
  async #attempt(request: InvocationRequest, timeoutMs: number): Promise<ProviderOutcome> {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const invocation = this.#deps.provider.invoke(request, controller.signal);
      // Backstop: an adapter that ignores the abort signal must not hang the run.
      const backstop = new Promise<ProviderOutcome>((resolve) => {
        backstopTimer = setTimeout(
          () =>
            resolve({
              status: InvocationStatus.TIMEOUT,
              diagnostic: {
                code: "adapter_unresponsive",
                summary: `Provider adapter did not return within ${timeoutMs + ABORT_GRACE_MS}ms of its deadline.`,
              },
            }),
          timeoutMs + ABORT_GRACE_MS,
        );
      });
      // Swallow a late rejection from the losing promise so it cannot surface
      // as an unhandled rejection after the backstop has already won.
      invocation.catch(() => {});
      return await Promise.race([invocation, backstop]);
    } catch (error) {
      // Contract violation: adapters are expected to resolve, not reject.
      this.#deps.logger.error("provider.threw", {
        providerId: this.#deps.provider.id,
        detail: safeSummary(error instanceof Error ? error.message : String(error)),
      });
      return {
        status: InvocationStatus.UNKNOWN_FAILURE,
        diagnostic: {
          code: "adapter_exception",
          summary: safeSummary(
            `Provider adapter threw instead of returning a normalized outcome: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        },
      };
    } finally {
      clearTimeout(abortTimer);
      if (backstopTimer) clearTimeout(backstopTimer);
    }
  }

  #finish(
    request: InvocationRequest,
    startedAt: Date,
    attempts: number,
    outcome: ProviderOutcome,
  ): InvocationResult {
    const finishedAt = this.#deps.now();
    const policy = policyFor(outcome.status);
    return Object.freeze({
      providerId: request.providerId,
      invocationId: request.invocationId,
      triggerSource: request.triggerSource,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      attempts,
      retried: attempts > 1,
      status: outcome.status,
      severity: policy.severity,
      exitCode: policy.exitCode,
      diagnostic: outcome.diagnostic,
      metadata: outcome.metadata,
    });
  }
}
