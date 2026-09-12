import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  ACCESS_TOKEN_ENV,
  BILLING_KEY_ENVS,
  CodexCliProvider,
  type CodexIsolationDirectories,
  billingKeyPresentInEnvironment,
  buildArgs,
} from "../src/providers/codex/codex-cli-provider.ts";
import { ProviderConfigurationError } from "../src/providers/provider-configuration-error.ts";
import type { ProcessRunResult, ProcessSpec } from "../src/adapters/process-runner.ts";
import { InvocationStatus, type InvocationRequest } from "../src/core/invocation.ts";

/** Opaque bearer string; the real format is not asserted anywhere in the adapter. */
const TOKEN = "at-testaccesstokenvaluethatislongenough";

const REQUEST: InvocationRequest = {
  invocationId: "inv-1",
  providerId: "codex",
  triggerSource: "scheduled",
  prompt: "Reply with the single word: ok",
  timeoutMs: 30_000,
};

const SUCCESS_STREAM = [
  '{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}',
  '{"type":"turn.started"}',
  '{"type":"item.started","item":{"id":"item_1","type":"agent_message"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":18,"cached_input_tokens":0,"output_tokens":2}}',
].join("\n");

function fakeRunner(result: Partial<ProcessRunResult> = {}) {
  const calls: ProcessSpec[] = [];
  const runner = vi.fn(async (spec: ProcessSpec): Promise<ProcessRunResult> => {
    calls.push(spec);
    return {
      stdout: SUCCESS_STREAM,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      termSignal: null,
      timedOut: false,
      ...result,
    };
  });
  return { runner, calls };
}

const env = (name: string) =>
  name === ACCESS_TOKEN_ENV ? TOKEN : name === "PATH" ? "/usr/bin" : undefined;

describe("buildArgs", () => {
  const args = buildArgs(REQUEST);

  it("builds one non-interactive, structured-output invocation", () => {
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--ephemeral");
  });

  it("runs read-only and never waits for an approval prompt", () => {
    expect(args.join(" ")).toContain("--sandbox read-only");
    expect(args.join(" ")).toContain("--ask-for-approval never");
    expect(args).not.toContain("--full-auto");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args.join(" ")).not.toContain("workspace-write");
    expect(args.join(" ")).not.toContain("danger-full-access");
  });

  it("runs outside a repository and ignores user, project and rule configuration", () => {
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
  });

  it("disables the identified shell, image-viewer and web-search capabilities", () => {
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("tools.view_image=false");
    expect(args).toContain('web_search="disabled"');
  });

  it("pins the credential path and keeps the exchange off disk", () => {
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain('cli_auth_credentials_store="ephemeral"');
    expect(args).toContain('history.persistence="none"');
  });

  it("strictly validates the security configuration keys", () => {
    expect(args).toContain("--strict-config");
  });

  it("passes the prompt last, after a -- terminator", () => {
    expect(args.at(-1)).toBe(REQUEST.prompt);
    expect(args.at(-2)).toBe("--");
  });

  it("cannot let a prompt beginning with a hyphen be read as a flag", () => {
    const hostile = buildArgs({ ...REQUEST, prompt: "--sandbox danger-full-access" });
    expect(hostile.at(-2)).toBe("--");
    expect(hostile.at(-1)).toBe("--sandbox danger-full-access");
  });

  it("adds the model only when one is configured", () => {
    expect(args).not.toContain("--model");
    const withModel = buildArgs({ ...REQUEST, model: "gpt-5.6-terra" });
    expect(withModel).toContain("--model");
    expect(withModel[withModel.indexOf("--model") + 1]).toBe("gpt-5.6-terra");
  });
});

