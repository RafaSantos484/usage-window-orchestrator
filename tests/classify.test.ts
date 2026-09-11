import { describe, expect, it } from "vitest";
import { classifyClaudeRun, parseCliEnvelope } from "../src/providers/claude/classify.ts";
import { InvocationStatus } from "../src/core/invocation.ts";
import type { ProcessRunResult } from "../src/adapters/process-runner.ts";

function run(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return { stdout: "", stderr: "", exitCode: 0, termSignal: null, timedOut: false, ...overrides };
}

/** Representative shape of `claude -p --output-format json` on success. */
const SUCCESS_STDOUT = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 2143,
  num_turns: 1,
  result: "ok",
  session_id: "3f2a7c18-0000-4000-8000-aaaaaaaaaaaa",
  total_cost_usd: 0.0031,
  usage: { input_tokens: 12, output_tokens: 3 },
});

describe("parseCliEnvelope", () => {
  it("parses a single JSON object", () => {
    expect(parseCliEnvelope(SUCCESS_STDOUT)?.subtype).toBe("success");
  });

  it("finds the result envelope in line-delimited output", () => {
    const stdout = `{"type":"system","subtype":"init"}\n${SUCCESS_STDOUT}\n`;
    expect(parseCliEnvelope(stdout)?.is_error).toBe(false);
  });

  it("returns undefined for empty or non-JSON output", () => {
    expect(parseCliEnvelope("")).toBeUndefined();
    expect(parseCliEnvelope("Usage: claude [options]")).toBeUndefined();
  });
});

