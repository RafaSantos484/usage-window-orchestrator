import type { InvocationRequest, ProviderOutcome } from "./invocation.ts";

/**
 * The port the orchestrator depends on. Everything Claude-specific - command
 * construction, output parsing, error strings - lives behind this boundary.
 *
 * Behavioural contract every adapter must honour (Liskov):
 *
 *  1. `invoke` RESOLVES with a normalized {@link ProviderOutcome} for every
 *     expected failure mode. Rejecting is reserved for genuine bugs; the
 *     orchestrator maps a rejection to UNKNOWN_FAILURE and does not retry it.
 *  2. `invoke` must observe `signal` and stop its work promptly when aborted,
 *     returning a TIMEOUT outcome. It must not leave child processes running.
 *  3. Outcomes must never carry credentials, prompts, or full response bodies -
 *     `diagnostic.summary` is redacted and truncated by the adapter.
 *  4. `invoke` must be free of side effects beyond the provider call itself.
 */
export interface AgentProvider {
  readonly id: string;
  invoke(request: InvocationRequest, signal: AbortSignal): Promise<ProviderOutcome>;
}
