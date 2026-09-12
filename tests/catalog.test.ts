import { describe, expect, it } from "vitest";
import {
  PROVIDER_IDS,
  SECRET_ENV_NAMES,
  describeProvider,
  dryRunProvider,
} from "../src/providers/catalog.ts";
import { ClaudeCodeProvider } from "../src/providers/claude/claude-code-provider.ts";
import { CodexCliProvider } from "../src/providers/codex/codex-cli-provider.ts";
import { ProviderConfigurationError } from "../src/providers/provider-configuration-error.ts";

const CLAUDE_TOKEN = "sk-ant-oat01-testtokenvaluethatislong";
const CODEX_TOKEN = "at-testaccesstokenvaluethatislongenough";

describe("provider catalog", () => {
  it("offers exactly the two implemented providers", () => {
    expect(PROVIDER_IDS).toEqual(["claude", "codex"]);
  });

  it("rejects an unknown provider id", () => {
    expect(describeProvider("gemini")).toBeUndefined();
    expect(describeProvider("CODEX")).toBeUndefined();
    expect(describeProvider("")).toBeUndefined();
  });

  it("constructs the Claude adapter for claude", () => {
    const provider = describeProvider("claude")!.create((name) =>
      name === "CLAUDE_CODE_OAUTH_TOKEN" ? CLAUDE_TOKEN : undefined,
    );

    expect(provider).toBeInstanceOf(ClaudeCodeProvider);
    expect(provider.id).toBe("claude");
  });

  it("constructs the Codex adapter for codex", () => {
    const provider = describeProvider("codex")!.create((name) =>
      name === "CODEX_ACCESS_TOKEN" ? CODEX_TOKEN : undefined,
    );

    expect(provider).toBeInstanceOf(CodexCliProvider);
    expect(provider.id).toBe("codex");
  });

  it("surfaces a missing credential as a provider configuration error, per provider", () => {
    expect(() => describeProvider("claude")!.create(() => undefined)).toThrow(ProviderConfigurationError);
    expect(() => describeProvider("codex")!.create(() => undefined)).toThrow(ProviderConfigurationError);
  });

  it("detects only its own provider's usage-billed credential", () => {
    const anthropicOnly = (name: string) => (name === "ANTHROPIC_API_KEY" ? "sk-ant-api03-x" : undefined);
    const openaiOnly = (name: string) => (name === "OPENAI_API_KEY" ? "sk-x" : undefined);

    expect(describeProvider("claude")!.billingCredentialPresent(anthropicOnly)).toBe(true);
    expect(describeProvider("claude")!.billingCredentialPresent(openaiOnly)).toBe(false);
    expect(describeProvider("codex")!.billingCredentialPresent(openaiOnly)).toBe(true);
    expect(describeProvider("codex")!.billingCredentialPresent(anthropicOnly)).toBe(false);
  });

  it("redacts every provider's credentials regardless of which one is selected", () => {
    expect(SECRET_ENV_NAMES).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "CODEX_ACCESS_TOKEN",
      "CODEX_API_KEY",
      "OPENAI_API_KEY",
    ]);
  });

  it("keeps the billing warning free of credential values", () => {
    for (const id of PROVIDER_IDS) {
      const warning = describeProvider(id)!.billingWarning;
      expect(warning).toMatch(/not forwarded to the provider/);
      expect(warning).not.toMatch(/sk-/);
    }
  });
});

describe("dryRunProvider", () => {
  it("reports the selected provider id without constructing an adapter", () => {
    expect(dryRunProvider("codex").id).toBe("codex");
    expect(dryRunProvider("claude")).not.toBeInstanceOf(ClaudeCodeProvider);
    expect(dryRunProvider("codex")).not.toBeInstanceOf(CodexCliProvider);
  });

  it("needs no credential at all", () => {
    expect(() => dryRunProvider("codex")).not.toThrow();
  });

  it("throws if anything ever tries to invoke it", async () => {
    await expect(dryRunProvider("codex").invoke({} as never, AbortSignal.timeout(1_000))).rejects.toThrow(
      /must not be invoked/,
    );
  });
});
