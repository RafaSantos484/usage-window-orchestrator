import { describe, expect, it } from "vitest";
import { classifyCodexRun, parseCodexStream } from "../src/providers/codex/classify.ts";
import { InvocationStatus } from "../src/core/invocation.ts";
import type { ProcessRunResult } from "../src/adapters/process-runner.ts";

function run(overrides: Partial<ProcessRunResult> = {}): ProcessRunResult {
  return {
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 0,
    termSignal: null,
    timedOut: false,
    ...overrides,
  };
}

function jsonl(...lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** Representative shape of `codex exec --json` on a successful minimal run. */
const SUCCESS_STDOUT = jsonl(
  { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
  { type: "turn.started" },
  { type: "item.started", item: { id: "item_1", type: "agent_message" } },
  { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "o" } },
  { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
  {
    type: "turn.completed",
    usage: { input_tokens: 18, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0 },
  },
);

function failure(message: string, codexErrorInfo?: unknown): string {
  const error = codexErrorInfo === undefined ? { message } : { message, codexErrorInfo };
  return jsonl(
    { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "item_1", type: "agent_message" } },
    { type: "item.updated", item: { id: "item_1", type: "agent_message", text: "partial" } },
    { type: "error", message },
    { type: "turn.failed", error },
  );
}

describe("parseCodexStream", () => {
  it("reads a complete successful stream", () => {
    const stream = parseCodexStream(SUCCESS_STDOUT);

    expect(stream.startedTurns).toBe(1);
    expect(stream.completedTurns).toBe(1);
    expect(stream.failedTurns).toBe(0);
    expect(stream.lifecycleViolation).toBe(false);
    expect(stream.errorEventCount).toBe(0);
    expect(stream.agentMessages).toBe(1);
    expect(stream.agentMessageChars).toBe(2);
    expect(stream.usage?.input_tokens).toBe(18);
    expect(stream.lastEventType).toBe("turn.completed");
    expect(stream.eventTypes).toEqual([
      "thread.started",
      "turn.started",
      "item.started",
      "item.updated",
      "item.completed",
      "turn.completed",
    ]);
  });

  it("distinguishes tolerated noise from a truncated JSON line", () => {
    const stream = parseCodexStream(`warming up\n${SUCCESS_STDOUT}{"type":"turn.comp`);

    expect(stream.completedTurns).toBe(1);
    expect(stream.malformedLines).toBe(2);
    expect(stream.nonJsonNoiseLines).toBe(1);
    expect(stream.malformedJsonLines).toBe(1);
  });

  it("returns an empty stream for empty or non-JSON output", () => {
    expect(parseCodexStream("").completedTurns).toBe(0);
    expect(parseCodexStream("Usage: codex [OPTIONS]").completedTurns).toBe(0);
    expect(parseCodexStream("Usage: codex [OPTIONS]").malformedLines).toBe(1);
  });

  it("counts unknown and untyped JSON events without retaining their values", () => {
    const stream = parseCodexStream(
      `${jsonl({ type: "future.event", private: "PRIVATE" }, { private: "PRIVATE UNTyped" })}${jsonl({ type: "turn.completed" })}`,
    );

    expect(stream.unknownEventCount).toBe(2);
    expect(stream.eventTypes).toEqual(["(unknown)", "turn.completed"]);
    expect(stream.lastEventType).toBe("turn.completed");
    expect(JSON.stringify(stream)).not.toContain("future.event");
    expect(JSON.stringify(stream)).not.toContain("PRIVATE");
  });

  it("marks an unknown event after a known completion as the actual last event", () => {
    const stream = parseCodexStream(jsonl({ type: "turn.completed" }, { type: "turn.cancelled" }));

    expect(stream.unknownEventCount).toBe(1);
    expect(stream.lastEventType).toBe("(unknown)");
  });

  it("ignores JSON that is not an object", () => {
    const stream = parseCodexStream('["turn.completed"]\n"turn.completed"\n42');

    expect(stream.completedTurns).toBe(0);
    expect(stream.malformedJsonLines).toBe(3);
  });

  it("keeps only normalized error signals, never provider payloads", () => {
    const stdout = jsonl(
      {
        type: "item.completed",
        item: { id: "item_1", type: "command_execution", command: "cat /etc/passwd", aggregated_output: "root:x:0:0" },
      },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "secret response body" } },
      {
        type: "error",
        message: "boom",
        thread_id: "thread-private",
        session_id: "session-private",
        prompt: "PRIVATE PROMPT",
        response: "PRIVATE RESPONSE",
        additionalDetails: { command_output: "root:x:0:0" },
      },
    );
    const stream = parseCodexStream(stdout);

    expect(stream.errorEventCount).toBe(1);
    expect(stream.errorSignalCodes).toEqual([]);
    expect(JSON.stringify(stream)).not.toContain("thread-private");
    expect(JSON.stringify(stream)).not.toContain("session-private");
    expect(JSON.stringify(stream)).not.toContain("PRIVATE PROMPT");
    expect(JSON.stringify(stream)).not.toContain("PRIVATE RESPONSE");
    expect(JSON.stringify(stream)).not.toContain("root:x");
  });

  it("extracts only a bounded typed error discriminant", () => {
    const stdout = jsonl({
      type: "turn.failed",
      error: {
        message: "x".repeat(50_000),
        codexErrorInfo: { type: "UsageLimitExceeded", additionalDetails: "PRIVATE" },
        thread_id: "thread-private",
      },
    });
    const stream = parseCodexStream(stdout);
    expect(stream.errorKinds).toEqual(["UsageLimitExceeded"]);
    expect(JSON.stringify(stream)).not.toContain("PRIVATE");
    expect(JSON.stringify(stream)).not.toContain("thread-private");
  });

  it("keeps only allowlisted numeric usage fields", () => {
    const stream = parseCodexStream(
      jsonl({
        type: "turn.completed",
        usage: {
          input_tokens: 18,
          output_tokens: 2,
          prompt: "PRIVATE PROMPT",
          details: { response: "PRIVATE RESPONSE" },
        },
      }),
    );

    expect(stream.usage).toEqual({ input_tokens: 18, output_tokens: 2 });
    expect(JSON.stringify(stream)).not.toContain("PRIVATE PROMPT");
    expect(JSON.stringify(stream)).not.toContain("PRIVATE RESPONSE");
  });

  it("rejects negative, fractional and unsafe token counts", () => {
    const stream = parseCodexStream(
      jsonl({
        type: "turn.completed",
        usage: {
          input_tokens: -1,
          cached_input_tokens: 1.5,
          output_tokens: Number.MAX_SAFE_INTEGER + 1,
          reasoning_output_tokens: 0,
        },
      }),
    );

    expect(stream.usage).toEqual({ reasoning_output_tokens: 0 });
  });
});