describe("CodexCliProvider construction", () => {
  it("fails fast with an actionable message when the access token is missing", () => {
    expect(() => new CodexCliProvider({ env: () => undefined })).toThrow(ProviderConfigurationError);
    expect(() => new CodexCliProvider({ env: () => undefined })).toThrow(/admin\/access-tokens/);
  });

  it("treats a blank access token as missing", () => {
    const blank = (name: string) => (name === ACCESS_TOKEN_ENV ? "   " : undefined);
    expect(() => new CodexCliProvider({ env: blank })).toThrow(/is not set/);
  });

  it.each(["sk-proj-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"])(
    "refuses the usage-billed API key %s supplied in the token variable",
    (key) => {
      const withKey = (name: string) => (name === ACCESS_TOKEN_ENV ? key : undefined);
      expect(() => new CodexCliProvider({ env: withKey })).toThrow(/bills per token/);
    },
  );

  it("refuses a token too short to be real rather than failing mid-invocation", () => {
    const short = (name: string) => (name === ACCESS_TOKEN_ENV ? "at-short" : undefined);
    expect(() => new CodexCliProvider({ env: short })).toThrow(/too short/);
  });

  it("never puts the credential value into its own error messages", () => {
    const key = "sk-proj-supersecretkeymaterial";
    const withKey = (name: string) => (name === ACCESS_TOKEN_ENV ? key : undefined);
    try {
      new CodexCliProvider({ env: withKey });
      throw new Error("expected a ProviderConfigurationError");
    } catch (error) {
      expect((error as Error).message).not.toContain("supersecretkeymaterial");
    }
  });
});

