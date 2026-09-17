/**
 * Guards the invariants of the GitHub Actions wiring that a reviewer would
 * otherwise have to re-check by hand on every change: secret isolation between
 * providers, consumer-owned scheduling, deterministic provider selection,
 * least-privilege permissions, pinned runtimes and actions, and complete
 * exit-code coverage.
 *
 * These are text assertions rather than a YAML model, so the repository keeps
 * its zero-dependency posture. They cannot prove that GitHub *executes* the
 * workflow correctly - concurrency queueing and consumer-enabled cron
 * delivery are platform behaviours with no application code to test. See README.md
 * ("Validating overlap protection") for the manual procedure.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ExitCode } from "../src/core/invocation.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const CLAUDE_WORKFLOW = ".github/workflows/usage-window-trigger.yml";
const CODEX_WORKFLOW = ".github/workflows/usage-window-trigger-codex.yml";
const CLASSIFY_ACTION = ".github/actions/classify-outcome/action.yml";

interface ProviderWorkflow {
  readonly label: string;
  readonly path: string;
  readonly yaml: string;
  readonly providerId: string;
  readonly ownSecret: string;
  /** Credentials that must not appear anywhere in this workflow. */
  readonly foreignSecrets: readonly string[];
  readonly cliPackage: string;
  readonly cliVersion: string;
  readonly concurrencyGroup: string;
  readonly environmentName: string;
}

const WORKFLOWS: readonly ProviderWorkflow[] = [
  {
    label: "claude",
    path: CLAUDE_WORKFLOW,
    yaml: read(CLAUDE_WORKFLOW),
    providerId: "claude",
    ownSecret: "CLAUDE_CODE_OAUTH_TOKEN",
    foreignSecrets: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"],
    cliPackage: "@anthropic-ai/claude-code",
    cliVersion: "2.1.268",
    concurrencyGroup: "usage-window-trigger-claude",
    environmentName: "usage-window-claude",
  },
  {
    label: "codex",
    path: CODEX_WORKFLOW,
    yaml: read(CODEX_WORKFLOW),
    providerId: "codex",
    ownSecret: "CODEX_ACCESS_TOKEN",
    foreignSecrets: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY"],
    cliPackage: "@openai/codex",
    cliVersion: "0.154.0",
    concurrencyGroup: "usage-window-trigger-codex",
    environmentName: "usage-window-codex",
  },
];

