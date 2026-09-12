import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvocationStatus, type InvocationRequest, type ProviderOutcome } from "../../core/invocation.ts";
import { safeSummary } from "../../core/logging.ts";
import type { AgentProvider } from "../../core/provider.ts";
import { spawnProcessRunner, type ProcessRunner } from "../../adapters/process-runner.ts";
import { ProviderConfigurationError } from "../provider-configuration-error.ts";
import { classifyCodexRun } from "./classify.ts";

export const CODEX_PROVIDER_ID = "codex";

/**
 * The subscription credential: a Codex access token minted in the ChatGPT
 * admin console. It is a ChatGPT *workspace* credential, so usage counts
 * against the workspace's ChatGPT plan allowance rather than OpenAI Platform
 * API billing. This is the only supported credential path - see the class
 * comment and README.md ("Authentication and billing").
 */
export const ACCESS_TOKEN_ENV = "CODEX_ACCESS_TOKEN";

/**
 * Usage-billed credentials. They are never used for authentication or forwarded
 * to the child process. The composition root may read their values only for
 * redaction and inspect presence for an operator warning; they are never a
 * fallback, because using them would silently move execution from the ChatGPT
 * plan allowance onto per-token OpenAI Platform billing.
 */
export const BILLING_KEY_ENVS: readonly string[] = Object.freeze(["CODEX_API_KEY", "OPENAI_API_KEY"]);

/** Prefix shared by OpenAI Platform API keys (`sk-…`, `sk-proj-…`). */
const API_KEY_PREFIX = "sk-";

/** Shortest credential we will accept, so an obvious placeholder fails fast. */
const MIN_TOKEN_LENGTH = 16;

/**
 * Environment variables forwarded to the CLI. Everything else in the parent
 * environment - including every other secret in the CI job, and every other
 * provider's credential - is withheld.
 */
const ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
]);

/**
 * `--config` overrides applied to every invocation.
 *
 * Values are TOML, which is why the strings are quoted. For the pinned CLI,
 * these overrides reduce unnecessary shell, image-viewer and web-search
 * activity. They are defense in depth rather than an absolute capability
 * guarantee; `--sandbox read-only`, the neutral cwd and the closed environment
 * are the primary safety controls (`codex exec` has no documented turn cap).
 *
 * `forced_login_method` is defence in depth for the billing boundary; the
 * primary control is that no API-key variable is in the child's environment
 * at all. For the pinned CLI, `cli_auth_credentials_store="ephemeral"` is
 * expected to avoid persistent credential storage and `history.persistence`
 * reduces retained session/history state in the isolated runtime. These are
 * version-sensitive CLI behaviours, not independently enforced by this
 * adapter. Temporary runtime files may still be written and are removed during
 * cleanup.
 *
 * `--strict-config` is passed so the pinned CLI is expected to reject a
 * renamed, removed or misspelled configuration key before proceeding to a
 * remote invocation. The local CLI process already has the token in its
 * environment, and this adapter cannot independently prove the ordering;
 * revalidate the flag together with these keys on upgrades.
 */
const CONFIG_OVERRIDES: readonly string[] = Object.freeze([
  'forced_login_method="chatgpt"',
  'cli_auth_credentials_store="ephemeral"',
  'web_search="disabled"',
  "features.shell_tool=false",
  "tools.view_image=false",
  'history.persistence="none"',
]);

export interface CodexProviderOptions {
  /** Reads configuration and secrets without consulting global process state. */
  readonly env: (name: string) => string | undefined;
  /** Injected for tests; defaults to a real child process. */
  readonly runner?: ProcessRunner;
  /** Infrastructure seam for deterministic setup/cleanup tests. */
  readonly isolationFactory?: () => Promise<CodexIsolationDirectories>;
  readonly cleanupIsolation?: (root: string) => Promise<void>;
}