describe("CodexCliProvider.invoke", () => {
  it("returns a normalized success outcome", async () => {
    const { runner } = fakeRunner();
    const provider = new CodexCliProvider({ env, runner });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("normalizes isolation setup failures without invoking the provider", async () => {
    const runner = vi.fn();
    const provider = new CodexCliProvider({
      env,
      runner,
      isolationFactory: async (): Promise<CodexIsolationDirectories> => {
        throw new Error("temporary directory unavailable");
      },
    });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    expect(outcome.status).toBe(InvocationStatus.PROVIDER_UNAVAILABLE);
    expect(outcome.diagnostic.code).toBe("isolation_setup_failed");
    expect(runner).not.toHaveBeenCalled();
  });

  it("preserves the provider outcome when isolation cleanup fails", async () => {
    const { runner } = fakeRunner();
    const isolation: CodexIsolationDirectories = {
      root: "/tmp/test-isolation",
      home: "/tmp/test-isolation/home",
      codexHome: "/tmp/test-isolation/codex-home",
      tmp: "/tmp/test-isolation/tmp",
      cwd: "/tmp/test-isolation/cwd",
    };
    const provider = new CodexCliProvider({
      env,
      runner,
      isolationFactory: async () => isolation,
      cleanupIsolation: async () => {
        throw new Error("cleanup failed");
      },
    });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
  });

  it("cleans up the isolated runtime after a successful invocation", async () => {
    const { runner } = fakeRunner();
    // Observes the real root the adapter created, then removes it itself, so
    // the test neither trusts nor leaks the temporary directory.
    const roots: string[] = [];
    const cleanupIsolation = vi.fn(async (root: string) => {
      roots.push(root);
      await rm(root, { recursive: true, force: true });
    });
    const provider = new CodexCliProvider({ env, runner, cleanupIsolation });

    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    expect(cleanupIsolation).toHaveBeenCalledOnce();
    expect(roots[0]).toMatch(/usage-window-codex-/);
    expect(existsSync(roots[0]!)).toBe(false);
  });

  it("passes the access token and withholds every unrelated variable", async () => {
    const noisyEnv = (name: string) =>
      ({
        [ACCESS_TOKEN_ENV]: TOKEN,
        PATH: "/usr/bin",
        TZ: "UTC",
        CODEX_API_KEY: "sk-proj-should-never-be-forwarded",
        OPENAI_API_KEY: "sk-should-never-be-forwarded",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-other-provider-secret",
        ANTHROPIC_API_KEY: "sk-ant-api03-other-provider-secret",
        UNRELATED_CI_SECRET: "deploy-key",
        GITHUB_TOKEN: "ghs-token",
      })[name];

    const { runner, calls } = fakeRunner();
    const provider = new CodexCliProvider({ env: noisyEnv, runner });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    const childEnv = calls[0]!.env;
    expect(childEnv[ACCESS_TOKEN_ENV]).toBe(TOKEN);
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.TZ).toBe("UTC");

    for (const name of BILLING_KEY_ENVS) expect(childEnv).not.toHaveProperty(name);
    // Another provider's credentials must be unreachable from this child.
    expect(childEnv).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(childEnv).not.toHaveProperty("UNRELATED_CI_SECRET");
    expect(childEnv).not.toHaveProperty("GITHUB_TOKEN");
    expect(JSON.stringify(childEnv)).not.toContain("other-provider-secret");

    // The complete allowlist: nothing beyond these names reaches the child.
    expect(Object.keys(childEnv).sort()).toEqual(
      ["CODEX_ACCESS_TOKEN", "CODEX_HOME", "HOME", "PATH", "TEMP", "TMP", "TMPDIR", "TZ"].sort(),
    );
  });

  it("isolates HOME, CODEX_HOME, the temp directory and the working directory", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new CodexCliProvider({ env, runner });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    const childEnv = calls[0]!.env;
    expect(childEnv.HOME).toMatch(/usage-window-codex-/);
    expect(childEnv.CODEX_HOME).toMatch(/usage-window-codex-/);
    expect(childEnv.CODEX_HOME).not.toBe(childEnv.HOME);
    expect(childEnv.TMPDIR).toMatch(/usage-window-codex-/);
    expect(calls[0]!.cwd).toMatch(/usage-window-codex-/);
    // Never the checked-out repository.
    expect(calls[0]!.cwd).not.toBe(process.cwd());
  });

  it("never invokes a shell and uses the isolated working directory", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new CodexCliProvider({
      env,
      runner,
      isolationFactory: async () => ({
        root: "/tmp/test-isolation",
        home: "/tmp/test-isolation/home",
        codexHome: "/tmp/test-isolation/codex-home",
        tmp: "/tmp/test-isolation/tmp",
        cwd: "/tmp/neutral",
      }),
      cleanupIsolation: async () => {},
    });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    // The runner takes a command and an argv array; there is no shell string.
    expect(calls[0]!.command).toBe("codex");
    expect(Array.isArray(calls[0]!.args)).toBe(true);
    expect(calls[0]!.cwd).toBe("/tmp/neutral");
  });

  it("honours a custom binary path", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new CodexCliProvider({
      env: (name) =>
        name === ACCESS_TOKEN_ENV ? TOKEN : name === "AGENT_CODEX_BIN" ? "/opt/bin/codex" : undefined,
      runner,
    });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));
    expect(calls[0]!.command).toBe("/opt/bin/codex");
  });

  it("normalizes a killed run into a timeout outcome", async () => {
    const { runner } = fakeRunner({ stdout: "", timedOut: true, exitCode: null, termSignal: "SIGTERM" });
    const provider = new CodexCliProvider({ env, runner });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));
    expect(outcome.status).toBe(InvocationStatus.TIMEOUT);
  });

  it("redacts the token from an unclassified diagnostic", async () => {
    const { runner } = fakeRunner({ stdout: "", exitCode: 5, stderr: `weird failure using ${TOKEN}` });
    const provider = new CodexCliProvider({ env, runner });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));
    expect(outcome.diagnostic.summary).not.toContain(TOKEN);
  });
});

describe("billingKeyPresentInEnvironment", () => {
  it("detects a usage-billed key so the operator can be warned", () => {
    expect(billingKeyPresentInEnvironment((name) => (name === "CODEX_API_KEY" ? "sk-proj-x" : undefined))).toBe(true);
    expect(billingKeyPresentInEnvironment((name) => (name === "OPENAI_API_KEY" ? "sk-x" : undefined))).toBe(true);
    expect(billingKeyPresentInEnvironment(() => undefined)).toBe(false);
    expect(billingKeyPresentInEnvironment(() => "   ")).toBe(false);
  });
});
