import { LOG_LEVELS, type LogLevel } from "./core/logging.ts";
import type { TriggerSource } from "./core/invocation.ts";
import type { RetryPolicy } from "./core/retry.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
        `See README.md ("Configuration") for the full list of settings.`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Maps the supported command-line flags onto the environment the loader reads.
 * The surface is intentionally strict: a typo must not silently launch a real
 * provider invocation with the defaults.
 */
export function applyCliOverrides(argv: readonly string[], env: Env): Env {
  const overrides: Record<string, string | undefined> = { ...env };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") overrides.AGENT_DRY_RUN = "true";
    else if (arg === "--provider") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new ConfigError(["--provider requires a provider id."]);
      overrides.AGENT_PROVIDER = value;
      i += 1;
    } else if (arg?.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length);
      if (!value) throw new ConfigError(["--provider requires a provider id."]);
      overrides.AGENT_PROVIDER = value;
    } else {
      throw new ConfigError([`Unknown command-line option: ${arg}`]);
    }
  }
  return overrides;
}

export interface AppConfig {
  readonly providerId: string;
  readonly prompt: string;
  readonly model?: string;
  readonly timeoutMs: number;
  readonly retry: RetryPolicy;
  readonly dryRun: boolean;
  readonly logLevel: LogLevel;
  readonly triggerSource: TriggerSource;
}

/**
 * Defaults are chosen so the zero-configuration case is safe and cheap:
 * one attempt plus one retry, a two-minute ceiling, and a prompt that asks for
 * a single word.
 */
export const DEFAULTS = Object.freeze({
  providerId: "claude",
  prompt: "Reply with the single word: ok",
  timeoutSeconds: 120,
  maxAttempts: 2,
  backoffSeconds: 5,
  maxBackoffSeconds: 30,
  logLevel: "info" as LogLevel,
});

const BOUNDS = Object.freeze({
  timeoutSeconds: { min: 5, max: 600 },
  maxAttempts: { min: 1, max: 3 },
  promptLength: { min: 1, max: 500 },
});

/** Maximum logical-run budget, leaving the 10-minute Actions job time for setup and reporting. */
export const MAX_EXECUTION_BUDGET_SECONDS = 8 * 60;
const ADAPTER_GRACE_SECONDS = 5;

/**
 * Parses and validates the whole configuration surface up front, collecting
 * every problem so a misconfigured run reports all of them at once instead of
 * failing one variable at a time.
 */
export function loadConfig(env: Env, knownProviderIds: readonly string[]): AppConfig {
  const problems: string[] = [];

  const providerId = (env.AGENT_PROVIDER ?? DEFAULTS.providerId).trim().toLowerCase();
  if (!knownProviderIds.includes(providerId)) {
    problems.push(
      `AGENT_PROVIDER="${providerId}" is not a registered provider. Available: ${knownProviderIds.join(", ")}.`,
    );
  }

  const prompt = env.AGENT_PROMPT?.trim() || DEFAULTS.prompt;
  if (prompt.length < BOUNDS.promptLength.min || prompt.length > BOUNDS.promptLength.max) {
    problems.push(
      `AGENT_PROMPT must be between ${BOUNDS.promptLength.min} and ${BOUNDS.promptLength.max} characters (got ${prompt.length}). ` +
        `This trigger is meant to be minimal.`,
    );
  }

  const model = env.AGENT_MODEL?.trim() || undefined;

  const timeoutSeconds = readInt(env.AGENT_TIMEOUT_SECONDS, DEFAULTS.timeoutSeconds, "AGENT_TIMEOUT_SECONDS", BOUNDS.timeoutSeconds, problems);
  const maxAttempts = readInt(env.AGENT_MAX_ATTEMPTS, DEFAULTS.maxAttempts, "AGENT_MAX_ATTEMPTS", BOUNDS.maxAttempts, problems);
  const dryRun = readBool(env.AGENT_DRY_RUN, false, "AGENT_DRY_RUN", problems);

  const logLevel = (env.AGENT_LOG_LEVEL?.trim().toLowerCase() ?? DEFAULTS.logLevel) as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`AGENT_LOG_LEVEL="${logLevel}" is not one of: ${LOG_LEVELS.join(", ")}.`);
  }

  const triggerSourceRaw = env.AGENT_TRIGGER_SOURCE?.trim().toLowerCase() ?? "manual";
  if (triggerSourceRaw !== "manual" && triggerSourceRaw !== "scheduled") {
    problems.push(`AGENT_TRIGGER_SOURCE="${triggerSourceRaw}" must be "scheduled" or "manual".`);
  }

  const executionBudgetSeconds = worstCaseExecutionSeconds(timeoutSeconds, maxAttempts);
  if (executionBudgetSeconds > MAX_EXECUTION_BUDGET_SECONDS) {
    problems.push(
      `AGENT_TIMEOUT_SECONDS=${timeoutSeconds} with AGENT_MAX_ATTEMPTS=${maxAttempts} ` +
        `requires up to ${executionBudgetSeconds}s, exceeding the ${MAX_EXECUTION_BUDGET_SECONDS}s application budget ` +
        `for the 10-minute GitHub Actions job. Reduce the timeout or attempt count.`,
    );
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    providerId,
    prompt,
    model,
    timeoutMs: timeoutSeconds * 1_000,
    retry: Object.freeze({
      maxAttempts,
      backoffMs: DEFAULTS.backoffSeconds * 1_000,
      maxBackoffMs: DEFAULTS.maxBackoffSeconds * 1_000,
    }),
    dryRun,
    logLevel,
    triggerSource: triggerSourceRaw as TriggerSource,
  });
}

/** Worst-case provider time plus adapter grace and retry backoff. */
export function worstCaseExecutionSeconds(timeoutSeconds: number, maxAttempts: number): number {
  const attempts = maxAttempts * (timeoutSeconds + ADAPTER_GRACE_SECONDS);
  let backoff = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) {
    backoff += Math.min(DEFAULTS.backoffSeconds * 2 ** (attempt - 1), DEFAULTS.maxBackoffSeconds);
  }
  return attempts + backoff;
}

function readInt(
  raw: string | undefined,
  fallback: number,
  name: string,
  bounds: { min: number; max: number },
  problems: string[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) {
    problems.push(`${name}="${raw}" must be an integer.`);
    return fallback;
  }
  if (value < bounds.min || value > bounds.max) {
    problems.push(`${name}=${value} is outside the allowed range ${bounds.min}..${bounds.max}.`);
    return fallback;
  }
  return value;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off", ""]);

function readBool(raw: string | undefined, fallback: boolean, name: string, problems: string[]): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  problems.push(`${name}="${raw}" must be a boolean (true/false).`);
  return fallback;
}