/**
 * Codex adapter, built on the officially supported non-interactive mode
 * (`codex exec --json`).
 *
 * Design notes:
 *
 *  - **ChatGPT plan allowance only.** Authentication uses a Codex access token
 *    in `CODEX_ACCESS_TOKEN`, the documented credential for unattended
 *    automation. The adapter never uses `CODEX_API_KEY` or `OPENAI_API_KEY` for
 *    authentication and never forwards them to the child process. The
 *    composition root may read their values only to arm redaction and inspect
 *    presence for a warning; they are never a fallback, because using them
 *    would bill through the OpenAI Platform account instead of the ChatGPT
 *    plan. A token that looks like a Platform API key is refused at
 *    construction.
 *  - **Structured output.** We ask for JSON Lines and require exactly one clean
 *    terminal turn; unknown events and multiple turns fail closed. Free-text
 *    matching is a conservative fallback in `classify.ts` and can never create
 *    a passing or retryable outcome.
 *  - **Closed environment.** The child receives an allowlisted environment
 *    plus the access token, so no unrelated CI secret - and no Claude
 *    credential - is reachable from it.
 *  - **Isolated runtime directories.** Each invocation gets a temporary home,
 *    `CODEX_HOME`, temp directory and working directory from its isolation
 *    factory. Production uses the default temporary-runtime factory; tests may
 *    inject a deterministic factory. Combined with `--ignore-user-config` and
 *    `--ignore-rules` this prevents user-, project- or repository-level Codex
 *    configuration from changing a minimal invocation, and keeps the run away
 *    from the checked-out repository entirely.
 *  - **Cannot modify the checkout or persistent project state.**
 *    `--sandbox read-only` plus a neutral working directory are two independent
 *    reasons the checked-out repository cannot be modified, and the
 *    tool-disabling overrides above are a third. The isolated runtime may
 *    receive temporary writes and is removed during cleanup.
 */
export class CodexCliProvider implements AgentProvider {
  readonly id = CODEX_PROVIDER_ID;

  readonly #binary: string;
  readonly #token: string;
  readonly #runner: ProcessRunner;
  readonly #env: (name: string) => string | undefined;
  readonly #isolationFactory: () => Promise<CodexIsolationDirectories>;
  readonly #cleanupIsolation: (root: string) => Promise<void>;

  constructor(options: CodexProviderOptions) {
    const { env } = options;
    this.#env = env;
    const token = env(ACCESS_TOKEN_ENV)?.trim();

    if (!token) {
      throw new ProviderConfigurationError(
        `${ACCESS_TOKEN_ENV} is not set. Create a Codex access token at https://chatgpt.com/admin/access-tokens ` +
          `(ChatGPT Business or Enterprise workspaces only) and store it as a repository secret named ` +
        `${ACCESS_TOKEN_ENV}. See README.md ("Authentication and billing").`,
      );
    }

    if (token.startsWith(API_KEY_PREFIX)) {
      throw new ProviderConfigurationError(
        `${ACCESS_TOKEN_ENV} holds what appears to be an OpenAI Platform API key ("${API_KEY_PREFIX}…"), not a ` +
          `Codex access token. Refusing to run: an API key bills per token through the OpenAI Platform account ` +
          `instead of the ChatGPT plan allowance this project is built around. Create a Codex access token at ` +
          `https://chatgpt.com/admin/access-tokens.`,
      );
    }

    if (token.length < MIN_TOKEN_LENGTH) {
      throw new ProviderConfigurationError(
        `${ACCESS_TOKEN_ENV} is too short to be a Codex access token (${token.length} characters). ` +
          `Re-copy the token from https://chatgpt.com/admin/access-tokens; it can only be read at creation time.`,
      );
    }

    this.#token = token;
    this.#binary = env("AGENT_CODEX_BIN")?.trim() || "codex";
    this.#runner = options.runner ?? spawnProcessRunner;
    this.#isolationFactory = options.isolationFactory ?? createCodexIsolationDirectory;
    this.#cleanupIsolation = options.cleanupIsolation ?? ((root) => rm(root, { recursive: true, force: true }));
  }

  /** Values that must never reach a log line or a diagnostic summary. */
  get #secrets(): readonly string[] {
    return [this.#token];
  }

