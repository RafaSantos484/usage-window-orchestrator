# usage-window-orchestrator

Issues **one minimal, authenticated invocation** against an AI coding agent
subscription and reports the invocation outcome. It can be called manually or
by a consumer-enabled scheduler; the canonical repository enables no recurring
provider invocation. It does not claim to observe or control the provider's
usage-window state.

Claude and Codex are implemented. Adding a third agent does not require
changes to `src/core/`: add an adapter, add its entry to the provider catalog,
and wire its runtime and secret into a workflow — see
[docs/adding-a-provider.md](docs/adding-a-provider.md).

```
 consumer schedule (optional) ─┐
                               ├─► GitHub Actions ─► src/main.ts ─► UsageWindowOrchestrator
               manual dispatch ┘                                            │
                                                        AgentProvider (port)
                                                            │           │
                                              ClaudeCodeProvider   CodexCliProvider
                                        (claude -p --output-format   (codex exec
                                                          json)          --json)
```

## Provider support matrix

| | **Claude** | **Codex** |
| --- | --- | --- |
| Provider id | `claude` | `codex` |
| CLI | `@anthropic-ai/claude-code` | `@openai/codex` |
| Reviewed version | `2.1.268` | `0.154.0` |
| Invocation | `claude -p … --output-format json --max-turns 1` | `codex exec --json …` |
| Credential secret | `CLAUDE_CODE_OAUTH_TOKEN` | `CODEX_ACCESS_TOKEN` |
| How you get it | `claude setup-token` | ChatGPT admin console |
| Bills against | Your Claude subscription | Your ChatGPT **workspace** plan |
| Plans supported | Pro / Max | **Business / Enterprise only** |
| Credential expiry | Long-lived | **90 days maximum** |
| Refused credential | `ANTHROPIC_API_KEY` | `CODEX_API_KEY`, `OPENAI_API_KEY` |
| Workflow | `usage-window-trigger.yml` | `usage-window-trigger-codex.yml` |
| Recurring schedule | Disabled by default; consumer-owned | Disabled by default; consumer-owned |
| Model override | `vars.AGENT_MODEL` | `vars.AGENT_CODEX_MODEL` |
| Turn bound | `--max-turns 1` | No turn flag exists; identified execution tools are disabled, the read-only sandbox is primary, and strict config rejects missing hardening keys |