describe.each(WORKFLOWS)("$label trigger workflow", (workflow) => {
  it("selects its provider literally, so manual and consumer-scheduled runs are deterministic", () => {
    expect(workflow.yaml).toContain(`AGENT_PROVIDER: ${workflow.providerId}`);
    expect(workflow.yaml).not.toMatch(/AGENT_PROVIDER:.*github\.event\.inputs/);
  });

  it("declares a default-branch guard and checks out the default branch", () => {
    expect(workflow.yaml).toContain(
      "if: ${{ github.ref_name == github.event.repository.default_branch }}",
    );
    expect(workflow.yaml).toContain("ref: ${{ github.event.repository.default_branch }}");
  });

  it("declares a provider environment for repository-side secret policy", () => {
    expect(workflow.yaml).toContain(`environment: ${workflow.environmentName}`);
  });

  it("is manual-only upstream and identifies the consumer scheduling activation point", () => {
    const wiring = withoutComments(workflow.yaml);
    expect(wiring).toMatch(/^\s*workflow_dispatch:/m);
    expect(wiring).not.toMatch(/^\s*schedule:/m);
    expect(wiring).not.toMatch(/^\s*- cron:/m);
    expect(workflow.yaml).toContain("docs/scheduling.md");
  });

  it("retains dry-run dispatch and reports a consumer-added schedule accurately", () => {
    expect(workflow.yaml).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+dry_run:/);
    expect(workflow.yaml).toContain(
      "AGENT_TRIGGER_SOURCE: ${{ github.event_name == 'schedule' && 'scheduled' || 'manual' }}",
    );
  });

  it("wires only its own provider's credential", () => {
    expect(workflow.yaml).toContain(`${workflow.ownSecret}: \${{ secrets.${workflow.ownSecret} }}`);
    // Comments are stripped: the Codex workflow deliberately *documents* that
    // it keeps the Claude credential out of the job.
    const wiring = withoutComments(workflow.yaml);
    for (const foreign of workflow.foreignSecrets) {
      expect(wiring).not.toContain(foreign);
    }
  });

  it("scopes the credential to the invocation step, not the job", () => {
    const beforeSteps = workflow.yaml.slice(workflow.yaml.indexOf("jobs:"), workflow.yaml.indexOf("    steps:"));
    expect(beforeSteps).not.toContain(workflow.ownSecret);
  });

  it("installs the provider runtime before introducing the credential", () => {
    const install = workflow.yaml.indexOf(`"${workflow.cliPackage}@${workflow.cliVersion}"`);
    const secretWiring = workflow.yaml.indexOf(`${workflow.ownSecret}: \${{ secrets.${workflow.ownSecret} }}`);
    expect(install).toBeGreaterThan(-1);
    expect(secretWiring).toBeGreaterThan(install);
  });

  it("installs the provider runtime at a reviewed exact version", () => {
    expect(workflow.yaml).toContain(
      `npm install -g --no-audit --no-fund "${workflow.cliPackage}@${workflow.cliVersion}"`,
    );
    expect(workflow.yaml).not.toMatch(/npm install -g[^\n]*\$\{/);
  });

  it("skips the runtime install on a dry run, so a dry run needs no CLI", () => {
    expect(workflow.yaml).toMatch(/if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/);
  });

  it("prevents overlap without cancelling an in-flight invocation", () => {
    expect(workflow.yaml).toContain(`group: ${workflow.concurrencyGroup}`);
    expect(workflow.yaml).toContain("cancel-in-progress: false");
  });

  it("keeps repository permissions read-only and bounds the job", () => {
    expect(workflow.yaml).toMatch(/permissions:\n {2}contents: read/);
    expect(workflow.yaml).not.toMatch(/contents: write/);
    expect(workflow.yaml).toContain("timeout-minutes: 10");
  });

  it("is unreachable from a pull request, so a fork cannot reach the secret", () => {
    expect(workflow.yaml).not.toMatch(/^\s*pull_request/m);
    expect(workflow.yaml).not.toMatch(/pull_request_target/);
    expect(workflow.yaml).toContain("persist-credentials: false");
  });

  it("uses only first-party actions pinned to an immutable commit, or local ones", () => {
    const uses = [...workflow.yaml.matchAll(/^\s*uses: (\S+)/gm)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      if (reference.startsWith("./")) continue;
      expect(reference).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    }
  });

  it("passes dispatch inputs through the environment, never into a run script", () => {
    const scripts = [...workflow.yaml.matchAll(/run: \|\n((?: {10}.*\n)+)/g)].map((match) => match[1]!);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).not.toContain("${{");
    }
  });

  it("delegates outcome classification to the shared action", () => {
    expect(workflow.yaml).toContain("uses: ./.github/actions/classify-outcome");
    expect(workflow.yaml).toMatch(/exit-code: \$\{\{ steps\.trigger\.outputs\.process_exit_code \}\}/);
  });
});

describe("trigger workflows together", () => {
  it("ship no active provider schedule", () => {
    for (const workflow of WORKFLOWS) {
      const wiring = withoutComments(workflow.yaml);
      expect(wiring).not.toMatch(/^\s*schedule:/m);
    }
  });

  it("keeps every executable provider workflow free of active recurrence", () => {
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    for (const name of readdirSync(workflowDirectory).filter((entry) => /\.ya?ml$/.test(entry))) {
      const yaml = read(`.github/workflows/${name}`);
      const wiring = withoutComments(yaml);
      // Be conservative: a provider literal is enough to classify a workflow,
      // even when it delegates execution to a wrapper. Entry-point patterns
      // cover workflows that select the provider through a CLI argument.
      const invokesOrchestrator = isProviderWorkflow(wiring);
      if (!invokesOrchestrator) continue;
      expect(wiring, name).not.toMatch(/^\s*schedule:/m);
    }
  });

  it("recognizes provider workflows across supported invocation spellings", () => {
    expect(isProviderWorkflow("env:\n  AGENT_PROVIDER: claude\nrun: ./scripts/invoke-provider.sh")).toBe(true);
    expect(isProviderWorkflow("run: node ./src/main.ts --dry-run")).toBe(true);
    expect(isProviderWorkflow("run: npm --silent run --silent trigger")).toBe(true);
    expect(isProviderWorkflow("run: npm test\n# AGENT_PROVIDER: codex")).toBe(false);
  });

  it("use separate concurrency groups, so one provider cannot block the other", () => {
    const groups = WORKFLOWS.map((workflow) => /group: (\S+)/.exec(workflow.yaml)?.[1]);
    expect(new Set(groups).size).toBe(WORKFLOWS.length);
  });
});