  async invoke(request: InvocationRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    let isolation: CodexIsolationDirectories;
    try {
      isolation = await this.#isolationFactory();
    } catch (error) {
      return {
        status: InvocationStatus.PROVIDER_UNAVAILABLE,
        diagnostic: {
          code: "isolation_setup_failed",
          summary: safeSummary(
            `Could not create the isolated Codex runtime: ${error instanceof Error ? error.message : String(error)}`,
            this.#secrets,
          ),
        },
      };
    }

    try {
      const run = await this.#runner({
        command: this.#binary,
        args: buildArgs(request),
        env: { ...this.#childEnv(isolation), [ACCESS_TOKEN_ENV]: this.#token },
        signal,
        cwd: isolation.cwd,
      });

      return classifyCodexRun(run);
    } finally {
      // Cleanup is best effort. It must never replace Codex's normalized
      // outcome with an infrastructure error; persistent runners should
      // monitor temporary-directory cleanup separately.
      await this.#cleanupIsolation(isolation.root).catch(() => {});
    }
  }

  #childEnv(isolation: CodexIsolationDirectories): Record<string, string> {
    const child: Record<string, string> = {};
    for (const name of ENV_ALLOWLIST) {
      const value = this.#env(name);
      if (value !== undefined) child[name] = value;
    }
    child.HOME = isolation.home;
    child.TMPDIR = isolation.tmp;
    child.TEMP = isolation.tmp;
    child.TMP = isolation.tmp;
    // Codex requires CODEX_HOME to exist; the isolation factory created it.
    child.CODEX_HOME = isolation.codexHome;
    // Explicitly cleared, not merely omitted, to document the intent.
    for (const name of BILLING_KEY_ENVS) delete child[name];
    return child;
  }
}

export interface CodexIsolationDirectories {
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  readonly tmp: string;
  readonly cwd: string;
}

async function createCodexIsolationDirectory(): Promise<CodexIsolationDirectories> {
  const root = await mkdtemp(join(tmpdir(), "usage-window-codex-"));
  try {
    const home = join(root, "home");
    const codexHome = join(root, "codex-home");
    const temporary = join(root, "tmp");
    const cwd = join(root, "cwd");
    await Promise.all([mkdir(home), mkdir(codexHome), mkdir(temporary), mkdir(cwd)]);
    return { root, home, codexHome, tmp: temporary, cwd };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Builds the non-interactive invocation.
 *
 * The flags are fixed rather than configurable, because each one is part of
 * the product boundary rather than a preference:
 *
 *  - `--json` gives the structured stream the classifier needs; a zero exit
 *    code alone is not accepted as evidence of success, and the classifier
 *    requires exactly one clean terminal turn and one non-empty agent response.
 *  - `--ephemeral` limits retained session rollout files; temporary runtime
 *    files may still be written and are removed during cleanup.
 *  - `--skip-git-repo-check` is required because we deliberately run in a
 *    neutral temporary directory, not in the checked-out repository.
 *  - `--sandbox read-only` and `--ask-for-approval never` make the run
 *    incapable of mutation and incapable of blocking on a prompt.
 *  - `--ignore-user-config` / `--ignore-rules` keep user, project and
 *    repository configuration out of a minimal invocation.
 *  - `--color never` keeps ANSI escapes out of captured output.
 *
 * The prompt is passed last, after `--`, so a prompt beginning with `-` is
 * never parsed as a flag. Nothing goes through a shell.
 */
export function buildArgs(request: InvocationRequest): string[] {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--strict-config",
  ];
  for (const override of CONFIG_OVERRIDES) args.push("--config", override);
  if (request.model) args.push("--model", request.model);
  args.push("--", request.prompt);
  return args;
}

/** Warns if a usage-billed key is present in the environment. Returns true when one is. */
export function billingKeyPresentInEnvironment(env: (name: string) => string | undefined): boolean {
  return BILLING_KEY_ENVS.some((name) => Boolean(env(name)?.trim()));
}

export const createCodexProvider = (options: CodexProviderOptions): AgentProvider =>
  new CodexCliProvider(options);
