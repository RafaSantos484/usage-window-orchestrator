# ADR 0001 — Minimal provider-neutral architecture

- **Status:** Accepted
- **Date:** 2026-09-11
- **Context:** First release of a new repository with one concrete provider.

## Decision

Use GitHub Actions for scheduling, manual dispatch, secrets, job timeout, and
overlap control. Keep the application small and provider-neutral at one proven
boundary:

```text
cron / manual dispatch
          |
          v
GitHub Actions -> src/main.ts -> UsageWindowOrchestrator -> AgentProvider
                                                        |
                                                        +-> ClaudeCodeProvider
```

`AgentProvider` is the only domain extension point. The orchestrator accepts a
normalized request, invokes the provider, applies the retry policy, and returns
a normalized result. Claude command construction and output classification stay
inside `src/providers/claude/`.

The composition root selects the provider directly. Adding a real provider
requires a new adapter, a construction branch in `src/main.ts`, workflow
runtime/secret wiring, and focused adapter tests. It does not require changes
to orchestration or status policy.

## Boundaries

| Area | Responsibility |
| --- | --- |
| `src/core/invocation.ts` | Provider-neutral request/result types, statuses, exit codes, and status policy. |
| `src/core/orchestrator.ts` | One invocation, timeout backstop, bounded retry, and result construction. |
| `src/core/provider.ts` | Minimal `AgentProvider` contract. |
| `src/core/retry.ts` | Retry decision and exponential backoff. |
| `src/core/logging.ts` | Logger contract and secret redaction. |
| `src/providers/claude/` | Claude CLI arguments, token validation, process isolation, and native-output classification. |
| `src/adapters/` | Child-process execution, JSON logging, GitHub summary, and fallback error output. |
| `src/config.ts` / `src/main.ts` | Configuration validation and composition. |

The core has no imports from `node:child_process`, the filesystem, GitHub, or
Claude. Dependencies are plain constructor arguments and function parameters;
there is no dependency-injection framework, service locator, or inheritance
hierarchy.

## Operational decisions

### Scheduling and overlap

The workflow has one daily UTC cron entry and supports `workflow_dispatch`.
GitHub Actions `concurrency` uses `cancel-in-progress: false`, so a second run
waits instead of running simultaneously or cancelling an invocation that may
already have consumed allowance.

This release does not persist cross-run state and does not suppress sequential
manual runs. A second manual dispatch after the first finishes is an explicit
new invocation. Keeping one cron entry avoids accidental duplicate schedules.

### Retry policy

Only `TRANSIENT_FAILURE` is retryable. Authentication failures, usage limits,
timeouts, provider-unavailable failures, and unknown or ambiguous outcomes are
not retried because repeating them may spend allowance twice. The Claude
adapter uses `TRANSIENT_FAILURE` only for failures with clear pre-connection
evidence; ambiguous network and upstream failures become `UNKNOWN_FAILURE`.

### Usage-limit outcome

`USAGE_LIMIT_REACHED` is a neutral operational result with exit code `10`. It
passes the workflow with a warning because it is an expected subscription state,
not an application defect.

## Alternatives considered

### Put the invocation entirely in YAML

Rejected. Provider output parsing, retry decisions, redaction, and result
construction would be difficult to test and would leak provider details into
the workflow.

### Use a database or cache-backed execution ledger

Rejected for this release. Cross-run duplicate suppression needs mutable,
authoritative state. GitHub Actions cache provides immutable snapshots and does
not make that guarantee. Adding a state service would be disproportionate to a
single-user daily job, so the product guarantee is limited to overlap control.

### Add a second provider framework now

Rejected. The small provider interface and direct composition branch provide a
credible extension path. Additional capabilities or registration machinery
should be added only when a real second provider demonstrates a need.

### Use a serverless function or container scheduler

Rejected. It would add deployment, secret-management, and infrastructure costs
for a short daily CLI invocation that GitHub Actions already hosts.

## Security consequences

- Only `CLAUDE_CODE_OAUTH_TOKEN` is accepted; `ANTHROPIC_API_KEY` is never
  forwarded, and API-key-shaped values are rejected.
- The Claude child receives an allowlisted environment plus isolated temporary
  home, temp, and working directories.
- The process runs without a shell, captures bounded output, and terminates its
  process group on abort.
- Logs, diagnostics, summaries, and fallback errors are redacted.
- The workflow has read-only repository permissions, no pull-request trigger,
  disabled checkout credentials, immutable first-party Action pins, and a
  bounded job timeout.

## Limitations

Provider quota-window state is not observable. The application reports the
invocation outcome, not whether a provider window started or reset. Cron timing
is best effort. The pinned Claude CLI's output contract and the npm registry
remain external dependencies that must be reviewed when upgraded.