describe("classifyClaudeRun", () => {
  it("classifies a structured success and keeps only safe metadata", () => {
    const outcome = classifyClaudeRun({ run: run({ stdout: SUCCESS_STDOUT }), secrets: [] });

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(outcome.diagnostic.code).toBe("ok");
    expect(outcome.metadata).toMatchObject({ numTurns: 1, inputTokens: 12, outputTokens: 3, responseChars: 2 });
    // The session id and the response text itself must not be carried over.
    expect(JSON.stringify(outcome.metadata)).not.toContain("3f2a7c18");
    expect(outcome.metadata).not.toHaveProperty("result");
  });

  it("treats a max-turns stop as a success, because allowance was still consumed", () => {
    const stdout = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false, num_turns: 1 });
    const outcome = classifyClaudeRun({ run: run({ stdout }), secrets: [] });

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(outcome.diagnostic.code).toBe("ok_error_max_turns");
  });

  it("classifies a usage limit", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "Claude AI usage limit reached. Your limit will reset at 3pm.",
    });
    const outcome = classifyClaudeRun({ run: run({ stdout, exitCode: 1 }), secrets: [] });

    expect(outcome.status).toBe(InvocationStatus.USAGE_LIMIT_REACHED);
    expect(outcome.diagnostic.code).toBe("usage_limit_reached");
  });

  it("classifies a rate-limit error emitted on stderr", () => {
    const outcome = classifyClaudeRun({
      run: run({ exitCode: 1, stderr: 'API Error: 429 {"type":"rate_limit_error"}' }),
      secrets: [],
    });
    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("provider_rate_limited");
  });

  it.each([
    ["Invalid API key · Please run /login", "auth_failed"],
    ["OAuth token expired", "auth_failed"],
    ["API Error: 401 {\"type\":\"authentication_error\"}", "auth_failed"],
  ])("classifies %s as an auth failure", (stderr, code) => {
    const outcome = classifyClaudeRun({ run: run({ exitCode: 1, stderr }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe(code);
  });

  it("treats a low credit balance as an auth failure, since it implies API-key billing", () => {
    const outcome = classifyClaudeRun({
      run: run({ exitCode: 1, stderr: "Credit balance is too low" }),
      secrets: [],
    });
    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("credit_balance_low");
  });

  it.each([
    ['API Error: 529 {"type":"overloaded_error"}', "ambiguous_upstream"],
    ["fetch failed: ECONNRESET", "ambiguous_network"],
  ])("classifies %s as ambiguous and non-retryable", (stderr, code) => {
    const outcome = classifyClaudeRun({ run: run({ exitCode: 1, stderr }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe(code);
  });

  it.each([
    ["getaddrinfo ENOTFOUND api.anthropic.com", "preconnect_network_failure"],
    ["getaddrinfo EAI_AGAIN api.anthropic.com", "preconnect_network_failure"],
    ["connect ECONNREFUSED", "preconnect_network_failure"],
  ])("classifies %s as a retryable pre-connect failure", (stderr, code) => {
    const outcome = classifyClaudeRun({ run: run({ exitCode: 1, stderr }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.TRANSIENT_FAILURE);
    expect(outcome.diagnostic.code).toBe(code);
  });

  it("prefers explicit usage-limit evidence over generic rate limiting", () => {
    const outcome = classifyClaudeRun({
      run: run({ exitCode: 1, stderr: "429 rate_limit_error: usage limit reached; limit will reset later" }),
      secrets: [],
    });
    expect(outcome.status).toBe(InvocationStatus.USAGE_LIMIT_REACHED);
  });

  it("classifies a killed run as a timeout before reading any output", () => {
    const outcome = classifyClaudeRun({
      run: run({ timedOut: true, exitCode: null, termSignal: "SIGTERM", stderr: "usage limit reached" }),
      secrets: [],
    });
    expect(outcome.status).toBe(InvocationStatus.TIMEOUT);
    expect(outcome.diagnostic.code).toBe("cli_timeout");
  });

  it("classifies a missing binary as provider-unavailable", () => {
    const outcome = classifyClaudeRun({
      run: run({ exitCode: null, spawnErrorCode: "ENOENT", spawnErrorMessage: "spawn claude ENOENT" }),
      secrets: [],
    });
    expect(outcome.status).toBe(InvocationStatus.PROVIDER_UNAVAILABLE);
    expect(outcome.diagnostic.code).toBe("cli_not_executable");
  });

  it("treats exit code 127 as a missing binary", () => {
    const outcome = classifyClaudeRun({ run: run({ exitCode: 127, stderr: "claude: command not found" }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.PROVIDER_UNAVAILABLE);
  });

  it("falls back to an unclassified failure and redacts the excerpt", () => {
    const outcome = classifyClaudeRun({
      run: run({ exitCode: 3, stderr: "something odd happened with token sk-ant-oat01-abcdefghijklmnop" }),
      secrets: ["sk-ant-oat01-abcdefghijklmnop"],
    });

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unclassified");
    expect(outcome.diagnostic.summary).not.toContain("sk-ant-oat01-abcdefghijklmnop");
    expect(outcome.diagnostic.summary).toContain("[redacted]");
  });

  it("does not mistake numeric JSON fields for HTTP status codes", () => {
    // duration_ms values that would match a bare /\b5\d{2}\b/ or /429/.
    for (const duration of [429, 500, 503, 529]) {
      const stdout = JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: duration,
        num_turns: 1,
        result: "Something went wrong.",
      });
      const outcome = classifyClaudeRun({ run: run({ stdout, exitCode: 1 }), secrets: [] });
      expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    }
  });

  it("still recognises a status code that carries real error context", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      duration_ms: 812,
      result: "API Error: 529 overloaded_error",
    });
    const outcome = classifyClaudeRun({ run: run({ stdout, exitCode: 1 }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("ambiguous_upstream");
  });

  it("does not let a successful envelope's token counts read as an auth failure", () => {
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "ok",
      usage: { input_tokens: 401, output_tokens: 403 },
    });
    const outcome = classifyClaudeRun({ run: run({ stdout }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
  });

  it("does not report success when the CLI exits non-zero despite a parsable envelope", () => {
    const outcome = classifyClaudeRun({
      run: run({ stdout: SUCCESS_STDOUT, exitCode: 1, stderr: "unexpected" }),
      secrets: [],
    });
    expect(outcome.status).not.toBe(InvocationStatus.SUCCESS);
  });

  it.each([
    '{"type":"system","is_error":false}',
    '{"is_error":false}',
    '{"type":"assistant","is_error":false,"result":"ok"}',
  ])("does not classify a non-result JSON object as success", (stdout) => {
    const outcome = classifyClaudeRun({ run: run({ stdout, exitCode: 0 }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
  });

  it.each([
    '{"type":"result","is_error":false}',
    '{"type":"result","subtype":"success","is_error":false}',
    '{"type":"result","subtype":"unexpected","is_error":false,"result":"ok"}',
  ])("does not infer success from an incomplete or unknown result envelope", (stdout) => {
    const outcome = classifyClaudeRun({ run: run({ stdout, exitCode: 0 }), secrets: [] });
    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
  });
});
