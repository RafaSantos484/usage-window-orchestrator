import { appendFile } from "node:fs/promises";
import { InvocationStatus, type InvocationResult } from "../core/invocation.ts";
import { redact, redactValue } from "../core/logging.ts";

/**
 * Human-readable, secret-safe explanation per normalized status. Kept next to
 * the reporting code because this is presentation, not domain logic.
 */
const HEADLINE: Readonly<Record<InvocationStatus, string>> = Object.freeze({
  [InvocationStatus.SUCCESS]: "✅ Invocation succeeded — subscription allowance was used.",
  [InvocationStatus.USAGE_LIMIT_REACHED]:
    "⚠️ Provider reported that the usage limit is reached — no completed response was observed. This is an expected operational outcome, not a defect.",
  [InvocationStatus.AUTH_FAILURE]: "❌ Authentication failed — the provider credential needs attention.",
  [InvocationStatus.TIMEOUT]: "❌ Timed out — the provider did not answer within the configured budget.",
  [InvocationStatus.PROVIDER_UNAVAILABLE]: "❌ Provider CLI unavailable — it could not be executed.",
  [InvocationStatus.TRANSIENT_FAILURE]: "❌ Transient failure — retries were exhausted.",
  [InvocationStatus.UNKNOWN_FAILURE]: "❌ Uncertain invocation outcome — see the diagnostic below.",
  [InvocationStatus.SKIPPED]: "⏭️ Skipped — no provider call was made.",
});

/** Rows rendered from the result. Nothing here derives from prompt or response text. */
function rows(result: InvocationResult): [string, string][] {
  const entries: [string, string][] = [
    ["Provider", result.providerId],
    ["Trigger", result.triggerSource],
    ["Status", `\`${result.status}\``],
    ["Attempts", `${result.attempts}${result.retried ? " (retried)" : ""}`],
    ["Started", result.startedAt],
    ["Duration", `${result.durationMs} ms`],
    ["Diagnostic", `\`${result.diagnostic.code}\``],
    ["Exit code", String(result.exitCode)],
  ];
  return entries;
}

export function renderSummary(
  result: InvocationResult,
  secrets: readonly (string | undefined)[] = [],
): string {
  const table = rows(result)
    .map(([key, value]) => `| ${key} | ${value} |`)
    .join("\n");

  const metadata = result.metadata
    ? `\n<details><summary>Provider metadata</summary>\n\n\`\`\`json\n${JSON.stringify(
        redactValue(result.metadata, secrets),
        null,
        2,
      )}\n\`\`\`\n</details>\n`
    : "";

  return redact([
    `## Usage window trigger — ${result.providerId}`,
    "",
    HEADLINE[result.status],
    "",
    `> ${result.diagnostic.summary}`,
    "",
    "| Field | Value |",
    "| --- | --- |",
    table,
    metadata,
    "",
  ].join("\n"), secrets);
}

/**
 * Writes the run summary and machine-readable outputs to the GitHub Actions
 * files, when running there. A no-op everywhere else.
 */
export async function publishToGitHub(
  result: InvocationResult,
  env: Readonly<Record<string, string | undefined>> = process.env,
  secrets: readonly (string | undefined)[] = [],
): Promise<void> {
  const summaryPath = env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    await appendFile(summaryPath, renderSummary(result, secrets), "utf8");
  }

  const outputPath = env.GITHUB_OUTPUT;
  if (outputPath) {
    const outputs = [
      `status=${result.status}`,
      `severity=${result.severity}`,
      `exit_code=${result.exitCode}`,
      `diagnostic_code=${result.diagnostic.code}`,
    ].join("\n");
    await appendFile(outputPath, redact(`${outputs}\n`, secrets), "utf8");
  }
}