describe("classifyCodexRun — success", () => {
  it("classifies a structured success and keeps only safe metadata", () => {
    const outcome = classifyCodexRun(run({ stdout: SUCCESS_STDOUT }));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(outcome.diagnostic.code).toBe("ok");
    expect(outcome.metadata).toMatchObject({
      numTurns: 1,
      agentMessages: 1,
      responseChars: 2,
      inputTokens: 18,
      cachedInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 0,
      cliLastEvent: "turn.completed",
    });
    // The thread id and the response text itself must not be carried over.
    expect(JSON.stringify(outcome.metadata)).not.toContain("0199a213");
    expect(outcome.metadata).not.toHaveProperty("text");
    expect(outcome.metadata).not.toHaveProperty("threadId");
  });

  it("still succeeds when the CLI omits usage, which is an optional field", () => {
    const stdout = jsonl(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
      { type: "turn.completed" },
    );
    const outcome = classifyCodexRun(run({ stdout }));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(outcome.metadata).toMatchObject({ numTurns: 1 });
    expect(outcome.metadata).not.toHaveProperty("inputTokens");
  });

  it("rejects a completed turn without a verifiable agent response", () => {
    const stdout = jsonl({ type: "turn.started" }, { type: "turn.completed" });
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("completed_turn_without_response");
  });

  it.each([
    ["missing turn start", jsonl({ type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.completed" })],
    ["duplicate turn start", jsonl({ type: "turn.started" }, { type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.completed" })],
    ["response before turn", jsonl({ type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.started" }, { type: "turn.completed" })],
    ["completion before turn start", jsonl({ type: "turn.completed" }, { type: "turn.started" })],
    ["failure before turn start", jsonl({ type: "turn.failed", error: { message: "failure" } }, { type: "turn.started" })],
    ["known event after terminal", `${jsonl({ type: "turn.started" }, { type: "item.completed", item: { type: "agent_message", text: "ok" } }, { type: "turn.completed" })}${jsonl({ type: "item.updated" })}`],
  ])("rejects an invalid lifecycle: %s", (_label, stdout) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("invalid_event_sequence");
    expect(outcome.metadata).toMatchObject({ invalidEventSequence: true });
  });

  it.each([
    [
      "orphan item completion",
      jsonl(
        { type: "turn.started" },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
        { type: "turn.completed" },
      ),
    ],
    [
      "mismatched item completion",
      jsonl(
        { type: "turn.started" },
        { type: "item.started", item: { id: "item_1", type: "agent_message" } },
        { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "ok" } },
        { type: "turn.completed" },
      ),
    ],
    [
      "duplicate item completion",
      jsonl(
        { type: "turn.started" },
        { type: "item.started", item: { id: "item_1", type: "agent_message" } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
        { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
        { type: "turn.completed" },
      ),
    ],
    [
      "incomplete item at turn completion",
      jsonl(
        { type: "turn.started" },
        { type: "item.started", item: { id: "item_1", type: "agent_message" } },
        { type: "turn.completed" },
      ),
    ],
  ])("rejects an invalid item lifecycle: %s", (_label, stdout) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("invalid_event_sequence");
    expect(outcome.metadata).toMatchObject({ invalidEventSequence: true });
  });

  it("rejects an empty agent response for a completed turn", () => {
    const stdout = jsonl(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "" } },
      { type: "turn.completed" },
    );
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("completed_turn_without_response");
  });

  it("rejects multiple agent responses for a completed turn", () => {
    const stdout = jsonl(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "one" } },
      { type: "item.started", item: { id: "item_2", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "two" } },
      { type: "turn.completed" },
    );
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unexpected_response_count");
  });

  it("accepts a clean completed turn with non-JSON protocol noise", () => {
    const stdout = `codex startup notice\n${SUCCESS_STDOUT}`;
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
    expect(outcome.diagnostic.code).toBe("ok");
    expect(outcome.metadata).toMatchObject({
      malformedOutputLines: 1,
      nonJsonNoiseLines: 1,
      numTurns: 1,
      cliLastEvent: "turn.completed",
    });
  });

  it.each([
    ["rate limiting", "rate limit exceeded"],
    ["upstream failure", "InternalServerError: response failed"],
    ["stream failure", "ResponseStreamDisconnected"],
    ["invalid request", "BadRequest: invalid request"],
    ["sandbox failure", "SandboxError: setup failed"],
  ])("rejects a clean response when stderr reports %s", (_label, stderr) => {
    const outcome = classifyCodexRun(run({ stdout: SUCCESS_STDOUT, stderr, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("conflicting_terminal_evidence");
  });

  it("rejects unstructured output after a terminal turn", () => {
    const stdout = `${SUCCESS_STDOUT}late CLI warning`;
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("trailing_output");
    expect(outcome.metadata).toMatchObject({ malformedOutputLines: 1, nonJsonLinesAfterTerminal: 1 });
  });

  it("rejects a truncated JSON event after an otherwise complete turn", () => {
    const stdout = `${SUCCESS_STDOUT}{"type":"error"`;
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("malformed_jsonl");
    expect(outcome.metadata).toMatchObject({ malformedOutputLines: 1, malformedJsonLines: 1 });
  });

  it.each(["stdoutTruncated", "stderrTruncated"] as const)("fails closed when %s", (field) => {
    const outcome = classifyCodexRun(run({ stdout: SUCCESS_STDOUT, exitCode: 0, [field]: true }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("output_truncated");
  });

  it("does not treat a zero exit code as success on its own", () => {
    const outcome = classifyCodexRun(run({ stdout: "", exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("incomplete_turn");
  });

  it("does not treat a completed turn as success when the CLI also reported an error", () => {
    const stdout = `${jsonl({ type: "error", message: "something went sideways" })}${SUCCESS_STDOUT}`;
    const outcome = classifyCodexRun(run({ stdout }));

    expect(outcome.status).not.toBe(InvocationStatus.SUCCESS);
  });

  it("does not treat completion plus a typed usage limit as a usage-limit result", () => {
    const stdout = jsonl(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
      { type: "error", message: "limit reached", codexErrorInfo: { type: "UsageLimitExceeded" } },
      { type: "turn.completed" },
    );
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("conflicting_terminal_evidence");
  });

  it("does not treat a response plus a typed usage limit as a usage-limit result", () => {
    const stdout = jsonl(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "partial" } },
      { type: "error", message: "limit reached", codexErrorInfo: { type: "UsageLimitExceeded" } },
    );
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("conflicting_terminal_evidence");
  });

  it.each([
    ["before completion", jsonl({ type: "future.event" }, { type: "turn.completed" })],
    ["after completion", jsonl({ type: "turn.completed" }, { type: "turn.cancelled" })],
    ["without a type", jsonl({ type: "turn.completed" }, { unexpected: true })],
  ])("fails closed for an unknown event %s even with exit code 0", (_label, stdout) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unknown_event_type");
    expect(outcome.metadata).toMatchObject({ unknownEvents: 1 });
  });

  it.each([0, 7])("rejects multiple completed turns with exit code %s", (exitCode) => {
    const stdout = jsonl({ type: "turn.started" }, { type: "turn.completed" }, { type: "turn.completed" });
    const outcome = classifyCodexRun(run({ stdout, exitCode }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unexpected_turn_count");
    expect(outcome.metadata).toMatchObject({ numTurns: 2 });
  });

  it("does not retry a completed turn that exited non-zero", () => {
    const outcome = classifyCodexRun(run({ stdout: SUCCESS_STDOUT, exitCode: 3 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("completed_turn_nonzero_exit");
    expect(outcome.diagnostic.summary).toMatch(/may already have consumed allowance/);
  });
});

describe("classifyCodexRun — provider availability", () => {
  it.each(["ENOENT", "EACCES", "ENOTDIR"])("reports %s as provider unavailable", (code) => {
    const outcome = classifyCodexRun(run({ spawnErrorCode: code, exitCode: null }));

    expect(outcome.status).toBe(InvocationStatus.PROVIDER_UNAVAILABLE);
    expect(outcome.diagnostic.code).toBe("cli_not_executable");
    expect(outcome.diagnostic.summary).toMatch(/@openai\/codex|AGENT_CODEX_BIN/);
  });

  it("reports exit code 127 as a missing CLI", () => {
    const outcome = classifyCodexRun(run({ exitCode: 127, stderr: "codex: not found" }));

    expect(outcome.status).toBe(InvocationStatus.PROVIDER_UNAVAILABLE);
    expect(outcome.diagnostic.code).toBe("cli_not_found");
  });

  it("reports an unexpected spawn failure as a non-retryable unknown failure", () => {
    const outcome = classifyCodexRun(
      run({ spawnErrorCode: "EMFILE", spawnErrorMessage: "too many open files", exitCode: null }),
    );

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("cli_spawn_failed");
  });

  it("reports a killed process as a timeout", () => {
    const outcome = classifyCodexRun(run({ timedOut: true, exitCode: null, termSignal: "SIGTERM" }));

    expect(outcome.status).toBe(InvocationStatus.TIMEOUT);
    expect(outcome.diagnostic.code).toBe("cli_timeout");
  });

  it("prefers the timeout classification over output that arrived before the kill", () => {
    const outcome = classifyCodexRun(run({ stdout: SUCCESS_STDOUT, timedOut: true, exitCode: null }));

    expect(outcome.status).toBe(InvocationStatus.TIMEOUT);
  });
});

describe("classifyCodexRun — usage limits", () => {
  it("trusts the structured UsageLimitExceeded token", () => {
    const stdout = failure("You've reached your limit.", { type: "UsageLimitExceeded", httpStatusCode: 429 });
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.USAGE_LIMIT_REACHED);
    expect(outcome.diagnostic.code).toBe("usage_limit_reached");
  });

  it.each([
    { label: "the message", event: { type: "error", message: "UsageLimitExceeded was mentioned in a diagnostic" } },
    { label: "stderr", stderr: "UsageLimitExceeded was mentioned in a diagnostic" },
    { label: "an item payload", event: { type: "item.completed", item: { type: "agent_message", text: "UsageLimitExceeded" } } },
    {
      label: "an unrelated nested property",
      event: { type: "turn.failed", error: { message: "unknown failure", details: { type: "UsageLimitExceeded" } } },
    },
  ])("does not trust UsageLimitExceeded in $label", ({ event, stderr }) => {
    const outcome = classifyCodexRun(run({ stdout: event ? jsonl(event) : "", stderr: stderr ?? "", exitCode: 1 }));

    expect(outcome.status).not.toBe(InvocationStatus.USAGE_LIMIT_REACHED);
  });

  it("does not treat plan-limit prose as trusted usage-limit evidence", () => {
    const stdout = failure("You've hit your usage limit, try again in 4 days 2 hours 46 minutes.");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unclassified");
  });

  it("does not claim a usage window for a generic rate limit", () => {
    const stdout = failure("rate_limit_exceeded: too many requests, retry later");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("provider_rate_limited");
    expect(outcome.diagnostic.summary).toMatch(/does not prove which limit/);
  });

  it("does not read a bare 429 in a token count as a rate limit", () => {
    const stdout = jsonl(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_1", type: "agent_message" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ok" } },
      { type: "turn.completed", usage: { input_tokens: 429, output_tokens: 500 } },
    );
    const outcome = classifyCodexRun(run({ stdout }));

    expect(outcome.status).toBe(InvocationStatus.SUCCESS);
  });
});

describe("classifyCodexRun — authentication", () => {
  it("classifies the documented 401 access-token failure", () => {
    const stderr =
      'ERROR: unexpected status 401 Unauthorized: {"detail":"Unauthorized"}, url: https://chatgpt.com/backend-api/codex/responses';
    const outcome = classifyCodexRun(run({ exitCode: 1, stderr }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("auth_failed");
    expect(outcome.diagnostic.summary).toMatch(/CODEX_ACCESS_TOKEN/);
  });

  it.each([
    "Not logged in. Please run `codex login`.",
    "authentication_failed",
    "invalid access token",
    "access token has expired",
    "error 403 while contacting the API",
  ])("classifies %s as an authentication failure", (message) => {
    const outcome = classifyCodexRun(run({ stdout: failure(message), exitCode: 1 }));
    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
  });

  it("reports a Platform billing error as the wrong billing path, not a usage limit", () => {
    const stdout = failure("insufficient_quota: You exceeded your current quota, please check your plan and billing details.");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("api_billing_path_detected");
    expect(outcome.diagnostic.summary).toMatch(/CODEX_API_KEY and OPENAI_API_KEY/);
  });

  it("fails loudly rather than passing with a warning when a dead credential mentions a limit", () => {
    const stdout = failure("Unauthorized: token revoked; usage limit information unavailable");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
  });

  it.each([
    [
      "usage-limit event before authentication event",
      jsonl(
        { type: "error", message: "You've hit your usage limit" },
        { type: "turn.failed", error: { message: "Unauthorized: token revoked" } },
      ),
    ],
    [
      "authentication event before usage-limit event",
      jsonl(
        { type: "error", message: "Unauthorized: token revoked" },
        { type: "turn.failed", error: { message: "You've hit your usage limit" } },
      ),
    ],
  ])("gives authentication global precedence over usage-limit prose in %s", (_label, stdout) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("auth_failed");
  });

  it("gives the wrong-billing-path signal global precedence over usage-limit prose", () => {
    const stdout = jsonl(
      { type: "error", message: "You've hit your usage limit" },
      { type: "turn.failed", error: { message: "insufficient_quota: check your plan and billing" } },
    );
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("api_billing_path_detected");
  });

  it.each([
    [
      "typed usage limit before authentication",
      jsonl(
        { type: "turn.failed", error: { message: "limit reached", codexErrorInfo: { type: "UsageLimitExceeded" } } },
        { type: "error", message: "Unauthorized: token revoked" },
      ),
    ],
    [
      "authentication before typed usage limit",
      jsonl(
        { type: "error", message: "Unauthorized: token revoked" },
        { type: "turn.failed", error: { message: "limit reached", codexErrorInfo: { type: "UsageLimitExceeded" } } },
      ),
    ],
  ])("gives authentication precedence over a typed usage limit in %s", (_label, stdout) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("auth_failed");
  });

  it.each([
    [
      "typed usage limit before billing error",
      jsonl(
        { type: "turn.failed", error: { message: "limit reached", codexErrorInfo: { type: "UsageLimitExceeded" } } },
        { type: "error", message: "insufficient_quota: check your plan and billing" },
      ),
    ],
    [
      "billing error before typed usage limit",
      jsonl(
        { type: "error", message: "insufficient_quota: check your plan and billing" },
        { type: "turn.failed", error: { message: "limit reached", codexErrorInfo: { type: "UsageLimitExceeded" } } },
      ),
    ],
  ])("gives the wrong-billing-path signal precedence over a typed usage limit in %s", (_label, stdout) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe("api_billing_path_detected");
  });

  it.each([
    [
      "authentication with an unknown event",
      jsonl({ type: "future.event" }, { type: "error", message: "Unauthorized: token revoked" }),
      "auth_failed",
    ],
    [
      "billing with an unknown event",
      jsonl({ type: "error", message: "insufficient_quota: check your plan and billing" }, { type: "future.event" }),
      "api_billing_path_detected",
    ],
  ])("preserves credential diagnostics when the stream also has %s", (_label, stdout, code) => {
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.AUTH_FAILURE);
    expect(outcome.diagnostic.code).toBe(code);
  });
});

describe("classifyCodexRun — network and upstream", () => {
  it.each(["ENOTFOUND chatgpt.com", "dns error: failed to lookup address information", "ECONNREFUSED"])(
    "does not make prose-only pre-connection evidence retryable: %s",
    (message) => {
      const outcome = classifyCodexRun(run({ stdout: failure(message), exitCode: 1 }));

      expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
      expect(outcome.diagnostic.code).toBe("unclassified");
    },
  );

  it.each([
    ["HttpConnectionFailed", "ambiguous_upstream"],
    ["error 503 service unavailable", "ambiguous_upstream"],
    ["InternalServerError", "ambiguous_upstream"],
    ["ResponseTooManyFailedAttempts", "ambiguous_upstream"],
    ["model response stream ended unexpectedly", "ambiguous_stream"],
    ["ResponseStreamDisconnected", "ambiguous_stream"],
    ["stream error: broken pipe", "ambiguous_stream"],
    ["ECONNRESET while reading the response", "ambiguous_stream"],
  ])("treats the post-connection failure %s as non-retryable", (message, code) => {
    const outcome = classifyCodexRun(run({ stdout: failure(message), exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe(code);
  });

  it.each([
    ["usage-limit prose", "PRIVATE PROMPT: you've hit your usage limit", InvocationStatus.UNKNOWN_FAILURE, "unclassified"],
    ["authentication prose", "PRIVATE PROMPT: Unauthorized", InvocationStatus.AUTH_FAILURE, "auth_failed"],
    ["network prose", "PRIVATE PROMPT: ENOTFOUND chatgpt.com", InvocationStatus.UNKNOWN_FAILURE, "unclassified"],
  ])("classifies echoed prompt text conservatively: %s", (_label, stderr, expectedStatus, expectedCode) => {
    const outcome = classifyCodexRun(run({ stderr, exitCode: 1 }));

    expect(outcome.status).toBe(expectedStatus);
    expect(outcome.diagnostic.code).toBe(expectedCode);
  });

  it("classifies a rejected request as a configuration problem", () => {
    const stdout = failure("BadRequest: model gpt-nope not found");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("invalid_request");
    expect(outcome.diagnostic.summary).toMatch(/AGENT_MODEL/);
  });

  it("does not mistake a permission-flavoured sandbox message for an auth failure", () => {
    const outcome = classifyCodexRun(
      run({ stdout: failure("sandbox denied: operation forbidden by landlock"), exitCode: 1 }),
    );

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("sandbox_error");
  });

  it("classifies a runner sandbox failure without retrying it", () => {
    const outcome = classifyCodexRun(run({ stdout: failure("SandboxError: landlock unavailable"), exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("sandbox_error");
  });
});

describe("classifyCodexRun — unrecognised output fails safe", () => {
  it("reports an unknown failure with a bounded diagnostic", () => {
    const stdout = failure("something entirely new happened");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 9 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unclassified");
    expect(outcome.diagnostic.summary).not.toContain("something entirely new happened");
    expect(outcome.diagnostic.summary.length).toBeLessThanOrEqual(240);
  });

  it("describes the stream without quoting it when there is no error text", () => {
    const stdout = jsonl({ type: "thread.started", thread_id: "0199a213" }, { type: "turn.started" });
    const outcome = classifyCodexRun(run({ stdout, exitCode: 0 }));

    expect(outcome.diagnostic.code).toBe("incomplete_turn");
    expect(outcome.diagnostic.summary).toContain("thread.started, turn.started");
    expect(outcome.diagnostic.summary).not.toContain("0199a213");
  });

  it("never quotes item payloads in a fallback diagnostic", () => {
    const stdout = jsonl(
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "PRIVATE RESPONSE BODY" } },
      {
        type: "item.completed",
        item: { id: "i2", type: "command_execution", command: "cat secrets.env", aggregated_output: "SHHH" },
      },
    );
    const outcome = classifyCodexRun(run({ stdout, exitCode: 4 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.summary).not.toContain("PRIVATE RESPONSE BODY");
    expect(outcome.diagnostic.summary).not.toContain("secrets.env");
    expect(outcome.diagnostic.summary).not.toContain("SHHH");
  });

  it("never quotes error-event payloads or stderr in a fallback diagnostic", () => {
    const stdout = jsonl({
      type: "turn.failed",
      thread_id: "thread-private",
      session_id: "session-private",
      prompt: "PRIVATE PROMPT",
      response: "PRIVATE RESPONSE",
      error: {
        message: "an unrecognised failure",
        additionalDetails: { command_output: "PRIVATE FILE CONTENT" },
      },
    });
    const outcome = classifyCodexRun(
      run({ stdout, stderr: "stderr contains PRIVATE STDERR and session-private", exitCode: 4 }),
    );

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("thread-private");
    expect(serialized).not.toContain("session-private");
    expect(serialized).not.toContain("PRIVATE PROMPT");
    expect(serialized).not.toContain("PRIVATE RESPONSE");
    expect(serialized).not.toContain("PRIVATE FILE CONTENT");
    expect(serialized).not.toContain("PRIVATE STDERR");
  });

  it("does not expose known secret values in a fallback diagnostic", () => {
    const token = "at-averylongaccesstokenvalue";
    const stdout = failure(`request rejected while using ${token}`);
    const outcome = classifyCodexRun(run({ stdout, exitCode: 9 }));

    expect(outcome.diagnostic.summary).not.toContain(token);
    // Codex diagnostics do not quote provider output at all, so the secret
    // never enters the diagnostic and no redaction marker is needed.
    expect(outcome.diagnostic.summary).not.toContain("[redacted]");
  });

  it("never propagates credential-shaped provider output into diagnostics", () => {
    const stdout = failure("authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwxyz012345");
    const outcome = classifyCodexRun(run({ stdout, exitCode: 9 }));

    expect(outcome.diagnostic.summary).not.toContain("sk-proj-abcdefghij");
  });

  it("reports malformed output volume in metadata so a contract change is visible", () => {
    const outcome = classifyCodexRun(run({ stdout: "not json\nstill not json", exitCode: 1, stderr: "???" }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.metadata).toMatchObject({ malformedOutputLines: 2 });
  });

  it("handles completely empty output on a non-zero exit", () => {
    const outcome = classifyCodexRun(run({ exitCode: 1 }));

    expect(outcome.status).toBe(InvocationStatus.UNKNOWN_FAILURE);
    expect(outcome.diagnostic.code).toBe("unclassified");
    expect(outcome.diagnostic.summary).toContain("Events seen: none");
  });
});
