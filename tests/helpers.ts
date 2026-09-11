import type { InvocationRequest, ProviderOutcome } from "../src/core/invocation.ts";
import { InvocationStatus } from "../src/core/invocation.ts";
import type { AgentProvider } from "../src/core/provider.ts";
import type { LogFields, Logger } from "../src/core/logging.ts";

/**
 * Stub provider. Returns a scripted outcome per attempt, so orchestration can
 * be exercised for every normalized status without any real provider, network,
 * or credential.
 */
export class FakeProvider implements AgentProvider {
  readonly id: string;
  readonly requests: InvocationRequest[] = [];
  #script: ProviderOutcome[];
  /** When set, invoke never settles - used to exercise the abort backstop. */
  readonly #hang: boolean;

  constructor(script: ProviderOutcome[], options: { id?: string; hang?: boolean } = {}) {
    this.#script = [...script];
    this.id = options.id ?? "fake";
    this.#hang = options.hang ?? false;
  }

  get attemptCount(): number {
    return this.requests.length;
  }

  async invoke(request: InvocationRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    this.requests.push(request);
    if (this.#hang) return new Promise<ProviderOutcome>(() => {});
    if (signal.aborted) {
      return { status: InvocationStatus.TIMEOUT, diagnostic: { code: "aborted", summary: "aborted" } };
    }
    const next = this.#script.shift();
    if (!next) throw new Error("FakeProvider ran out of scripted outcomes");
    return next;
  }
}

/** Provider that violates the contract by throwing instead of returning. */
export class ThrowingProvider implements AgentProvider {
  readonly id = "throwing";
  async invoke(): Promise<ProviderOutcome> {
    throw new Error("boom sk-ant-oat01-verysecrettokenvalue");
  }
}

export interface RecordedLog {
  readonly level: string;
  readonly event: string;
  readonly fields: LogFields | undefined;
}

export class RecordingLogger implements Logger {
  readonly records: RecordedLog[] = [];
  debug(event: string, fields?: LogFields) {
    this.records.push({ level: "debug", event, fields });
  }
  info(event: string, fields?: LogFields) {
    this.records.push({ level: "info", event, fields });
  }
  warn(event: string, fields?: LogFields) {
    this.records.push({ level: "warn", event, fields });
  }
  error(event: string, fields?: LogFields) {
    this.records.push({ level: "error", event, fields });
  }
  events(): string[] {
    return this.records.map((record) => record.event);
  }
}

export function ok(code = "ok"): ProviderOutcome {
  return { status: InvocationStatus.SUCCESS, diagnostic: { code, summary: "fine" } };
}

export function failure(status: InvocationStatus, code = "x"): ProviderOutcome {
  return { status, diagnostic: { code, summary: "failed" } };
}

/** Advances a fixed amount per call so durations are deterministic. */
export function steppingClock(startIso: string, stepMs = 1_000): () => Date {
  let current = Date.parse(startIso);
  return () => {
    const value = new Date(current);
    current += stepMs;
    return value;
  };
}
