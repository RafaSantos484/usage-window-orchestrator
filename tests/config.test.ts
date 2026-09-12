import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULTS,
  applyCliOverrides,
  loadConfig,
  MAX_EXECUTION_BUDGET_SECONDS,
  worstCaseExecutionSeconds,
} from "../src/config.ts";
import { PROVIDER_IDS } from "../src/providers/catalog.ts";

const PROVIDERS = PROVIDER_IDS;

describe("loadConfig", () => {
  it("applies safe defaults when nothing is set", () => {
    const config = loadConfig({}, PROVIDERS);

    expect(config.providerId).toBe("claude");
    expect(config.prompt).toBe(DEFAULTS.prompt);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.retry.maxAttempts).toBe(2);
    expect(config.dryRun).toBe(false);
    expect(config.triggerSource).toBe("manual");
    expect(config.model).toBeUndefined();
  });

  it("reads and normalizes overrides", () => {
    const config = loadConfig(
      {
        AGENT_PROVIDER: "  CLAUDE ",
        AGENT_PROMPT: "  say ok  ",
        AGENT_MODEL: "haiku",
        AGENT_TIMEOUT_SECONDS: "90",
        AGENT_MAX_ATTEMPTS: "3",
        AGENT_DRY_RUN: "yes",
        AGENT_LOG_LEVEL: "DEBUG",
        AGENT_TRIGGER_SOURCE: "scheduled",
      },
      PROVIDERS,
    );

    expect(config.providerId).toBe("claude");
    expect(config.prompt).toBe("say ok");
    expect(config.model).toBe("haiku");
    expect(config.timeoutMs).toBe(90_000);
    expect(config.retry.maxAttempts).toBe(3);
    expect(config.dryRun).toBe(true);
    expect(config.logLevel).toBe("debug");
    expect(config.triggerSource).toBe("scheduled");
  });

  it.each(["claude", "codex"])("accepts the implemented provider %s", (providerId) => {
    expect(loadConfig({ AGENT_PROVIDER: providerId }, PROVIDERS).providerId).toBe(providerId);
  });

  it("normalizes a provider id the same way for every provider", () => {
    expect(loadConfig({ AGENT_PROVIDER: "  CODEX " }, PROVIDERS).providerId).toBe("codex");
  });

  it("rejects an unregistered provider and names the alternatives", () => {
    expect(() => loadConfig({ AGENT_PROVIDER: "gemini" }, PROVIDERS)).toThrow(ConfigError);
    try {
      loadConfig({ AGENT_PROVIDER: "gemini" }, PROVIDERS);
    } catch (error) {
      expect((error as ConfigError).problems[0]).toContain("claude");
      expect((error as ConfigError).problems[0]).toContain("codex");
    }
  });

  it("keeps claude as the default provider", () => {
    expect(loadConfig({}, PROVIDERS).providerId).toBe("claude");
    expect(DEFAULTS.providerId).toBe("claude");
  });

  it("reports every problem at once rather than failing one at a time", () => {
    try {
      loadConfig(
        {
          AGENT_PROVIDER: "nope",
          AGENT_TIMEOUT_SECONDS: "9999",
          AGENT_MAX_ATTEMPTS: "abc",
          AGENT_LOG_LEVEL: "chatty",
          AGENT_DRY_RUN: "maybe",
        },
        PROVIDERS,
      );
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(5);
    }
  });

  it.each([
    ["AGENT_TIMEOUT_SECONDS", "1"],
    ["AGENT_TIMEOUT_SECONDS", "601"],
    ["AGENT_MAX_ATTEMPTS", "0"],
    ["AGENT_MAX_ATTEMPTS", "4"],
  ])("rejects %s=%s as out of range", (name, value) => {
    expect(() => loadConfig({ [name]: value }, PROVIDERS)).toThrow(ConfigError);
  });

  it("rejects a prompt long enough to stop being minimal", () => {
    expect(() => loadConfig({ AGENT_PROMPT: "x".repeat(501) }, PROVIDERS)).toThrow(ConfigError);
  });

  it("rejects an attempt budget that can outlive the workflow job", () => {
    expect(() => loadConfig({ AGENT_TIMEOUT_SECONDS: "600", AGENT_MAX_ATTEMPTS: "1" }, PROVIDERS)).toThrow(
      new RegExp(`${MAX_EXECUTION_BUDGET_SECONDS}.*application budget`),
    );
  });

  it("includes grace time and exponential backoff in the worst-case budget", () => {
    expect(worstCaseExecutionSeconds(100, 3)).toBe(330);
  });

  it("accepts a configuration just below the application budget", () => {
    expect(worstCaseExecutionSeconds(232, 2)).toBe(479);
    expect(() =>
      loadConfig({ AGENT_TIMEOUT_SECONDS: "232", AGENT_MAX_ATTEMPTS: "2" }, PROVIDERS),
    ).not.toThrow();
  });

  it("accepts an empty value as 'use the default'", () => {
    const config = loadConfig({ AGENT_TIMEOUT_SECONDS: "", AGENT_PROMPT: "   " }, PROVIDERS);
    expect(config.timeoutMs).toBe(120_000);
    expect(config.prompt).toBe(DEFAULTS.prompt);
  });

  it("maps supported command-line flags onto configuration", () => {
    const config = loadConfig(applyCliOverrides(["--dry-run"], {}), PROVIDERS);
    expect(config.dryRun).toBe(true);
  });

  it("supports both provider flag forms", () => {
    expect(applyCliOverrides(["--provider", "claude"], {}).AGENT_PROVIDER).toBe("claude");
    expect(applyCliOverrides(["--provider=claude"], {}).AGENT_PROVIDER).toBe("claude");
  });

  it("accepts codex through either provider flag form", () => {
    expect(loadConfig(applyCliOverrides(["--provider", "codex"], {}), PROVIDERS).providerId).toBe("codex");
    expect(loadConfig(applyCliOverrides(["--provider=codex"], {}), PROVIDERS).providerId).toBe("codex");
  });

  it("applies the same shared settings whichever provider is selected", () => {
    const shared = {
      AGENT_PROMPT: "say ok",
      AGENT_MODEL: "some-model",
      AGENT_TIMEOUT_SECONDS: "90",
      AGENT_MAX_ATTEMPTS: "3",
      AGENT_LOG_LEVEL: "debug",
      AGENT_TRIGGER_SOURCE: "scheduled",
    };
    const claude = loadConfig({ ...shared, AGENT_PROVIDER: "claude" }, PROVIDERS);
    const codex = loadConfig({ ...shared, AGENT_PROVIDER: "codex" }, PROVIDERS);

    expect({ ...codex, providerId: "claude" }).toEqual(claude);
  });

  it("rejects unknown flags instead of silently invoking defaults", () => {
    expect(() => applyCliOverrides(["--wat"], { AGENT_MODEL: "haiku" })).toThrow(/Unknown command-line option/);
  });

  it("rejects a missing or option-looking provider value", () => {
    expect(() => applyCliOverrides(["--provider"], {})).toThrow(/requires a provider id/);
    expect(() => applyCliOverrides(["--provider", "--dry-run"], {})).toThrow(/requires a provider id/);
  });
});