**Do not assume the two are equivalent.** The differences that will actually
bite you: Codex needs a Business/Enterprise workspace, its token expires within
90 days, its model aliases are unrelated to Claude's, and its "usage limit"
wording is not something we can always distinguish from a plain rate limit.
Details in [Provider differences](#provider-differences-that-matter). A
Codex plan-limit result requires the exact structured `UsageLimitExceeded`
discriminator; echoed or free-form limit prose is not trusted.

---

## What this is, and what it is not

**It is:** an invocation orchestrator that spends a few tokens of *your own*
subscription allowance when you invoke it, through each provider's officially
supported headless mode, authenticated with your own subscription credential.
Optional recurrence is a consumer-owned deployment policy.

**It is not, and will not become:**

| Non-goal | Why |
| --- | --- |
| A way around usage limits | It consumes allowance normally. It cannot and does not raise any limit. |
| Browser automation | No Playwright, no Selenium, no cookies, no reused web sessions. |
| A private-API client | Only the documented CLI is used. |
| A window-reset guarantee | Neither Anthropic nor OpenAI documents window state as something you can observe. This tool reports *what it did*, never what a quota did. See [Known limitations](#known-limitations). |
| A metered-API tool | `ANTHROPIC_API_KEY`, `CODEX_API_KEY` and `OPENAI_API_KEY` are never used for authentication or forwarded to a provider child process. Their values may be read only for redaction and presence warnings. A subscription trigger must not silently become a per-token bill. See [Authentication and billing](#authentication-and-billing). |

### Terminology

The word **ping** is avoided on purpose: a ping is a *non-consuming* liveness
probe, and this operation deliberately consumes allowance. We say **invocation**.
Full vocabulary and rationale: [ADR 0001](docs/adr/0001-architecture.md).

---

## Quick start

Each provider is independent: set up either, or both. You do not need a
credential for the provider you are not using.

Fork or copy the project into a repository you control, enable GitHub Actions,
and protect its default branch. Configure credentials and any optional
recurrence only in that consumer repository; the public canonical repository
does not operate provider invocations for you.

Before storing a credential, create the provider-specific GitHub Environments
`usage-window-claude` and `usage-window-codex` under *Settings → Environments*.
For each environment, add a deployment branch rule allowing only the protected
default branch, then store that provider's credential as an environment secret:
`CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_ACCESS_TOKEN`. This Environment policy is
configured in repository settings and is the enforcement boundary for manual
secret-bearing dispatches; the workflow guard and default-branch checkout are
defense in depth. The repository's text tests cannot verify the Environment
policy, so confirm it manually during setup.

### Claude

1. **Generate a subscription token** on a machine where you are logged into
   Claude Code:

   ```bash
   claude setup-token
   ```

   This is the officially supported long-lived subscription credential for
   automation. It bills against your Claude subscription, not the API.

2. **Store it** as an environment secret named `CLAUDE_CODE_OAUTH_TOKEN` in
   `usage-window-claude`: *Settings → Environments → usage-window-claude →
   Environment secrets → Add secret.*

3. **Dry-run the workflow** — *Actions → Provider invocation (Claude) → Run
   workflow → `dry_run: true`*. This validates non-secret configuration,
   provider selection, and orchestration wiring without contacting Claude or
   consuming allowance. It does not require the token or install the Claude
   CLI; it cannot verify that the token is present, current, or accepted.
   Perform a real manual invocation for end-to-end authentication.

4. **Run it for real** with `dry_run: false`, then check the job summary.

5. **Optionally enable recurrence** in your own repository only after the
   manual checks. Choose your own policy; see [Scheduling](#scheduling).

### Codex

**Prerequisite: a ChatGPT Business or Enterprise workspace, and permission to
create access tokens in it.** There is no supported unattended subscription
credential on Plus, Pro, Go or Free — see
[Authentication and billing](#authentication-and-billing) for why we do not
substitute an API key.

1. **Create a Codex access token** in the ChatGPT admin console:
   <https://chatgpt.com/admin/access-tokens>. Give it a descriptive name,
   select the **Codex** scope only, and pick the shortest expiry you are
   willing to rotate (1–90 days). **Copy it immediately** — it cannot be read
   again, only revoked.

2. **Store it** as an environment secret named `CODEX_ACCESS_TOKEN` in
   `usage-window-codex`: *Settings → Environments → usage-window-codex →
   Environment secrets → Add secret.*

3. **Dry-run the workflow** — *Actions → Provider invocation (Codex) → Run
   workflow → `dry_run: true`*. Same guarantees and same blind spots as the
   Claude dry run: it does not validate or forward the token, install the
   Codex CLI, or contact OpenAI. The entry point may read configured secret
   values solely to arm output redaction; it does not report credential
   presence during a dry run.

4. **Run it for real** with `dry_run: false`, then check the job summary. A
   `success` confirms the token is accepted; see
   [Troubleshooting](#failure-modes-and-troubleshooting) if it is not.

5. **Put the token's expiry in your calendar.** Codex access tokens expire
   within 90 days. After expiry, runs are expected to fail with exit code 21
   when the CLI reports recognized authentication evidence; an unrecognized
   response fails closed with exit code 40. See [Rotating and revoking credentials](#rotating-and-revoking-credentials).

6. **Optionally enable recurrence** in your own repository only after the
   manual checks. Choose your own policy; see [Scheduling](#scheduling).

---

## Authentication and billing

This project exists to spend *subscription allowance* at a chosen time. A
credential that bills per token through a metered API account is therefore not
an acceptable substitute for one that draws on a plan, even when it would work.
Both adapters enforce that.

| | Claude | Codex |
| --- | --- | --- |
| Accepted credential | `CLAUDE_CODE_OAUTH_TOKEN` (subscription OAuth token) | `CODEX_ACCESS_TOKEN` (Codex access token) |
| Draws on | Your Claude subscription | Your ChatGPT workspace plan allowance |
| Rejected billing credential | `ANTHROPIC_API_KEY` | `CODEX_API_KEY`, `OPENAI_API_KEY` |
| Refused at startup | Values starting `sk-ant-api` | Values starting `sk-` |

**Codex specifics.** A Codex access token is a ChatGPT *workspace* credential
scoped to Codex, documented for exactly this purpose: "trusted non-interactive
local workflows, including Codex CLI". `codex exec` reads it straight from
`CODEX_ACCESS_TOKEN` with no login step. The application does not write
authentication state itself; for the pinned CLI, the ephemeral credential-store
override is intended to prevent persistent caching. Re-check that assumption
when upgrading the CLI. Usage is governed by ChatGPT workspace usage limits and
spend controls, which OpenAI documents as separate from OpenAI Platform API
billing.

**Why not an OpenAI API key?** Because `codex exec` with `CODEX_API_KEY` or
`OPENAI_API_KEY` bills through your OpenAI Platform account at standard API
rates — a different account and a different billing model. Making
`AGENT_PROVIDER=codex` mean "bill my Platform account" while
`AGENT_PROVIDER=claude` means "spend my subscription" would make the two
providers incomparable, and could hand you an invoice this automation never
promised. We do not offer it as an opt-in mode either; the reasoning is in
[ADR 0002](docs/adr/0002-codex-provider.md#1-authentication-and-billing).

**How fallback is prevented.** Four independent controls:

1. The adapter never uses `CODEX_API_KEY` or `OPENAI_API_KEY` for authentication;
   the application may inspect their presence and read their values only to arm
   redaction.
2. Neither reaches the child process — the environment is an allowlist, and
   both names are explicitly deleted from it.
3. `CODEX_ACCESS_TOKEN` is refused at startup if it starts with `sk-`.
4. `--config forced_login_method="chatgpt"` tells the CLI to accept only
   ChatGPT-workspace authentication.

If either key is merely present in the job environment, the run logs a
`config.api_key_ignored` warning and continues. It is not fatal, because it is
never forwarded — but you should know it is there.

**What we deliberately do not do:** copy `~/.codex/auth.json` between machines,
run `codex login --device-auth` (it is interactive), drive a browser, or use
`openai/codex-action` (its credential input is an API key, and it is not an
`actions/*` action). See
[ADR 0002](docs/adr/0002-codex-provider.md#1-authentication-and-billing).

---

## Configuration

All settings are environment variables. Every non-secret setting has a safe
default; the selected provider's credential is required for real invocations
but not for dry runs.
Application configuration is validated at startup before provider invocation,
and **all** detected application-configuration problems are reported at once.
The timeout and attempt settings must also fit within the 8-minute application
budget, leaving the 10-minute GitHub Actions job time for setup and reporting.

**Shared** — same meaning for every provider:

| Variable | Default | Notes |
| --- | --- | --- |
| `AGENT_PROVIDER` | `claude` | `claude` \| `codex`. |
| `AGENT_PROMPT` | `Reply with the single word: ok` | 1–500 chars. The cap is deliberate: this is meant to stay minimal. |
| `AGENT_MODEL` | *(provider default)* | Provider-specific alias — see below. |
| `AGENT_TIMEOUT_SECONDS` | `120` | 5–600. |
| `AGENT_MAX_ATTEMPTS` | `2` | 1–3. Only transient failures are ever retried. |
| `AGENT_DRY_RUN` | `false` | Validate without calling the provider. |
| `AGENT_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `AGENT_TRIGGER_SOURCE` | `manual` | `scheduled` \| `manual`. Set by the workflow. |

**Provider-specific** — native settings are kept native rather than merged into
one variable whose meaning would differ per provider:

| Variable | Provider | Default | Notes |
| --- | --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | claude | — | **Required for real invocations; not for dry runs.** Secret. |
| `AGENT_CLAUDE_BIN` | claude | `claude` | Path to the CLI, if it is not on `PATH`. |
| `CODEX_ACCESS_TOKEN` | codex | — | **Required for real invocations; not for dry runs.** Secret. |
| `AGENT_CODEX_BIN` | codex | `codex` | Path to the CLI, if it is not on `PATH`. |

In GitHub Actions, set the non-secret shared ones as **repository variables**
(`vars.AGENT_PROMPT`, `vars.AGENT_TIMEOUT_SECONDS`, `vars.AGENT_MAX_ATTEMPTS`)
— both workflows already read them. The model override is *per provider*:
`vars.AGENT_MODEL` for Claude, `vars.AGENT_CODEX_MODEL` for Codex, because a
Claude alias is meaningless to Codex and vice versa.

**On `AGENT_MODEL`:** a smaller model consumes less allowance per invocation,
which is what you want here. `haiku` is a good Claude choice. It is left unset
by default for both providers so each CLI's own default applies and nothing
breaks if model aliases change. **Codex model names are unrelated to Claude's**
— do not copy a value between the two variables.

Command-line equivalents for local use: `--dry-run`, `--provider <id>`,
`--help`.

---

## Scheduling

**Recurring provider invocation is disabled in the canonical repository.** The
two maintained workflows support manual dispatch only. The credential owner
chooses whether to add a schedule, which provider workflows to enable, and the
cron expression for each; the project does not select a recurrence interval or
provider offset.

The complete opt-in procedure is in
[Consumer-owned scheduling](docs/scheduling.md). It covers prerequisites,
provider selection, the exact activation point, an explicitly illustrative
cron example, UTC conversion, GitHub's best-effort delivery, concurrency and
queueing, allowance impact, monitoring, disabling, Codex token rotation, and
upstream upgrade handling.

The safe order is: configure the provider-specific Environment and secret, run
a dry run, run one real manual invocation to validate authentication, and only
then decide whether to enable recurrence. Enable only providers you use. Every
real scheduled invocation may consume subscription allowance, and success
proves only that an invocation completed—not that provider quota state changed.

One file per provider preserves deterministic selection and secret isolation
for both manual and consumer-enabled scheduled invocations. Scheduling remains
outside `src/core/` and the provider adapters. See
[ADR 0003](docs/adr/0003-consumer-owned-scheduling.md) for the ownership
boundary, alternatives, and migration from the former active schedules.

---

## Running it manually

**From GitHub:** you choose the provider by choosing the workflow —
*Actions → **Provider invocation (Claude)** or **Provider invocation
(Codex)** → Run workflow.* Both take the same inputs: `dry_run`, `model`,
`log_level`. There is no `provider` input, because the workflow already is the
provider. Configure each provider Environment to allow deployment only from the
protected default branch; that repository setting is the enforcement boundary
for manual secret-bearing dispatches. Secret-bearing runs requested from
another branch are also skipped by the workflow guard, and the workflow checks
out the protected default branch explicitly as defense in depth. Keep the
workflow files themselves under the repository's normal branch-protection and
review rules.

Dry run checks non-secret configuration and provider selection, and validates
orchestration wiring. It does not require the credential, install the provider
CLI, or contact the provider; it cannot detect a missing, malformed, expired,
or revoked credential. A real manual run is required to validate authentication
end to end.

Because `concurrency` queues rather than cancels, a manual run started while a
consumer-scheduled one *for the same provider* is in flight waits for it to
finish. It then runs normally: this release prevents overlap, but does not
suppress sequential manual runs. A Claude run and a Codex run do not queue
behind each other.

**Locally:**

```bash
npm ci

npm run trigger -- --dry-run                    # no credential or provider call
npm run trigger -- --dry-run --provider codex   # same, for Codex

export CLAUDE_CODE_OAUTH_TOKEN='…'
npm run trigger                                 # real Claude invocation

export CODEX_ACCESS_TOKEN='…'
npm run trigger -- --provider codex             # real Codex invocation
```

Requires a POSIX environment, Node 24 (Node ≥ 22.18 works; the sources run
directly via type stripping — there is no build step), and the selected
provider's CLI on `PATH` (`npm i -g @anthropic-ai/claude-code@2.1.268` or
`npm i -g @openai/codex@0.154.0` — use the reviewed versions, and see
[Security](#security) on why they are pinned). The production workflow uses
Linux; Windows local execution is not supported.

Note that a local Codex run does **not** use your interactive `codex login`
session: the adapter runs with an isolated, empty `CODEX_HOME` on purpose, so
you need `CODEX_ACCESS_TOKEN` set even on a machine where you are already
logged in.

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

A Codex result has the same shape with provider-reported fields of its own:

```json
{
  "providerId": "codex",
  "status": "success",
  "severity": "ok",
  "exitCode": 0,
  "diagnostic": { "code": "ok", "summary": "Codex accepted the minimal invocation and produced one response." },
  "metadata": {
    "numTurns": 1,
    "agentMessages": 1,
    "responseChars": 2,
    "inputTokens": 18,
    "cachedInputTokens": 0,
    "outputTokens": 2,
    "reasoningOutputTokens": 0,
    "cliLastEvent": "turn.completed"
  }
}
```

**For Codex, what is never in any of it:** the credential, the prompt text, the
response text, the session or thread id, or any other environment variable.
Everything printed passes through redaction first; `metadata` carries
`responseChars` rather than the response so you can confirm a real answer
arrived without logging its content. Claude's adapter may include a redacted,
bounded output excerpt for an unclassified failure, as documented below.

For Codex there is one extra rule. `codex exec --json` emits *item* events that
can carry command output, file contents or the full agent message. The
classifier never quotes any provider output. It reads only exact typed error
discriminants and allowlisted scalar messages for classification; diagnostics
contain fixed summaries plus bounded, known event-type metadata.

`metadata` is **provider-reported** data, and the two providers report
different fields — do not build anything that assumes a key exists. Provider
quota-window state is not observable through this tool, for either provider.

---

## Exit codes and outcomes

The exit codes are provider-neutral, and both providers map onto them:

| Code | Status | Job result | Meaning |
| --- | --- | --- | --- |
| `0` | `success` | ✅ pass | The provider completed according to its adapter's reviewed success contract. Allowance was consumed. |
| `0` | `skipped` | ✅ pass | Dry run; no provider call was made. |
| `10` | `usage_limit_reached` | ⚠️ pass **with a warning** | The limit is already reached. |
| `20` | *(config)* | ❌ fail | Invalid configuration, or a missing/refused secret. |
| `21` | `auth_failure` | ❌ fail | Credential rejected, expired, or revoked — or the wrong billing path. |
| `22` | `provider_unavailable` | ❌ fail | The CLI could not be executed. |
| `30` | `timeout` | ❌ fail | No answer within the budget. |
| `31` | `transient_failure` | ❌ fail | The provider proved the failure occurred before acceptance; bounded retries were exhausted. Claude can use this for trusted pre-connection DNS/refusal evidence; Codex 0.154.0 does not retry CLI-reported network prose. |
| `40` | `unknown_failure` | ❌ fail | Unrecognised or ambiguous outcome, including network/upstream failures that may have reached the model. |

**Only `transient_failure` is ever retried,** for either provider, because every
retry may spend allowance. Post-connection failures, timeouts, upstream 5xx,
malformed output and generic rate limits are all non-retryable on purpose.

**How Codex success is decided.** A zero exit code is not enough:
`codex exec --json` can emit `error`, `turn.failed` or future unknown events,
so the adapter requires exactly one clean `turn.completed` event as the actual
terminal known event, preceded by exactly one `turn.started` event and a valid
started/completed item lifecycle, exactly one non-empty agent response, no unknown events, no
malformed JSON lines, and exit code 0. Recognized non-authentication failure
evidence in stderr also disqualifies success as contradictory terminal evidence.
Plain-text startup noise is tolerated and counted, but a truncated or otherwise
malformed JSON line fails closed. The
converse case — a
completed turn with a non-zero exit — becomes `unknown_failure`
(`completed_turn_nonzero_exit`) rather than a retry, because the invocation had
probably already consumed allowance.

For Codex, non-JSON lines are tolerated and counted in `malformedOutputLines`
only before a terminal turn event; they are not reproduced in diagnostics.
Unstructured output after `turn.completed` or `turn.failed` fails closed as
`trailing_output`. A valid JSON object with an unknown or missing `type` is
different: it fails closed as `unknown_event_type`, even when the rest of the
stream contains a completed turn.

Authentication prose is a failure-only fallback: text such as `Unauthorized`
may produce `auth_failure`, but it is never retried and cannot produce a passing
or usage-limit result. If the CLI echoes that text from the prompt, the result
can be a conservative false positive; removing that possibility requires a
structured authentication discriminator.

**Provider-specific diagnostic codes.** The status vocabulary stays neutral;
provider detail lives in `diagnostic.code`:

| Codex `diagnostic.code` | Status | What it means |
| --- | --- | --- |
| `ok` | `success` | One clean turn produced one non-empty agent response and the process exited 0. |
| `usage_limit_reached` | `usage_limit_reached` | Exact structured `UsageLimitExceeded` evidence only; plan-limit prose is not trusted. |
| `auth_failed` | `auth_failure` | 401/403, `Unauthorized`, "Not logged in", invalid or expired token. |
| `api_billing_path_detected` | `auth_failure` | A Platform billing error (`insufficient_quota`) — an API key is in play, not a Codex access token. |
| `provider_rate_limited` | `unknown_failure` | A 429 or generic rate limit. **Not** claimed as a plan usage window. |
| `ambiguous_upstream` | `unknown_failure` | 5xx, `HttpConnectionFailed`, `InternalServerError`. |
| `ambiguous_stream` | `unknown_failure` | Stream ended or disconnected after the invocation began. |
| `invalid_request` | `unknown_failure` | `BadRequest`, `ContextWindowExceeded`, unknown model. Check `AGENT_CODEX_MODEL`. |
| `sandbox_error` | `unknown_failure` | Codex could not establish its read-only sandbox on the runner. |
| `completed_turn_nonzero_exit` | `unknown_failure` | A turn completed but the process failed. Not retried. |
| `completed_turn_without_response` | `unknown_failure` | A turn completed without exactly one non-empty agent response. |
| `invalid_event_sequence` | `unknown_failure` | Known JSONL events did not form exactly one ordered turn lifecycle. |
| `unexpected_turn_count` | `unknown_failure` | More than one turn completed; the minimal single-turn contract was not satisfied. |
| `unexpected_response_count` | `unknown_failure` | More than one agent response was reported for the completed turn. |
| `unknown_event_type` | `unknown_failure` | The CLI emitted an unknown or untyped JSONL event, so the outcome was not trusted. |
| `malformed_jsonl` | `unknown_failure` | A JSON-shaped or valid-but-non-object line could not be accepted as a protocol event. |
| `trailing_output` | `unknown_failure` | Unstructured output appeared after a terminal turn event, so the outcome was not trusted. |
| `conflicting_terminal_evidence` | `unknown_failure` | Completion/response and recognized failure evidence coexist; allowance consumption is ambiguous. |
| `incomplete_turn` | `unknown_failure` | Exit 0 with no completed turn. |
| `unclassified` | `unknown_failure` | Output we do not recognise — often a new CLI version. |
| `cli_not_executable` / `cli_not_found` | `provider_unavailable` | The `codex` binary could not be run. |
| `cli_timeout` | `timeout` | Killed on the deadline. |
| `output_truncated` | `unknown_failure` | Captured stdout or stderr exceeded the bound, so the complete outcome could not be verified. |
| `isolation_setup_failed` | `provider_unavailable` | The temporary Codex runtime could not be created. |

Claude's equivalents are in `src/providers/claude/classify.ts`; the shared ones
(`cli_timeout`, `cli_not_found`, `unclassified`, `isolation_setup_failed`) mean
the same thing for both.

**Why a usage limit passes with a warning rather than failing:** it is an
expected *operational* outcome, not a defect — it means the provider reported
that the subscription cannot currently complete the invocation. Marking it red
would train you to ignore red runs. It still gets its own exit code and a
visible annotation, so if you prefer it to fail, change one `case` arm in
[`.github/actions/classify-outcome/action.yml`](.github/actions/classify-outcome/action.yml)
— once, for both providers; no application code is involved.

---

## Overlap protection

Two runs **for the same provider** cannot execute at the same time. GitHub
Actions handles this per workflow:

```yaml
# usage-window-trigger.yml           # usage-window-trigger-codex.yml
concurrency:                         concurrency:
  group: usage-window-trigger-claude   group: usage-window-trigger-codex
  cancel-in-progress: false            cancel-in-progress: false
```

A second run queues instead of cancelling the first. Cancelling
mid-invocation could spend allowance without producing a complete result.

**The groups are separate on purpose.** Overlap protection is scoped per provider
by default, so a Codex run has no reason to wait for a Claude run. The unit being
protected is *one provider invocation*, which is exactly what a per-workflow
group expresses. If your organization wants Claude and Codex runs to be
mutually exclusive, give both workflows the same group name.

This protects overlap only. A second manual dispatch or queued scheduled run
after the first has finished is a new invocation and may consume allowance.
Concurrency does not deduplicate a consumer's recurring trigger policy.

### Validating overlap protection

Workflow-level concurrency and consumer-enabled cron delivery are platform
behaviours, so they are deliberately not unit-tested — there is no application
code to test.
[`tests/workflows.test.ts`](tests/workflows.test.ts) asserts the *declarations*
(no active upstream schedule, manual dispatch, a documented activation point,
distinct groups, `cancel-in-progress: false`, only the provider's own secret,
read-only permissions, pinned actions, and complete exit-code coverage), which
catches drift but does not parse YAML or prove that GitHub accepts and executes
a consumer's cron expression.

To verify the behaviour manually:

1. Dispatch the same provider's workflow twice in quick succession.
2. Confirm the second run shows as *pending* in the Actions UI until the first
   completes — queued, not concurrent, and not cancelled.
3. Dispatch Claude and Codex together and confirm they *do* run concurrently.

This check uses real workflow runs and may consume allowance; use
`dry_run: true` for both runs to observe the queue without calling a provider.

---

## Failure modes and troubleshooting

### Both providers

| Symptom | Exit | Cause and fix |
| --- | --- | --- |
| `AGENT_PROVIDER="…" is not a registered provider` | 20 | Only `claude` and `codex` exist. Check the spelling; the id is lower-cased and trimmed for you. |
| `cli_not_executable` / `cli_not_found` | 22 | The CLI is not installed or not on `PATH`. In CI the install step is skipped on a dry run by design; locally, install the reviewed version or set `AGENT_CLAUDE_BIN` / `AGENT_CODEX_BIN`. |
| `isolation_setup_failed` | 22 | The temporary provider runtime could not be created. Check the runner filesystem and the temp directory. |
| `cli_timeout` | 30 | Raise `AGENT_TIMEOUT_SECONDS` (max 600, and it must fit the 8-minute budget). Not retried on purpose: the call may already have reached the model. |
| `preconnect_network_failure` | 31 | Claude-only diagnostic for trusted DNS or connection setup evidence before acceptance. Codex 0.154.0 reports CLI-reported network failures as non-retryable `unknown_failure` because no structured pre-connection discriminator is available. |
| `unclassified` | 40 | The CLI said something we do not recognise — often a new CLI version. Claude may include a redacted, bounded excerpt; Codex deliberately reports only event-shape metadata. Add a signal to the relevant `classify.ts` and bump the reviewed CLI version deliberately. |
| Consumer-enabled scheduled runs stopped | — | Confirm that your own `schedule` block is still present. GitHub can disable scheduled workflows after 60 days of repository inactivity; re-enable the workflow in the Actions tab if needed. |
| Consumer-enabled run was minutes late | — | Expected. GitHub cron is best-effort. |

### Claude only

| Symptom | Exit | Cause and fix |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN is not set` | 20 | The environment secret is missing or misnamed. Check *Settings → Environments → usage-window-claude → Environment secrets*. Also confirm that the Environment deployment rule allows the protected default branch. |
| `…appears to be a usage-billed API key` | 20 | You stored an `sk-ant-api…` key. Run `claude setup-token` to get a subscription token instead. |
| `auth_failed` | 21 | Token expired, revoked, or the subscription changed. Regenerate and update the secret. |
| `credit_balance_low` | 21 | Claude is billing against API credits, not your subscription — the wrong credential is in play. |
| `ambiguous_upstream` / `ambiguous_network` | 40 | The request may have reached Claude, so it is not retried. |

### Codex only

| Symptom | Exit | Cause and fix |
| --- | --- | --- |
| `CODEX_ACCESS_TOKEN is not set` | 20 | The environment secret is missing or misnamed. Check *Settings → Environments → usage-window-codex → Environment secrets* and confirm that its deployment rule allows the protected default branch. If your workspace is ChatGPT Plus/Pro/Go, you cannot create a Codex access token at all — see [Known limitations](#known-limitations). |
| `…appears to be an OpenAI Platform API key` | 20 | You stored an `sk-…` key. That bills your Platform account, not your ChatGPT plan. Create a Codex access token at <https://chatgpt.com/admin/access-tokens>. |
| `CODEX_ACCESS_TOKEN is too short` | 20 | A truncated paste or a placeholder. The token can only be read once at creation; if you lost it, revoke it and create a new one. |
| `config.api_key_ignored` warning | — | `CODEX_API_KEY` or `OPENAI_API_KEY` is in the job environment. Not fatal — it is never forwarded — but remove it so nobody later assumes it is being used. |
| `auth_failed` | 21 | Most often the token expired (90 days maximum). Also: revoked, the workspace member deprovisioned, or the workspace's `forced_login_method` set to `api`. There is also an open upstream report of `401 Unauthorized` for Business access tokens — [openai/codex#25246](https://github.com/openai/codex/issues/25246) — which the adapter cannot work around. For a production-equivalent local check, use the isolated command below before assuming the secret is wrong. |
| `api_billing_path_detected` | 21 | Codex returned a Platform quota/billing error, so an API key is in play rather than the access token. Check that `CODEX_ACCESS_TOKEN` holds the right value and that no API key is set. |
| `usage_limit_reached` | 10 | Expected. The ChatGPT plan or workspace credit limit is currently reached. |
| `provider_rate_limited` | 40 | A 429 or generic rate limit. Deliberately **not** reported as a plan usage window, because the output does not say which limit was hit. Decide conservatively whether to invoke again; the project does not retry it. |
| `invalid_request` | 40 | Usually `vars.AGENT_CODEX_MODEL` naming a model your workspace cannot use. Clear it to fall back to the CLI default, and check *workspace model availability*. |
| `sandbox_error` | 40 | Codex could not establish its read-only sandbox. Expected on unusual runners; `ubuntu-latest` is what this is tested against. |
| `incomplete_turn` | 40 | Exit 0 but no `turn.completed`. Usually a CLI version whose `--json` stream has changed. Check the `cliLastEvent` and, when present, `malformedOutputLines` metadata, then review the pinned version. |
| `malformed_jsonl` | 40 | A truncated or otherwise malformed JSON line was emitted; inspect the pinned CLI contract before retrying manually. |
| `trailing_output` | 40 | Unstructured output appeared after a terminal turn event; the result was not trusted. |
| `conflicting_terminal_evidence` | 40 | Completion and failure evidence coexist; allowance consumption is ambiguous and the run was not retried. |
| `completed_turn_nonzero_exit` | 40 | The turn completed but the process failed afterwards. Allowance was probably consumed, so it is not retried. Inspect the job log. |
| `completed_turn_without_response` | 40 | The CLI reported a completed turn without one non-empty agent response. Review the pinned JSONL contract. |
| `invalid_event_sequence` | 40 | Known JSONL events were missing, duplicated, out of order, or appeared outside the active turn. Review the pinned JSONL contract. |
| `unexpected_response_count` | 40 | More than one agent response was reported for the completed turn. Review the pinned JSONL contract. |
| `ambiguous_stream` | 40 | The response stream dropped after the invocation began. It may have reached the model, so it is not retried. |

For a production-equivalent local authentication check, export
`CODEX_ACCESS_TOKEN` in your shell and run this with a temporary runtime. It
does not use `codex login` or your normal Codex home:

```bash
codex_tmp="$(mktemp -d)"
trap 'rm -rf "$codex_tmp"' EXIT
mkdir -p "$codex_tmp/home" "$codex_tmp/codex-home" "$codex_tmp/tmp" "$codex_tmp/cwd"
HOME="$codex_tmp/home" CODEX_HOME="$codex_tmp/codex-home" TMPDIR="$codex_tmp/tmp" \
  CODEX_ACCESS_TOKEN="$CODEX_ACCESS_TOKEN" \
  codex exec --json --ephemeral --skip-git-repo-check \
    --sandbox read-only --ask-for-approval never \
    --ignore-user-config --ignore-rules --color never \
    --strict-config \
    --config 'forced_login_method="chatgpt"' \
    --config 'cli_auth_credentials_store="ephemeral"' \
    --config 'web_search="disabled"' \
    --config 'features.shell_tool=false' \
    --config 'tools.view_image=false' \
    --config 'history.persistence="none"' \
    -- 'Reply with the single word: ok'
```

---

## Security

**Credential handling**

- Credentials live only in GitHub Actions secrets. Nothing credential-shaped is
  committed — `.gitignore` covers `.claude/`, `.codex/`, `.credentials.json`,
  `auth.json` and `.env*`.
  The application does not write Codex authentication state itself. For the
  pinned CLI, the token is passed through the environment and
  `cli_auth_credentials_store="ephemeral"` is intended to keep the CLI from
  caching it; the repository cannot independently prove that CLI-internal
  behavior, so re-check it whenever the CLI version changes.
- **Only the subscription credential is accepted, per provider.** Claude takes
  `CLAUDE_CODE_OAUTH_TOKEN` and rejects `sk-ant-api…`; Codex takes
  `CODEX_ACCESS_TOKEN` and rejects `sk-…`. `ANTHROPIC_API_KEY`,
  `CODEX_API_KEY` and `OPENAI_API_KEY` are never used for authentication or
  forwarded to a provider child process; their values may be read only for
  redaction and presence warnings. Codex also
  passes `forced_login_method="chatgpt"` so the CLI itself will not accept an
  API credential. See [Authentication and billing](#authentication-and-billing).
- **Each provider's workflow declares only its own secret**, so the Codex job
  never has the Claude token in its environment and vice versa. The secret is
  scoped to the single invocation step, and the CLI install runs *before* it is
  introduced, so no install-time lifecycle script can observe it.
- The CLI child process receives an **allowlisted** environment (`PATH`,
  `LANG`, `LC_ALL`, `TZ`) plus the credential — never a copy of the job's
  environment, so no other CI secret and no other provider's credential is
  reachable from it. Each invocation also gets isolated temporary `HOME`, temp
  and working directories (and `CODEX_HOME` for Codex), preventing repository-,
  project- or user-level settings from changing the request.
  `tests/codex-provider.test.ts` asserts the exact set of variables the child
  receives.
- **The Codex process cannot modify the checkout or persistent project state.**
  It runs with `--sandbox read-only`, in a temporary directory rather than the
  checkout, with `--ignore-user-config`, `--ignore-rules`, and the shell,
  image-viewer and web-search capabilities currently identified by the pinned
  CLI disabled. The read-only sandbox and temporary directory are the primary
  mutation controls; the capability overrides are defense in depth.
  `--ephemeral` and `history.persistence="none"` reduce retained session/history
  state; temporary runtime files may still be written and are removed after the
  invocation.
- Cleanup is best effort and never replaces the provider outcome. Hosted
  runners are normally discarded after the job; operators using persistent
  self-hosted runners should monitor and purge leftover `usage-window-claude-*`
  and `usage-window-codex-*` temporary directories.
- The prompt is passed after a `--` terminator and never through a shell, so
  neither a prompt beginning with `-` nor shell metacharacters can change the
  command.
- Every log line, diagnostic and job summary passes through `redact()`, which
  scrubs both known secret values and credential-shaped strings (API keys, JWTs,
  `Authorization:` values). Redaction is armed with *every* provider's
  credential names before anything can log, not just the selected provider's.
- **Codex output is treated as hostile.** `codex exec --json` item and error
  events, as well as stderr, can carry command output, file contents, response
  text or identifiers. The classifier never quotes provider output; it reads
  only bounded numeric fields, known event types, exact typed error
  discriminants and allowlisted scalar messages. Thread ids are never
  recorded. Output capture is capped at 64 KiB per stream.

**Pipeline**

- `permissions: contents: read` — the workflows write nothing back.
- Each provider CLI is installed at a literal reviewed package/version in its
  workflow (`@anthropic-ai/claude-code@2.1.268`, `@openai/codex@0.154.0`), with
  npm audit/funding side work disabled;
  upgrades require a reviewed change and adapter validation, because both the
  flag set and the output contract are external. They are intentionally
  installed separately from this application's lockfile: an official CLI is a
  provider runtime, not an application library, and its install lifecycle is
  owned by the provider. Lifecycle scripts remain enabled because the package
  may use them for platform setup; they run before the provider secret is
  introduced and must be reviewed again on every runtime upgrade. This accepts
  registry-integrity risk for the exact reviewed version in exchange for
  keeping the application dependency graph and deployment lifecycle separate.
- No `pull_request` trigger on either workflow that holds a secret, and
  `persist-credentials: false` on checkout, so forks cannot reach them. The
  Codex workflow additionally carries OpenAI's own caveat: use access tokens
  only on trusted runners, never on public CI or forked pull requests.
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
  update the SHA deliberately when upgrading. No third-party action is used —
  including `openai/codex-action`, which is excluded both by that policy and
  because its credential input is an API key.
  [`.github/actions/classify-outcome`](.github/actions/classify-outcome/action.yml)
  is a local composite action in this repository: it takes no secret, runs no
  provider code, and exists so the exit-code contract has one mapping in CI.
- [`tests/workflows.test.ts`](tests/workflows.test.ts) asserts these pipeline
  properties as tests, so a future edit that loosens one fails CI.

### Rotating and revoking credentials

Rotate periodically, and immediately whenever someone with repository access
leaves. For Codex, rotation is **not optional**: the token expires within 90
days, so put its expiry in a calendar.

**Claude — rotate:**

1. `claude setup-token` on your machine to mint a fresh token.
2. Update the `CLAUDE_CODE_OAUTH_TOKEN` environment secret in
   `usage-window-claude`.
3. Run *Provider invocation (Claude)* manually with `dry_run: false` to confirm.
4. Revoke the old token.

**Claude — revoke** (do this immediately if a token may have leaked): remove it
from your Claude account's connected applications / API-and-token settings, then
delete the environment secret from `usage-window-claude`.

**Codex — rotate:**

1. Create a replacement token at <https://chatgpt.com/admin/access-tokens>
   with the **Codex** scope only. Create the new one *before* revoking the old
   one, so any consumer-enabled recurrence is not left with a dead credential.
2. Update the `CODEX_ACCESS_TOKEN` environment secret in `usage-window-codex`.
3. Run *Provider invocation (Codex)* manually with `dry_run: false` to
   confirm — a dry run cannot validate a credential.
4. Revoke the old token from the same admin page.

**Codex — revoke** (do this immediately if a token may have leaked): revoke it
on the *Access tokens* admin page, then delete the environment secret from
`usage-window-codex`. A revoked
token cannot be un-revoked, and a token's value can never be read back from the
console — only replaced.

In both cases the next run is expected to fail fast with exit code 21 when the
CLI reports recognized authentication evidence; an unrecognized response fails
closed with exit code 40. Check the repository's Actions logs for the runs that used
the exposed credential; because logs are redacted, the value should not appear
in them, but treat any leak as real and rotate anyway. Revoking a Codex access
token also removes it from the workspace audit surface, which is where you can
confirm what it was used for.

---

## Development

```bash
npm ci
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run check        # both
```

**Tests never contact a provider and never need a real secret.** The provider
port and the process runner are substituted with fakes, and the clock and sleep
are injected, so every test is deterministic and offline.

| File | Covers |
| --- | --- |
| `tests/orchestrator.test.ts` | The use case against a stub provider: success, retry-then-succeed, budget exhaustion, no-retry for every non-transient status, dry run, contract-violating adapter, abort backstop. |
| `tests/classify.test.ts` | Claude output parsing and classification against representative CLI output. |
| `tests/claude-provider.test.ts` | Claude argument construction, token refusal, environment allowlist, redaction. |
| `tests/codex-classify.test.ts` | Codex JSONL parsing and classification: structured success, usage limits vs. rate limits, auth failures, non-retryable network prose, classified post-connection failures, malformed and noisy streams, redaction, and the rule that item payloads never reach a diagnostic. |
| `tests/codex-provider.test.ts` | Codex command construction (read-only, repository-free, identified execution capabilities disabled, `--` terminated), credential refusal including API keys, the exact child environment, runtime isolation, and cleanup. |
| `tests/catalog.test.ts` | Provider selection, per-provider credential and billing-warning wiring, and that a dry run constructs no real adapter. |
| `tests/workflows.test.ts` | The GitHub Actions declarations: no active upstream provider schedule, manual/dry-run availability, deterministic provider selection, per-provider secret isolation, concurrency protection, pinned runtimes and actions, least-privilege permissions, no shell interpolation, and complete exit-code coverage. |
| `tests/retry.test.ts` | Retry decisions and the status policy table. |
| `tests/config.test.ts` | Validation, ranges, multi-problem reporting, CLI overrides, and that both providers share the same configuration semantics. |
| `tests/observability.test.ts` | Redaction, log structure/filtering, secret-free summaries for both providers. |
| `tests/process-runner.test.ts` | Child-process isolation: environment allowlist, no shell, bounded output with truncation reporting, and prompt termination on abort with no orphaned processes. |

**What the tests cannot cover.** GitHub Actions *behaviour* — delivery of a
consumer-added cron, concurrency queueing, secret masking — has no application
code to exercise;
`tests/workflows.test.ts` checks the declarations only. See
[Validating overlap protection](#validating-overlap-protection) for the manual
procedure, and note that a real end-to-end authentication check requires a real
manual run for each provider.

### Layout

```
src/
  core/            # no I/O, no provider knowledge — the hexagon
    invocation.ts    statuses, request/result, the status policy table
    provider.ts      minimal AgentProvider port
    orchestrator.ts  the single use case
    retry.ts         retry decisions
    logging.ts       Logger port + redaction
  providers/
    provider-configuration-error.ts  the one error the root maps to exit 20
    catalog.ts       the two-entry provider table + the dry-run stub
    claude/          claude -p --output-format json
    codex/           codex exec --json
  adapters/          process runner, JSON logger, GitHub summary,
                     unhandled-error fallback
  config.ts          validation
  main.ts            composition root: argv, env, exit codes

.github/
  workflows/usage-window-trigger.yml        Claude manual dispatch
  workflows/usage-window-trigger-codex.yml  Codex manual dispatch
  workflows/ci.yml                          typecheck + tests, no secrets
  actions/classify-outcome/                 exit code -> annotation, shared
```

Architecture rationale and rejected alternatives:
[ADR 0001](docs/adr/0001-architecture.md).
Codex authentication, workflow and isolation decisions:
[ADR 0002](docs/adr/0002-codex-provider.md).
Consumer-owned scheduling decision and migration:
[ADR 0003](docs/adr/0003-consumer-owned-scheduling.md).
Scheduling activation guide: [docs/scheduling.md](docs/scheduling.md).
Version-pinned Codex contract and upgrade checklist:
[docs/codex-0.154.0-contract.md](docs/codex-0.154.0-contract.md).
Adding an agent: [docs/adding-a-provider.md](docs/adding-a-provider.md).

---

## Provider differences that matter

The `AgentProvider` boundary makes the two providers interchangeable *to the
orchestrator*. It does not make them interchangeable to you.

| | Claude | Codex |
| --- | --- | --- |
| **Plan requirement** | Any plan that supports `claude setup-token` | ChatGPT **Business or Enterprise** workspace |
| **Credential lifetime** | Long-lived | 90 days maximum — rotation is mandatory |
| **Credential recovery** | Re-mint any time | Readable only at creation; lost means revoke and replace |
| **Model aliases** | `haiku`, `sonnet`, … | Unrelated names, and workspace-gated |
| **Turn bound** | `--max-turns 1`, enforced by the CLI | No such flag; identified execution capabilities are disabled and the read-only sandbox is primary |
| **Success signal** | One JSON result envelope | A JSONL event stream; needs one clean `turn.completed` and one non-empty agent response |
| **Usage-limit clarity** | `usage limit reached` is explicit | `UsageLimitExceeded` is explicit, but a 429 is *not* attributed to a plan window |
| **Billing entity** | Your Claude account | Your ChatGPT **workspace**, so usage is attributed to a workspace member and visible in workspace analytics |
| **Repository access** | Isolated temp cwd | Isolated temp cwd **and** `--sandbox read-only` |

Three assumptions to avoid:

1. **Do not copy `AGENT_MODEL` between providers.** A Claude alias passed to
   Codex produces `invalid_request` (exit 40), which is why the model override
   is a separate repository variable per provider.
2. **Do not read a Codex `provider_rate_limited` as "my plan limit is
   reached".** It means the CLI reported a rate limit that the output does not
   attribute to a plan window. Only `usage_limit_reached` (exit 10) means that.
3. **Do not expect a Codex success to imply anything about your Claude
   allowance, or vice versa.** They are independent provider integrations with
   independent concurrency groups and any recurrence you choose for them.

---

## Known limitations

- **Window state is not observable, for either provider.** Neither Anthropic
  nor OpenAI documents usage-window or reset semantics as something a client
  can read. This tool therefore never claims to have started or reset a
  window — it reports only that a minimal authenticated invocation was issued
  and accepted. Treat the timing benefit as a reasonable expectation, not a
  guarantee.
- **Codex needs a ChatGPT Business or Enterprise workspace.** Codex access
  tokens are not available on Plus, Pro, Go or Free, and there is no other
  officially supported unattended *subscription* credential: device-code login
  is interactive, and copying `~/.codex/auth.json` is session copying that
  OpenAI's own guidance excludes for public repositories and that requires
  persisting refreshed credential state between runs. We did not substitute an
  API key, because that changes the billing account — see
  [ADR 0002](docs/adr/0002-codex-provider.md#1-authentication-and-billing). If
  you are on Plus or Pro, the Codex provider is not usable for you today; use
  the Claude workflow and do not configure or schedule Codex.
- **Codex access tokens expire within 90 days.** After expiry, a real invocation
  is expected to fail with exit code 21 when the CLI reports recognized
  authentication evidence; an unrecognized response fails closed with exit
  code 40. There is no in-product reminder; use a calendar.
- **Codex access tokens have a known open upstream failure report.**
  [openai/codex#25246](https://github.com/openai/codex/issues/25246) reports
  `401 Unauthorized` for Business access tokens against
  `chatgpt.com/backend-api/codex/responses`, apparently server-side. The
  adapter classifies it as `auth_failure` and cannot work around it. Validate a
  new token with a real manual invocation before trusting consumer-enabled
  recurrence.
- **Provider behaviour can change, and these are external contracts.** Quota
  rules, CLI flags and error text belong to Anthropic and OpenAI. Structured
  output is preferred for both, but the fallback text classification in
  `src/providers/*/classify.ts` may need updating after a CLI release. Every
  field either adapter reads is optional, and an unrecognised message becomes
  `unknown_failure`, which fails safe (no retry) rather than guessing.
  The version-sensitive Codex assumptions are: `codex exec`'s flag names, that
  `--config` values parse as TOML, that the `--json` stream emits
  `turn.completed` on success, that `CODEX_ACCESS_TOKEN` is honoured without a
  login step, and that `codex exec` still defaults to a read-only sandbox.
  Re-check them before changing the literal Codex package version in the
  provider workflow.
- **`--strict-config` is passed to Codex.** The pinned CLI is expected to reject
  a renamed, removed or rejected hardening config key before proceeding to a
  remote invocation. The local CLI process already has the token in its
  environment, and this repository cannot independently prove whether that
  rejection occurs before network activity. The closed environment,
  read-only sandbox, neutral directory and disposable runtime remain the
  primary controls. Revalidate this flag and every hardening key when
  upgrading the CLI.
- **Consumer-enabled GitHub cron is best-effort.** It uses UTC and may be
  delayed; choose and operate your schedule accordingly.
- **A dry run proves less than it looks like it proves.** It validates
  non-secret configuration, provider selection and orchestration wiring. It
  does *not* validate or forward a credential, install a CLI, or contact a
  provider, so it cannot tell you that a credential is present, current,
  correctly scoped, or accepted — nor that the CLI is installed. The entry
  point may read configured secret values only to arm output redaction. Only a
  real run can validate the provider boundary.
- **`total_cost_usd`** reported in Claude metadata is the CLI's own figure. On
  a subscription it is an equivalence estimate, not an invoice line. Codex
  reports token counts rather than a cost figure.
- **One account, one provider per run.** Multi-account fan-out is out of scope.
  The two providers remain independent jobs, whether manually dispatched or
  scheduled by a consumer; they are not a fan-out.
