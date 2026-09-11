# usage-window-orchestrator

Issues **one minimal, authenticated invocation** against an AI coding agent
subscription on a schedule and reports the invocation outcome. It does not
claim to observe or control the provider's usage-window state.

Claude is the only provider implemented in this release. Adding another agent
does not require changes to `src/core/`: add an adapter, add its construction
branch in the composition root, and wire its runtime and secret into the workflow — see
[docs/adding-a-provider.md](docs/adding-a-provider.md).

```
                  cron ─┐
                        ├─► GitHub Actions ─► src/main.ts ─► UsageWindowOrchestrator
        manual dispatch ┘                                            │
                                                        AgentProvider (port)
                                                                     │
                                                          ClaudeCodeProvider
                                                        (claude -p --output-format json)
```

---

## What this is, and what it is not

**It is:** a scheduler that spends a few tokens of *your own* subscription
allowance at a time you choose, through the officially supported Claude Code
headless mode, authenticated with your own subscription token.

**It is not, and will not become:**

| Non-goal | Why |
| --- | --- |
| A way around usage limits | It consumes allowance normally. It cannot and does not raise any limit. |
| Browser automation | No Playwright, no Selenium, no cookies, no reused web sessions. |
| A private-API client | Only the documented CLI is used. |
| A window-reset guarantee | Anthropic does not document window state as something you can observe. This tool reports *what it did*, never what a quota did. See [Known limitations](#known-limitations). |
| A metered-API tool | `ANTHROPIC_API_KEY` is never read or forwarded. A subscription trigger must not silently become a per-token bill. |

### Terminology

The word **ping** is avoided on purpose: a ping is a *non-consuming* liveness
probe, and this operation deliberately consumes allowance. We say **invocation**.
Full vocabulary and rationale: [ADR 0001](docs/adr/0001-architecture.md#2-terminology).

---

## Quick start

1. **Generate a subscription token** on a machine where you are logged into
   Claude Code:

   ```bash
   claude setup-token
   ```

   This is the officially supported long-lived subscription credential for
   automation. It bills against your Claude subscription, not the API.

2. **Store it** as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN`:
   *Settings → Secrets and variables → Actions → New repository secret.*

3. **Dry-run the workflow** — *Actions → Usage window trigger → Run workflow →
   `dry_run: true`*. This validates non-secret configuration, provider
   selection, and orchestration wiring without contacting Claude or consuming
   allowance. It does not require the token or install the Claude CLI; it
   cannot verify that the token is present, current, or accepted. Perform a
   real manual invocation for end-to-end authentication.

4. **Run it for real** with `dry_run: false`, then check the job summary.

5. **Adjust the schedule** in
   [`.github/workflows/usage-window-trigger.yml`](.github/workflows/usage-window-trigger.yml)
   (it is `17 */2 * * *` UTC by default — see [Scheduling](#scheduling)).

---

## Configuration

All settings are environment variables. Every non-secret setting has a safe
default; the provider credential, `CLAUDE_CODE_OAUTH_TOKEN`, is required for
real invocations but not for dry runs.
Application configuration is validated at startup before provider invocation,
and **all** detected application-configuration problems are reported at once.
The timeout and attempt settings must also fit within the 8-minute application
budget, leaving the 10-minute GitHub Actions job time for setup and reporting.

| Variable | Default | Notes |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | **Required for real invocations; not required for dry runs.** The subscription token. Secret. |
| `AGENT_PROVIDER` | `claude` | The provider id supported by the composition root. |
| `AGENT_PROMPT` | `Reply with the single word: ok` | 1–500 chars. The cap is deliberate: this is meant to stay minimal. |
| `AGENT_MODEL` | *(provider default)* | e.g. `haiku`. Prefer the cheapest model that satisfies you — see below. |
| `AGENT_TIMEOUT_SECONDS` | `120` | 5–600. |
| `AGENT_MAX_ATTEMPTS` | `2` | 1–3. Only transient failures are ever retried. |
| `AGENT_DRY_RUN` | `false` | Validate without calling the provider. |
| `AGENT_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `AGENT_TRIGGER_SOURCE` | `manual` | `scheduled` \| `manual`. Set by the workflow. |
| `AGENT_CLAUDE_BIN` | `claude` | Path to the CLI, if it is not on `PATH`. |

In GitHub Actions, set the non-secret ones as **repository variables**
(`vars.*`) — the workflow already reads them.

**On `AGENT_MODEL`:** a smaller model consumes less allowance per invocation,
which is what you want here. `haiku` is a good choice. It is left unset by
default so the CLI's own default applies and nothing breaks if model aliases
change.

Command-line equivalents for local use: `--dry-run`, `--provider <id>`,
`--help`.

---

## Scheduling

```yaml
on:
  schedule:
    - cron: "17 */2 * * *"  # minute 17 UTC, every 2 hours
```

**GitHub cron is always UTC.** There is no timezone setting, and it does not
observe daylight saving time. Convert your local target time yourself:

| You want | Your timezone | UTC cron |
| --- | --- | --- |
| 08:45 | UTC+0 (winter UK) | `45 8 * * *` |
| 08:45 | UTC+1 (CEST / BST) | `45 7 * * *` |
| 08:45 | UTC−3 (BRT) | `45 11 * * *` |
| 08:45 | UTC−5 (EST) | `45 13 * * *` |

If your region uses DST and you care about the local hour year-round, either
accept the one-hour drift or change the cron expression seasonally.

**Scheduled runs are best-effort.** GitHub queues them and routinely delivers
several minutes late — occasionally much later under load, and scheduled
workflows are disabled entirely after 60 days without repository activity.
Nothing here assumes precise delivery: GitHub's concurrency guard only prevents
overlap, so lateness does not change the application's decision.
The default minute (`17`) avoids the top of the hour, which is the most
congested slot.

The `minute` is why the schedule is worth setting **earlier than you need**.
Pick a time comfortably before your working session.

---

## Running it manually

**From GitHub:** *Actions → Usage window trigger → Run workflow.* Inputs:
`provider`, `dry_run`, `model`, `log_level`.

Dry run checks non-secret configuration, provider selection, warns when
`ANTHROPIC_API_KEY` is present, and validates orchestration wiring. It does not
require the token, install the Claude CLI, or contact Claude; it cannot detect
a missing, malformed, expired, or revoked subscription token. A real manual run
is required to validate authentication end to end.

Because `concurrency` queues rather than cancels, a manual run started while a
scheduled one is in flight waits for it to finish. It then runs normally: this
release prevents overlap, but does not suppress sequential manual runs.

**Locally:**

```bash
npm ci

npm run trigger -- --dry-run    # no token or provider call required

export CLAUDE_CODE_OAUTH_TOKEN='…'
npm run trigger                  # real invocation
```

Requires a POSIX environment, Node 24 (Node ≥ 22.18 works; the sources run
directly via type stripping — there is no build step), and the Claude Code CLI
on `PATH`. The production workflow uses Linux; Windows local execution is not
supported.

---

## Reading the results

The program keeps its two output channels separate:

- **stdout** — one JSON result document. `npm run trigger > result.json` gives
  you clean JSON.
- **stderr** — newline-delimited structured logs.

```json
{
  "providerId": "claude",
  "invocationId": "879d8409-…",
  "triggerSource": "scheduled",
  "startedAt": "2026-09-11T05:19:02.146Z",
  "durationMs": 2841,
  "attempts": 1,
  "retried": false,
  "status": "success",
  "severity": "ok",
  "exitCode": 0,
  "diagnostic": { "code": "ok", "summary": "Claude accepted the minimal invocation…" },
  "metadata": { "numTurns": 1, "inputTokens": 11, "outputTokens": 2, "responseChars": 2 }
}
```

In GitHub Actions the same information is rendered into the **job summary**, and
`status`, `severity`, `exit_code` and `diagnostic_code` are published as step
outputs.

**What is never in any of it:** the token, the prompt text, the response text,
the session id, or any other environment variable. Everything printed passes
through redaction first; `metadata` carries `responseChars` rather than the
response so you can confirm a real answer arrived without logging its content.

`metadata` is **provider-reported** data. Provider quota-window state is not
observable through this tool.

---

## Exit codes and outcomes

| Code | Status | Job result | Meaning |
| --- | --- | --- | --- |
| `0` | `success` | ✅ pass | Claude answered. Allowance was consumed. |
| `0` | `skipped` | ✅ pass | Dry run; no provider call was made. |
| `10` | `usage_limit_reached` | ⚠️ pass **with a warning** | The limit is already reached. |
| `20` | *(config)* | ❌ fail | Invalid configuration, or a missing/refused secret. |
| `21` | `auth_failure` | ❌ fail | Token rejected, expired, or revoked. |
| `22` | `provider_unavailable` | ❌ fail | The CLI could not be executed. |
| `30` | `timeout` | ❌ fail | No answer within the budget. |
| `31` | `transient_failure` | ❌ fail | A provider proved the failure occurred before acceptance; bounded retries were exhausted. Claude uses this for pre-connection DNS/refusal failures. |
| `40` | `unknown_failure` | ❌ fail | Unrecognised or ambiguous outcome, including Claude network/upstream failures that may have reached the model. |

**Why a usage limit passes with a warning rather than failing:** it is an
expected *operational* outcome, not a defect — it usually means the subscription
is already in use, which is the state the schedule exists to produce. Marking it
red would train you to ignore red runs. It still gets its own exit code and a
visible annotation, so if you prefer it to fail, change one `case` arm in the
workflow's *Classify outcome* step; no application code is involved.

---

## Overlap protection

Two runs cannot execute at the same time. GitHub Actions handles this with:

```yaml
concurrency:
  group: usage-window-trigger-<provider>
  cancel-in-progress: false
```

A second run queues instead of cancelling the first. Cancelling
mid-invocation could spend allowance without producing a complete result.

This protects overlap only. A second manual dispatch after the first run has
finished is an explicit new invocation and may consume allowance. Keep one cron
entry unless you deliberately want multiple scheduled invocations.

### Validating overlap protection

Workflow-level concurrency is a platform behaviour, so it is deliberately not
unit-tested — there is no application code to test. To verify it manually,
launch two workflow runs close together and confirm that the second is pending
until the first completes. This check uses real workflow runs and may consume
allowance; a temporary reviewed delay on a test branch can make the queue easier
to observe without calling Claude.

The second run should show as *pending* in the Actions UI until the first
completes. It is queued, not running concurrently, and not cancelled.

---

## Failure modes and troubleshooting

| Symptom | Exit | Cause and fix |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN is not set` | 20 | The secret is missing or misnamed. Check *Settings → Secrets → Actions*. Note that secrets are unavailable to workflows triggered from forks — by design. |
| `…appears to be a usage-billed API key` | 20 | You stored an `sk-ant-api…` key. Run `claude setup-token` to get a subscription token instead. |
| `auth_failed` | 21 | Token expired, revoked, or the subscription changed. Regenerate and update the secret. |
| `credit_balance_low` | 21 | Claude is billing against API credits, not your subscription — the wrong credential is in play. |
| `cli_not_executable` / `cli_not_found` / `isolation_setup_failed` | 22 | The CLI could not be executed, or the temporary Claude runtime could not be created. Check the runner filesystem and `AGENT_CLAUDE_BIN`. |
| `cli_timeout` | 30 | Raise `AGENT_TIMEOUT_SECONDS`. Not retried on purpose: the call may already have reached the model. |
| `preconnect_network_failure` | 31 | DNS or connection setup failed before acceptance; it is retried conservatively. |
| `ambiguous_upstream` / `ambiguous_network` | 40 | The request may have reached Claude, so it is not retried. |
| `unclassified` | 40 | The CLI said something we do not recognise — often a new CLI version. The redacted excerpt is in the diagnostic; add a signal to `src/providers/claude/classify.ts`. |
| Scheduled runs stopped | — | GitHub disables cron workflows after 60 days of repository inactivity. Re-enable in the Actions tab. |
| Run was minutes late | — | Expected. GitHub cron is best-effort. |

---

## Security

**Credential handling**

- The token lives only in GitHub Actions secrets. Nothing credential-shaped is
  committed — `.gitignore` covers `.claude/`, `.credentials.json` and `.env*`.
- Only `CLAUDE_CODE_OAUTH_TOKEN` is accepted. `ANTHROPIC_API_KEY` is never read
  and never forwarded; if it is present in the environment the run logs a
  warning saying it was ignored. A token starting `sk-ant-api` is rejected
  outright at startup.
- The CLI child process receives an **allowlisted** environment plus the token —
  never a copy of the job's environment, so no other CI secret is reachable
  from it. Each invocation also gets isolated temporary `HOME`, temp and
  working directories, preventing repository- or user-level Claude settings
  from changing the request.
- Every log line, diagnostic and job summary passes through `redact()`, which
  scrubs both known secret values and credential-shaped strings (API keys, JWTs,
  `Authorization:` values).

**Pipeline**

- `permissions: contents: read` — the workflow writes nothing back.
- The Claude Code CLI is installed at the reviewed exact version declared in
  the workflow; upgrades require a reviewed change and adapter validation. It
  is intentionally installed separately from this application's lockfile: the
  official CLI is a provider runtime, not an application library, and its
  install lifecycle is owned by the provider. This accepts registry-integrity
  risk for the exact reviewed version in exchange for keeping the application
  dependency graph and deployment lifecycle separate.
- No `pull_request` trigger on the workflow that holds the secret, and
  `persist-credentials: false` on checkout, so forks cannot reach it.
- The CI workflow that runs the tests has no secrets at all, so fork PRs can run
  it safely.
- `timeout-minutes: 10` on the job, plus an 8-minute validated application
  budget, independent attempt timeouts and a backstop above them.
- Workflow inputs are passed to steps through `env:`, never interpolated into
  `run:` scripts.
- Zero runtime dependencies. The production workflow needs no application
  dependency-install or build step; `npm ci` installs the development
  toolchain only when working locally or in CI.
- Only first-party `actions/*` actions are used, pinned to reviewed immutable
  commit SHAs with release tags kept as comments. Review the upstream tag and
  update the SHA deliberately when upgrading. No third-party action is used.

### Rotating and revoking the token

**Rotate** (do this periodically, and whenever someone with repository access
leaves):

1. `claude setup-token` on your machine to mint a fresh token.
2. Update the `CLAUDE_CODE_OAUTH_TOKEN` repository secret.
3. Run the workflow manually with `dry_run: false` to confirm.
4. Revoke the old token.

**Revoke** (do this immediately if a token may have leaked): remove it from your
Claude account's connected applications / API-and-token settings, then delete
the repository secret. The next run will fail fast with exit code 21 rather than
doing anything unexpected. Check the repository's Actions logs for the runs that
used the exposed token; because logs are redacted, the token value should not
appear in them, but treat any leak as real and rotate anyway.

---

## Development

```bash
npm ci
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run check        # both
```

**Tests never contact Claude and never need a real secret.** The provider port
and the process runner are substituted with fakes, and the clock and sleep are
injected, so every test is deterministic and offline.

| File | Covers |
| --- | --- |
| `tests/orchestrator.test.ts` | The use case against a stub provider: success, retry-then-succeed, budget exhaustion, no-retry for every non-transient status, dry run, contract-violating adapter, abort backstop. |
| `tests/classify.test.ts` | Claude output parsing and classification against representative CLI output. |
| `tests/claude-provider.test.ts` | Argument construction, token refusal, environment allowlist, redaction. |
| `tests/retry.test.ts` | Retry decisions and the status policy table. |
| `tests/config.test.ts` | Validation, ranges, multi-problem reporting, and CLI overrides. |
| `tests/observability.test.ts` | Redaction, log structure/filtering, secret-free summaries. |
| `tests/process-runner.test.ts` | Child-process isolation: environment allowlist, no shell, prompt termination on abort with no orphaned processes. |

### Layout

```
src/
  core/            # no I/O, no provider knowledge — the hexagon
    invocation.ts    statuses, request/result, the status policy table
    provider.ts      minimal AgentProvider port
    orchestrator.ts  the single use case
    retry.ts         retry decisions
    logging.ts       Logger port + redaction
  providers/claude/  the only concrete adapter
  adapters/          process runner, JSON logger, GitHub summary,
                     unhandled-error fallback
  config.ts          validation
  main.ts            composition root: argv, env, exit codes
```

Architecture rationale and rejected alternatives:
[ADR 0001](docs/adr/0001-architecture.md).
Adding an agent: [docs/adding-a-provider.md](docs/adding-a-provider.md).

---

## Known limitations

- **Window state is not observable.** Anthropic does not document usage-window
  or reset semantics as something a client can read. This tool therefore never
  claims to have started or reset a window — it reports only that a minimal
  authenticated invocation was issued and accepted. Treat the timing benefit as
  a reasonable expectation, not a guarantee.
- **Provider behaviour can change.** Quota rules, CLI flags and error text are
  Anthropic's to change. Structured JSON output is preferred, but the fallback
  text classification in `src/providers/claude/classify.ts` may need updating
  after a CLI release. An unrecognised message becomes `unknown_failure`, which
  fails safe (no retry) rather than guessing.
- **Cron is best-effort.** Expect minutes of drift; schedule accordingly.
- **`total_cost_usd`** reported in metadata is the CLI's own figure. On a
  subscription it is an equivalence estimate, not an invoice line.
- **One account, one provider per run.** Multi-account fan-out is out of scope.
