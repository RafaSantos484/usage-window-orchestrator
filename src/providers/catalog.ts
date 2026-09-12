/**
 * The set of providers this build supports, and how the composition root
 * constructs each one.
 *
 * This is a lookup table, not a framework: no registration at runtime, no
 * capability negotiation, no container. Two entries, each owning only the
 * facts the composition root genuinely needs - the provider-owned secret
 * inventory, the usage-billed credentials we refuse to forward, and a
 * constructor. Everything else about a provider stays inside its adapter.
 */
import type { AgentProvider } from "../core/provider.ts";
import {
  ANTHROPIC_API_KEY_ENV,
  CLAUDE_PROVIDER_ID,
  OAUTH_TOKEN_ENV,
  apiKeyPresentInEnvironment,
  createClaudeProvider,
} from "./claude/claude-code-provider.ts";
import {
  ACCESS_TOKEN_ENV,
  BILLING_KEY_ENVS,
  CODEX_PROVIDER_ID,
  billingKeyPresentInEnvironment,
  createCodexProvider,
} from "./codex/codex-cli-provider.ts";

export type EnvReader = (name: string) => string | undefined;

export interface ProviderDescriptor {
  readonly id: string;
  /** Every credential variable owned by this provider, including rejected billing keys. */
  readonly secretEnvNames: readonly string[];
  /** True when a usage-billed credential is present that we deliberately never forward. */
  readonly billingCredentialPresent: (env: EnvReader) => boolean;
  /** Operator-facing explanation for the warning above. */
  readonly billingWarning: string;
  readonly create: (env: EnvReader) => AgentProvider;
}

const CLAUDE: ProviderDescriptor = Object.freeze({
  id: CLAUDE_PROVIDER_ID,
  secretEnvNames: Object.freeze([OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]),
  billingCredentialPresent: apiKeyPresentInEnvironment,
  billingWarning:
    `${ANTHROPIC_API_KEY_ENV} is present but is deliberately not forwarded to the provider. ` +
    "This project bills against the subscription only.",
  create: (env: EnvReader) => createClaudeProvider({ env }),
});

const CODEX: ProviderDescriptor = Object.freeze({
  id: CODEX_PROVIDER_ID,
  secretEnvNames: Object.freeze([ACCESS_TOKEN_ENV, ...BILLING_KEY_ENVS]),
  billingCredentialPresent: billingKeyPresentInEnvironment,
  billingWarning:
    `${BILLING_KEY_ENVS.join(" / ")} is present but is deliberately not forwarded to the provider. ` +
    "This project bills against the ChatGPT plan allowance only.",
  create: (env: EnvReader) => createCodexProvider({ env }),
});

const DESCRIPTORS: readonly ProviderDescriptor[] = Object.freeze([CLAUDE, CODEX]);

/** Provider ids accepted by `AGENT_PROVIDER` and `--provider`. */
export const PROVIDER_IDS: readonly string[] = Object.freeze(DESCRIPTORS.map((entry) => entry.id));

/**
 * Every variable whose value must be scrubbed from logs, results and
 * summaries, regardless of which provider was selected. Collected before
 * anything can log, so redaction is armed for the whole run.
 */
export const SECRET_ENV_NAMES: readonly string[] = Object.freeze(
  [...new Set(DESCRIPTORS.flatMap((entry) => entry.secretEnvNames))],
);

export function describeProvider(id: string): ProviderDescriptor | undefined {
  return DESCRIPTORS.find((entry) => entry.id === id);
}

/**
 * Stand-in used for a dry run.
 *
 * A dry run must validate configuration and provider selection without
 * validating or forwarding a credential, installing a CLI, or touching the
 * network, so no real adapter is constructed at all. Invoking this is a
 * defect, and the orchestrator's dry-run path never does.
 */
export function dryRunProvider(providerId: string): AgentProvider {
  return {
    id: providerId,
    invoke: async () => {
      throw new Error("dry-run provider must not be invoked");
    },
  };
}
