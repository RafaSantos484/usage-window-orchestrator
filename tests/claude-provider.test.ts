import { describe, expect, it, vi } from "vitest";
import {
  ClaudeCodeProvider,
  type IsolationDirectories,
  OAUTH_TOKEN_ENV,
  ProviderConfigurationError,
  apiKeyPresentInEnvironment,
  buildArgs,
} from "../src/providers/claude/claude-code-provider.ts";
import type { ProcessRunResult, ProcessSpec } from "../src/adapters/process-runner.ts";
import { InvocationStatus, type InvocationRequest } from "../src/core/invocation.ts";

const TOKEN = "sk-ant-oat01-testtokenvaluethatislong";

const REQUEST: InvocationRequest = {
  invocationId: "inv-1",
  providerId: "claude",
  triggerSource: "scheduled",
  prompt: "Reply with the single word: ok",
  timeoutMs: 30_000,
};

function fakeRunner(result: Partial<ProcessRunResult> = {}) {
  const calls: ProcessSpec[] = [];
  const runner = vi.fn(async (spec: ProcessSpec): Promise<ProcessRunResult> => {
    calls.push(spec);
    return {
      stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
      stderr: "",
      exitCode: 0,
      termSignal: null,
      timedOut: false,
      ...result,
    };
  });
  return { runner, calls };
}

describe("buildArgs", () => {
  it("builds a bounded, structured-output headless invocation", () => {
    expect(buildArgs(REQUEST)).toEqual([
      "-p",
      "Reply with the single word: ok",
      "--output-format",
      "json",
      "--max-turns",
      "1",
    ]);
  });

  it("adds the model only when one is configured", () => {
    expect(buildArgs({ ...REQUEST, model: "haiku" })).toContain("--model");
    expect(buildArgs({ ...REQUEST, model: "haiku" }).at(-1)).toBe("haiku");
  });
});

describe("ClaudeCodeProvider construction", () => {
  it("fails fast with an actionable message when the token is missing", () => {
    expect(() => new ClaudeCodeProvider({ env: () => undefined })).toThrow(ProviderConfigurationError);
    expect(() => new ClaudeCodeProvider({ env: () => undefined })).toThrow(/claude setup-token/);
  });

  it("refuses a usage-billed API key supplied in the token variable", () => {
    const env = (name: string) => (name === OAUTH_TOKEN_ENV ? "sk-ant-api03-abcdefghijklmno" : undefined);
    expect(() => new ClaudeCodeProvider({ env })).toThrow(/never bills per token/);
  });

});

describe("ClaudeCodeProvider.invoke", () => {
  const env = (name: string) =>
    name === OAUTH_TOKEN_ENV ? TOKEN : name === "PATH" ? "/usr/bin" : undefined;

  it("returns a normalized success outcome", async () => {
    const { runner } = fakeRunner();
    const provider = new ClaudeCodeProvider({ env, runner });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("normalizes isolation setup failures without invoking the provider", async () => {
    const runner = vi.fn();
    const provider = new ClaudeCodeProvider({
      env,
      runner,
      isolationFactory: async (): Promise<IsolationDirectories> => {
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
    const isolation: IsolationDirectories = {
      root: "/tmp/test-isolation",
      home: "/tmp/test-isolation/home",
      tmp: "/tmp/test-isolation/tmp",
      cwd: "/tmp/test-isolation/cwd",
    };
    const provider = new ClaudeCodeProvider({
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

  it("passes the subscription token and withholds every unrelated variable", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new ClaudeCodeProvider({ env, runner });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    const childEnv = calls[0]!.env;
    expect(childEnv[OAUTH_TOKEN_ENV]).toBe(TOKEN);
    expect(childEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(childEnv).not.toHaveProperty("UNRELATED_CI_SECRET");
    expect(childEnv.PATH).toBe("/usr/bin");
    expect(childEnv.HOME).toMatch(/usage-window-claude-/);
    expect(childEnv.TMPDIR).toMatch(/usage-window-claude-/);
    expect(calls[0]!.cwd).toMatch(/usage-window-claude-/);
  });

  it("never invokes a shell and runs outside the repository", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new ClaudeCodeProvider({ env, runner, cwd: "/tmp/neutral" });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));

    expect(calls[0]!.command).toBe("claude");
    expect(calls[0]!.cwd).toBe("/tmp/neutral");
  });

  it("honours a custom binary path", async () => {
    const { runner, calls } = fakeRunner();
    const provider = new ClaudeCodeProvider({
      env: (name) => (name === OAUTH_TOKEN_ENV ? TOKEN : name === "AGENT_CLAUDE_BIN" ? "/opt/bin/claude" : undefined),
      runner,
    });
    await provider.invoke(REQUEST, AbortSignal.timeout(60_000));
    expect(calls[0]!.command).toBe("/opt/bin/claude");
  });

  it("normalizes a killed run into a timeout outcome", async () => {
    const { runner } = fakeRunner({ stdout: "", timedOut: true, exitCode: null, termSignal: "SIGTERM" });
    const provider = new ClaudeCodeProvider({ env, runner });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));
    expect(outcome.status).toBe(InvocationStatus.TIMEOUT);
  });

  it("redacts the token from an unclassified diagnostic", async () => {
    const { runner } = fakeRunner({ stdout: "", exitCode: 5, stderr: `weird failure using ${TOKEN}` });
    const provider = new ClaudeCodeProvider({ env, runner });

    const outcome = await provider.invoke(REQUEST, AbortSignal.timeout(60_000));
    expect(outcome.diagnostic.summary).not.toContain(TOKEN);
  });
});

describe("apiKeyPresentInEnvironment", () => {
  it("detects a usage-billed key so the operator can be warned", () => {
    expect(apiKeyPresentInEnvironment(() => "sk-ant-api03-x")).toBe(true);
    expect(apiKeyPresentInEnvironment(() => undefined)).toBe(false);
    expect(apiKeyPresentInEnvironment(() => "   ")).toBe(false);
  });
});
