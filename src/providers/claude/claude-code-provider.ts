import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvocationStatus, type InvocationRequest, type ProviderOutcome } from "../../core/invocation.ts";
import { safeSummary } from "../../core/logging.ts";
import type { AgentProvider } from "../../core/provider.ts";
import { spawnProcessRunner, type ProcessRunner } from "../../adapters/process-runner.ts";
import { classifyClaudeRun } from "./classify.ts";

export const CLAUDE_PROVIDER_ID = "claude";

/** The subscription credential. This is the only supported credential path. */
export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
/** Present only so we can refuse to use it - see the class comment. */
const API_KEY_ENV = "ANTHROPIC_API_KEY";

/** Prefix of a usage-billed API key, as opposed to a subscription OAuth token. */
const API_KEY_PREFIX = "sk-ant-api";

/**
 * Environment variables forwarded to the CLI. Everything else in the parent
 * environment - including every other secret in the CI job - is withheld.
 */
const ENV_ALLOWLIST: readonly string[] = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
]);

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export interface ClaudeProviderOptions {
  /** Reads configuration and secrets without consulting global process state. */
  readonly env: (name: string) => string | undefined;
  /** Injected for tests; defaults to a real child process. */
  readonly runner?: ProcessRunner;
  /** Working directory for the CLI. Defaults to a temp dir (see below). */
  readonly cwd?: string;
  /** Infrastructure seam for deterministic setup/cleanup tests. */
  readonly isolationFactory?: () => Promise<IsolationDirectories>;
  readonly cleanupIsolation?: (root: string) => Promise<void>;
}

/**
 * Claude adapter, built on the officially supported Claude Code headless mode
 * (`claude -p ... --output-format json`).
 *
 * Design notes:
 *
 *  - **Subscription only.** Authentication uses `CLAUDE_CODE_OAUTH_TOKEN`. We
 *    never read, forward, or fall back to `ANTHROPIC_API_KEY`, because that
 *    would silently move execution from the user's subscription allowance onto
 *    usage-based billing. If the token looks like an API key we refuse to start.
 *  - **Structured output.** We ask for JSON and parse the envelope; free-text
 *    matching is a fallback confined to `classify.ts`.
 *  - **Closed environment.** The child receives an allowlisted environment plus
 *    the token, so no unrelated CI secret is exposed to it.
 *  - **Isolated runtime directories.** Each invocation gets a temporary home,
 *    temp directory and (unless overridden for tests/embedding) working
 *    directory. This prevents repository- and user-level Claude settings from
 *    changing a minimal invocation.
 */
export class ClaudeCodeProvider implements AgentProvider {
  readonly id = CLAUDE_PROVIDER_ID;

  readonly #binary: string;
  readonly #token: string;
  readonly #runner: ProcessRunner;
  readonly #cwd: string | undefined;
  readonly #env: (name: string) => string | undefined;
  readonly #isolationFactory: () => Promise<IsolationDirectories>;
  readonly #cleanupIsolation: (root: string) => Promise<void>;

  constructor(options: ClaudeProviderOptions) {
    const { env } = options;
    this.#env = env;
    const token = env(OAUTH_TOKEN_ENV)?.trim();

    if (!token) {
      throw new ProviderConfigurationError(
        `${OAUTH_TOKEN_ENV} is not set. Generate a subscription token with "claude setup-token" and store it ` +
          `as a repository secret named ${OAUTH_TOKEN_ENV}. See README.md ("Quick start").`,
      );
    }

    if (token.startsWith(API_KEY_PREFIX)) {
      throw new ProviderConfigurationError(
        `${OAUTH_TOKEN_ENV} holds what appears to be a usage-billed API key ("${API_KEY_PREFIX}…"), not a ` +
          `subscription OAuth token. Refusing to run: this project deliberately never bills per token. ` +
          `Generate a subscription token with "claude setup-token".`,
      );
    }

    this.#token = token;
    this.#binary = env("AGENT_CLAUDE_BIN")?.trim() || "claude";
    this.#runner = options.runner ?? spawnProcessRunner;
    this.#cwd = options.cwd;
    this.#isolationFactory = options.isolationFactory ?? createIsolationDirectory;
    this.#cleanupIsolation = options.cleanupIsolation ?? ((root) => rm(root, { recursive: true, force: true }));
  }

  /** Values that must never reach a log line or a diagnostic summary. */
  get #secrets(): readonly string[] {
    return [this.#token];
  }

  async invoke(request: InvocationRequest, signal: AbortSignal): Promise<ProviderOutcome> {
    let isolation: IsolationDirectories;
    try {
      isolation = await this.#isolationFactory();
    } catch (error) {
      return {
        status: InvocationStatus.PROVIDER_UNAVAILABLE,
        diagnostic: {
          code: "isolation_setup_failed",
          summary: safeSummary(
            `Could not create the isolated Claude runtime: ${error instanceof Error ? error.message : String(error)}`,
            this.#secrets,
          ),
        },
      };
    }

    try {
      const run = await this.#runner({
        command: this.#binary,
        args: buildArgs(request),
        env: { ...this.#childEnv(isolation), [OAUTH_TOKEN_ENV]: this.#token },
        signal,
        cwd: this.#cwd ?? isolation.cwd,
      });

      return classifyClaudeRun({ run, secrets: this.#secrets });
    } finally {
      // Cleanup is hygiene only. It must never replace Claude's normalized
      // outcome with an infrastructure error.
      await this.#cleanupIsolation(isolation.root).catch(() => {});
    }
  }

  #childEnv(isolation: IsolationDirectories): Record<string, string> {
    const child: Record<string, string> = {};
    for (const name of ENV_ALLOWLIST) {
      const value = this.#env(name);
      if (value !== undefined) child[name] = value;
    }
    child.HOME = isolation.home;
    child.TMPDIR = isolation.tmp;
    child.TEMP = isolation.tmp;
    child.TMP = isolation.tmp;
    // Explicitly cleared, not merely omitted, to document the intent.
    delete child[API_KEY_ENV];
    return child;
  }
}

export interface IsolationDirectories {
  readonly root: string;
  readonly home: string;
  readonly tmp: string;
  readonly cwd: string;
}

async function createIsolationDirectory(): Promise<IsolationDirectories> {
  const root = await mkdtemp(join(tmpdir(), "usage-window-claude-"));
  try {
    const home = join(root, "home");
    const temporary = join(root, "tmp");
    const cwd = join(root, "cwd");
    await Promise.all([mkdir(home), mkdir(temporary), mkdir(cwd)]);
    return { root, home, tmp: temporary, cwd };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Builds the headless invocation.
 *
 * `--max-turns 1` is fixed rather than configurable: the entire point is a
 * single minimal exchange, and exposing it as a setting would invite growth.
 */
export function buildArgs(request: InvocationRequest): string[] {
  const args = ["-p", request.prompt, "--output-format", "json", "--max-turns", "1"];
  if (request.model) args.push("--model", request.model);
  return args;
}

/** Warns if a usage-billed key is present in the environment. Returns true when it is. */
export function apiKeyPresentInEnvironment(env: (name: string) => string | undefined): boolean {
  return Boolean(env(API_KEY_ENV)?.trim());
}

export const createClaudeProvider = (options: ClaudeProviderOptions): AgentProvider =>
  new ClaudeCodeProvider(options);
