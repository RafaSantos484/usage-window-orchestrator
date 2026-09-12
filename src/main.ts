/**
 * Composition root.
 *
 * Everything platform-specific lives here: argv, process.env, stdout/stderr,
 * exit codes, GitHub Actions files. The orchestrator below it is pure
 * application logic and knows none of it.
 */
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

import { ExitCode, type InvocationResult } from "./core/invocation.ts";
import { UsageWindowOrchestrator } from "./core/orchestrator.ts";
import type { AgentProvider } from "./core/provider.ts";
import { redact, redactValue } from "./core/logging.ts";
import { ConfigError, applyCliOverrides, loadConfig, type Env } from "./config.ts";
import { ProviderConfigurationError } from "./providers/provider-configuration-error.ts";
import {
  PROVIDER_IDS,
  SECRET_ENV_NAMES,
  describeProvider,
  dryRunProvider,
} from "./providers/catalog.ts";
import { JsonLogger } from "./adapters/json-logger.ts";
import { publishToGitHub } from "./adapters/github-summary.ts";
import { logUnhandledError } from "./adapters/unhandled-error.ts";

const USAGE = `usage-window-orchestrator

Issues one minimal, authenticated invocation against a configured AI coding
agent subscription at a convenient time. It reports the invocation outcome,
not provider quota-window state. Configuration is read from the environment;
see README.md.

  --dry-run            Validate configuration and orchestration without calling
                       the provider (consumes no allowance).
  --provider <id>      Override AGENT_PROVIDER (claude | codex).
  --help               Show this message.
`;

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return ExitCode.SUCCESS;
  }

  // Secrets are collected before anything can log, so redaction is always armed.
  // Every provider's credentials are scrubbed, not just the selected one's.
  const secrets = SECRET_ENV_NAMES.map((name) => process.env[name]);
  let env: Env;

  let config;
  try {
    env = applyCliOverrides(argv, process.env);
    config = loadConfig(env, PROVIDER_IDS);
  } catch (error) {
    if (error instanceof ConfigError) {
      new JsonLogger({ level: "error", secrets }).error("config.invalid", { problems: error.problems });
      return ExitCode.CONFIG_ERROR;
    }
    throw error;
  }

  const logger = new JsonLogger({ level: config.logLevel, secrets });
  const readEnv = (name: string) => env[name];
  const descriptor = describeProvider(config.providerId);

  if (!config.dryRun && descriptor?.billingCredentialPresent(readEnv)) {
    // Not fatal - we simply never forward it - but the operator should know
    // that a usage-billed credential is sitting in this environment.
    logger.warn("config.api_key_ignored", { detail: descriptor.billingWarning });
  }

  let provider: AgentProvider;
  if (config.dryRun) {
    // No adapter is constructed: a dry run must not validate, forward, install
    // or contact a provider. Global secret collection above is only for output
    // redaction; no selected credential is inspected in this branch.
    provider = dryRunProvider(config.providerId);
    logger.info("dry_run.validation", {
      providerId: config.providerId,
    });
  } else {
    if (!descriptor) {
      logger.error("config.invalid", { detail: `Unsupported provider: ${config.providerId}.` });
      return ExitCode.CONFIG_ERROR;
    }
    try {
      provider = descriptor.create(readEnv);
    } catch (error) {
      if (error instanceof ProviderConfigurationError) {
        logger.error("provider.misconfigured", { providerId: config.providerId, detail: error.message });
        return ExitCode.CONFIG_ERROR;
      }
      throw error;
    }
  }

  const orchestrator = new UsageWindowOrchestrator({
    provider,
    logger,
    now: () => new Date(),
    sleep: (ms) => delay(ms),
    newInvocationId: () => randomUUID(),
  });

  const result = await orchestrator.trigger({
    triggerSource: config.triggerSource,
    prompt: config.prompt,
    model: config.model,
    timeoutMs: config.timeoutMs,
    retryPolicy: config.retry,
    dryRun: config.dryRun,
  });

  emitResult(result, secrets);

  try {
    await publishToGitHub(result, process.env, secrets);
  } catch (error) {
    logger.warn("summary.publish_failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  return result.exitCode;
}

/** The machine-readable result goes to stdout; logs went to stderr. */
function emitResult(result: InvocationResult, secrets: readonly (string | undefined)[]): void {
  const safeResult = redactValue(result, secrets);
  process.stdout.write(`${redact(JSON.stringify(safeResult, null, 2), secrets)}\n`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Last-resort handler: an unexpected defect, not a classified outcome.
    logUnhandledError(error, SECRET_ENV_NAMES.map((name) => process.env[name]));
    process.exitCode = ExitCode.UNKNOWN_FAILURE;
  });