describe("consumer scheduling guidance", () => {
  const guide = read("docs/scheduling.md");

  it("makes recurrence optional and consumer-owned without restoring the former policy", () => {
    expect(guide).toMatch(/recurring execution is optional and disabled/i);
    expect(guide).toContain("Illustrative example only");
  });

  it("documents UTC, best-effort delivery, queueing, disabling, allowance, and rotation", () => {
    expect(guide).toMatch(/cron is\s+UTC/i);
    expect(guide).toMatch(/best[- ]effort/i);
    expect(guide).toMatch(/queue/i);
    expect(guide).toMatch(/cancel/i);
    expect(guide).toMatch(/disable recurrence|remove .*schedule/i);
    expect(guide).toMatch(/allowance|subscription consumption/i);
    expect(guide).toMatch(/rotation|expire/i);
  });
});

describe("classify-outcome action", () => {
  const yaml = read(CLASSIFY_ACTION);

  it("handles every exit code the application can return, plus a fallback", () => {
    const arms = new Set([...yaml.matchAll(/^ {10}(\d+|\*)\)$/gm)].map((match) => match[1]!));
    for (const code of new Set(Object.values(ExitCode))) {
      expect(arms).toContain(String(code));
    }
    expect(arms).toContain("*");
  });

  it("passes a usage limit as a warning and fails every other non-zero outcome", () => {
    const armFor = (code: number) =>
      yaml.slice(yaml.indexOf(`          ${code})`), yaml.indexOf(";;", yaml.indexOf(`          ${code})`)));

    expect(armFor(ExitCode.SUCCESS)).toContain("::notice");
    expect(armFor(ExitCode.SUCCESS)).not.toContain("exit 1");
    expect(armFor(ExitCode.USAGE_LIMIT_REACHED)).toContain("::warning");
    expect(armFor(ExitCode.USAGE_LIMIT_REACHED)).not.toContain("exit 1");
    expect(armFor(ExitCode.USAGE_LIMIT_REACHED)).toContain("no completed response was observed");
    expect(armFor(ExitCode.USAGE_LIMIT_REACHED)).not.toContain("no allowance was consumed");

    for (const code of [
      ExitCode.CONFIG_ERROR,
      ExitCode.AUTH_FAILURE,
      ExitCode.PROVIDER_UNAVAILABLE,
      ExitCode.TIMEOUT,
      ExitCode.TRANSIENT_FAILURE,
      ExitCode.UNKNOWN_FAILURE,
    ]) {
      expect(armFor(code)).toContain("::error");
      expect(armFor(code)).toContain("exit 1");
    }
  });

  it("treats a missing exit code as a failure rather than a pass", () => {
    expect(yaml).toContain('case "${CODE:-1}" in');
  });

  it("takes no secret and reads its inputs from the environment", () => {
    expect(yaml).not.toContain("secrets.");
    expect(yaml).toMatch(/CODE: \$\{\{ inputs\.exit-code \}\}/);
    const script = /run: \|\n((?: {8}.*\n)+)/.exec(yaml)?.[1] ?? "";
    expect(script).not.toContain("${{");
  });
});

describe("CI workflow", () => {
  const yaml = read(".github/workflows/ci.yml");

  it("has no access to any provider credential, so fork pull requests are safe", () => {
    expect(yaml).not.toContain("secrets.");
    for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      expect(yaml).not.toContain(name);
    }
  });
});

/** Drops whole-line comments, so documentation cannot trip a wiring assertion. */
function withoutComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** Conservative textual inventory of workflows capable of provider execution. */
function isProviderWorkflow(wiring: string): boolean {
  const providerLiteral = /^\s*AGENT_PROVIDER:\s*["']?(?:claude|codex)["']?\s*(?:#.*)?$/m;
  const nodeEntryPoint = /\bnode(?:\s+--?[^\s]+)*\s+(?:\.\/)?src\/main\.ts\b/;
  const npmScript = /\bnpm(?:\s+--?[^\s]+)*\s+run(?:\s+--?[^\s]+)*\s+trigger\b/;
  return providerLiteral.test(wiring) || nodeEntryPoint.test(wiring) || npmScript.test(wiring);
}
