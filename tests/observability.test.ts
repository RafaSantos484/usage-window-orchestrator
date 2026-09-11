import { describe, expect, it } from "vitest";
import { redact, redactValue, safeSummary, summarize } from "../src/core/logging.ts";
import { JsonLogger } from "../src/adapters/json-logger.ts";
import { renderSummary } from "../src/adapters/github-summary.ts";
import { InvocationStatus, type InvocationResult } from "../src/core/invocation.ts";
import { logUnhandledError } from "../src/adapters/unhandled-error.ts";

const TOKEN = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

describe("redact", () => {
  it("removes known secret values", () => {
    expect(redact(`token=${TOKEN} done`, [TOKEN])).toBe("token=[redacted] done");
  });

  it("removes credential-shaped strings even when the value is unknown", () => {
    expect(redact("key sk-ant-api03-unknownvalue here")).toContain("[redacted]");
    expect(redact("Authorization: Bearer abcdefghijklmnopqrst")).toContain("[redacted]");
  });

  it("removes JWT-shaped strings", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOjEyMzQ1.SflKxwRJSMeKKF2QT4f";
    expect(redact(`got ${jwt}`)).not.toContain(jwt);
  });

  it("leaves short values alone so ordinary text survives", () => {
    expect(redact("status ok", ["ok"])).toBe("status ok");
  });
});

describe("summarize", () => {
  it("collapses whitespace and truncates", () => {
    expect(summarize("a\n\n  b   c")).toBe("a b c");
    expect(summarize("x".repeat(300), 50)).toHaveLength(50);
  });

  it("redacts before truncating so a secret cannot survive at the boundary", () => {
    const text = `prefix ${TOKEN} suffix`;
    expect(safeSummary(text, [TOKEN])).not.toContain("sk-ant-oat01");
  });
});

describe("JsonLogger", () => {
  function capture(level: Parameters<typeof makeLogger>[0] = "info") {
    const lines: string[] = [];
    return { lines, logger: makeLogger(level, lines) };
  }
  function makeLogger(level: "debug" | "info" | "warn" | "error", lines: string[]) {
    return new JsonLogger({
      level,
      secrets: [TOKEN],
      write: (line) => lines.push(line),
      now: () => new Date("2026-09-11T07:00:00Z"),
    });
  }

  it("emits one structured JSON object per line", () => {
    const { lines, logger } = capture();
    logger.info("invocation.start", { providerId: "claude", attempt: 1 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: "2026-09-11T07:00:00.000Z",
      level: "info",
      event: "invocation.start",
      providerId: "claude",
      attempt: 1,
    });
  });

  it("filters below the configured level", () => {
    const { lines, logger } = capture("warn");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["c", "d"]);
  });

  it("redacts secrets that reach a field value", () => {
    const { lines, logger } = capture();
    logger.error("provider.threw", { detail: `failed with ${TOKEN}` });
    expect(lines[0]).not.toContain("sk-ant-oat01");
    expect(lines[0]).toContain("[redacted]");
  });

  it("drops undefined fields and survives unserializable ones", () => {
    const { lines, logger } = capture();
    logger.info("e", { present: 1, absent: undefined });
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("absent");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    logger.info("f", { cyclic });
    expect(JSON.parse(lines[1]!).error).toBe("unserializable_fields");
  });
});

describe("renderSummary", () => {
  const result: InvocationResult = {
    providerId: "claude",
    invocationId: "inv-1",
    triggerSource: "scheduled",
    startedAt: "2026-09-11T07:02:00.000Z",
    finishedAt: "2026-09-11T07:02:03.000Z",
    durationMs: 3_000,
    attempts: 1,
    retried: false,
    status: InvocationStatus.USAGE_LIMIT_REACHED,
    severity: "neutral",
    exitCode: 10,
    diagnostic: { code: "usage_limit_reached", summary: "Claude reported that the limit is reached." },
    metadata: { numTurns: 1 },
  };

  it("renders an operator-readable markdown summary", () => {
    const markdown = renderSummary(result);
    expect(markdown).toContain("## Usage window trigger — claude");
    expect(markdown).toContain("expected operational outcome");
    expect(markdown).toContain("`usage_limit_reached`");
  });

  it("carries no prompt, response text, or credentials", () => {
    const markdown = renderSummary(result);
    expect(markdown).not.toMatch(/sk-ant/);
    expect(markdown).not.toMatch(/prompt/i);
  });

  it("redacts secrets from provider metadata at the summary boundary", () => {
    const metadataSecret = 'private"secret-value';
    const markdown = renderSummary(
      { ...result, metadata: { cliSubtype: metadataSecret } },
      [metadataSecret],
    );
    expect(markdown).not.toContain(metadataSecret);
    expect(markdown).toContain("[redacted]");
  });

  it("redacts arbitrary nested values before JSON serialization", () => {
    const secret = 'private"secret\\value\n';
    const safe = redactValue({ nested: [secret] }, [secret]);

    expect(safe).toEqual({ nested: ["[redacted]"] });
    expect(JSON.stringify(safe)).not.toContain(secret);
  });
});

describe("unhandled error fallback", () => {
  it("redacts token-bearing exception messages", () => {
    const lines: string[] = [];
    logUnhandledError(new Error(`unexpected ${TOKEN}`), [TOKEN], (line) => lines.push(line));
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).toContain("[redacted]");
  });
});
