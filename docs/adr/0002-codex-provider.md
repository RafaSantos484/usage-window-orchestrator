# ADR 0002 — Adding Codex as a second provider

- **Status:** Accepted
- **Date:** 2026-09-11
- **Context:** The first real second provider, which is what
  [ADR 0001](0001-architecture.md) said should drive any change to the
  provider boundary.
- **Supersedes:** nothing. Extends ADR 0001's operational decisions.
- **Scheduling policy superseded by:**
  [ADR 0003](0003-consumer-owned-scheduling.md). The per-provider workflow and
  isolation decision remains accepted; its active cron values do not.

## Decision

Add a Codex adapter behind the existing `AgentProvider` port, authenticated
with a **Codex access token** (`CODEX_ACCESS_TOKEN`), invoked through its **own
workflow file**, and executed through `codex exec --json` in a **read-only,
repository-free** child process with the currently identified execution
capabilities disabled.

```text
cron / manual dispatch
          |
          v
GitHub Actions -> src/main.ts -> UsageWindowOrchestrator -> AgentProvider
                                                        |
                                                        +-> ClaudeCodeProvider
                                                        +-> CodexCliProvider
```

No provider-neutral contract or runtime behavior changed in `src/core/`; only
clarifying documentation comments were updated in `src/core/invocation.ts`.
The second provider produced no provider-neutral variation the existing
contract could not express: the same
`InvocationRequest`, the same eight `InvocationStatus` values, the same retry
policy, and the same `ProviderMetadata` shape all fit. Codex's distinguishing
facts are carried as provider-specific *diagnostic codes*, which is exactly the
escape hatch ADR 0001 reserved for this.

Documentation ownership is intentionally split. The README is the operator
entry point for setup, security, and troubleshooting; the scheduling guide
records consumer activation after ADR 0003. This ADR
records the architectural decision and rejected alternatives. The pinned
contract document is authoritative for version-specific Codex flags, event
shapes, and upgrade checks. Provider-extension rules remain in
`docs/adding-a-provider.md`.

## 1. Authentication and billing

**Chosen: `CODEX_ACCESS_TOKEN`, a Codex access token.** It is the officially
documented credential for "trusted non-interactive local workflows, including
Codex CLI", it is read directly from the environment with no login step, it is
a ChatGPT *workspace* credential — so usage draws on the workspace's ChatGPT
plan allowance rather than OpenAI Platform API billing — and it can be created,
scoped, expired (1–90 days), rotated and revoked from the ChatGPT admin
console. That matches the property the Claude adapter exists to protect:
a subscription trigger must not silently become a per-token bill.

**Documented limitation:** Codex access tokens are currently supported for
**ChatGPT Business and Enterprise workspaces only**. There is no officially
supported unattended subscription credential for Plus, Pro, Go or Free. This
is a real gap, and it is recorded as a gap rather than papered over.

### Authoritative references and reviewed assumptions

Reviewed on **2026-09-11** against the pinned `@openai/codex@0.154.0`
(`rust-v0.154.0`). These are the version-sensitive sources used for the
adapter and workflow; GitHub issues are tracked separately as limitations,
not as contract evidence.

- [Codex 0.154.0 release](https://github.com/openai/codex/releases/tag/rust-v0.154.0) — reviewed runtime version and release artifacts.
- [Codex exec CLI definition at `rust-v0.154.0`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/cli.rs) — `exec`'s non-interactive form, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, and prompt handling.
- [Codex authentication manager at `rust-v0.154.0`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/manager.rs) — `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, and `OPENAI_API_KEY` environment names and access-token loading.
- [Codex configuration schema at `rust-v0.154.0`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/config_toml.rs) — `forced_login_method` and `cli_auth_credentials_store` configuration fields.
- [Codex JSONL event projection at `rust-v0.154.0`](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/exec_events.rs) — the external event boundary treated as unstable by the adapter.
- [Official Codex access-token documentation](https://learn.chatgpt.com/docs/enterprise/access-tokens) — Business/Enterprise availability, workspace billing semantics, expiry, rotation, revocation, and ephemeral `CODEX_ACCESS_TOKEN` use with `codex exec`.
- [Official Codex non-interactive-mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode) — CI use of `codex exec`, `--json`, event types, sandbox defaults, and automation authentication guidance.
- [Official Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) — reviewed `exec` flags including `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--json`, `--sandbox`, `--skip-git-repo-check`, and `--config`.

The same evidence is maintained as an operator-facing checklist in
[docs/codex-0.154.0-contract.md](../codex-0.154.0-contract.md), including the
review procedure for a version bump.

The source confirms the CLI surface and credential variable names. It does
not guarantee that a successful invocation starts or resets a usage window,
so this repository makes no such claim. Re-review these links and run the
offline contract tests before changing the literal Codex package version in
the provider workflow.

### Rejected: `CODEX_API_KEY` / `OPENAI_API_KEY`

OpenAI's own guidance calls API keys "the right default for automation", and an
API-key integration would work on any plan. We still reject it, because
`codex exec` with an API key bills "through your OpenAI Platform account at
standard API rates" — a different account and a different billing model from
the ChatGPT plan allowance this product schedules. Shipping it as the Codex
provider would make `AGENT_PROVIDER=codex` mean something categorically
different from `AGENT_PROVIDER=claude`, and the Claude adapter already refuses
the equivalent credential.

We did not ship it as an opt-in mode either. An explicitly opt-in,
API-billed provider is defensible in principle, but it would add a second
billing semantics, a second credential, a second set of statuses to interpret
(an API-key `insufficient_quota` is not a plan usage limit) and a standing risk
that an operator enables it without understanding the invoice. The adapter
therefore treats API keys as a *hazard to detect*: a Platform-key-shaped value
in `CODEX_ACCESS_TOKEN` is refused at construction, `CODEX_API_KEY` and
`OPENAI_API_KEY` are never used for authentication and never reach the child
environment. The application may read their values only to arm redaction and
check presence for a warning, while `forced_login_method="chatgpt"` is passed
as defence in depth.

### Rejected: copying `~/.codex/auth.json`

Technically possible and semi-documented, but it is session copying: the file
holds live OAuth tokens, OpenAI's own guidance says not to use it for public or
open-source repositories, and the cached token goes stale within days unless
Codex is allowed to refresh it *in place* and the refreshed file is persisted
back. That last requirement is the disqualifier — it means mutable
cross-run credential state, which ADR 0001 already rejected for duplicate
suppression, plus committing or caching credential material. `--ephemeral` and
a fresh `CODEX_HOME` per run are incompatible with it by design.

### Rejected: `codex login --device-auth`

The documented headless path, but it is interactive: someone must visit a URL
and enter a code. It cannot run on a cron schedule.

### Rejected: workload identity federation

`OPENAI_IDENTITY_TOKEN_FILE` + federation rules would be the strongest option
for an organisation whose CI already receives OIDC workload tokens, and GitHub
Actions does issue OIDC tokens. It is rejected *for now* as disproportionate:
it needs federation rules configured on the OpenAI side, and it is documented
as an enterprise deployment feature rather than a single-repository one. It is
the natural upgrade if this repository ever runs inside an organisation that
already has federation.

## 2. Workflow and scheduling (active cron policy superseded by ADR 0003)

**Originally chosen:** one workflow file per provider with an active schedule,
plus a local composite action for the shared exit-code mapping.

- `.github/workflows/usage-window-trigger.yml` — Claude, historically with an
  active two-hour UTC policy.
- `.github/workflows/usage-window-trigger-codex.yml` — Codex, historically with
  the same recurrence and a maintainer-selected offset.
- `.github/actions/classify-outcome/action.yml` — exit code → annotation and
  job conclusion, used by both.

The deciding argument is determinism: a `schedule` event carries no
`workflow_dispatch` inputs, so in a shared workflow the scheduled provider
would have to come from a hard-coded fallback or a repository variable, and
`concurrency.group` would silently collapse to that fallback too. Making the
file itself the unit of scheduling removes the ambiguity — the cron in a file
invokes the provider that file is named for, and nothing else.

Secret-bearing jobs use provider-specific GitHub Environments, configured in
repository settings with a deployment branch rule permitting only the
protected default branch. That Environment policy is the enforcement boundary
for manual secret-bearing dispatches. The jobs also retain an in-file guard
against other refs and explicitly check out the default branch as defense in
depth. The default branch, workflow files, and Environment settings must remain
protected by the repository's normal review and branch-protection rules.

The secondary argument is secret isolation. Each workflow declares only its own
provider's secret, so the Codex job never has `CLAUDE_CODE_OAUTH_TOKEN` in its
environment at all. The adapter's environment allowlist already guarantees the
*child process* cannot see it; this makes the guarantee hold one level higher,
where it does not depend on application code being correct.

The composite action answers the one real objection to separate files —
duplicated outcome YAML. It holds no secret, runs no provider code, and gives
the exit-code contract in `src/core/invocation.ts` exactly one mapping in CI.
`tests/workflows.test.ts` asserts that every `ExitCode` value has an arm.

ADR 0003 retains the separate workflow and composite-action decisions but
removes both active cron entries from the canonical repository. Provider
determinism now applies to manual dispatch and to any schedule a consumer adds
to its own copy. The concrete values above are historical facts, not current
defaults or recommendations.

### Rejected: one shared workflow with conditional provider steps

Less YAML, one dispatch surface — but the scheduled provider becomes implicit,
both secrets are declared in one job, and the provider branches
(`if: provider == 'codex'`) multiply across install, credential and annotation
steps in the file a reviewer most needs to read quickly.

### Rejected: a reusable workflow plus thin callers

This keeps per-provider schedules and secrets while sharing the run step, and
it is the design that would scale to five providers. At two providers the
shared part is ~15 lines of `run:` and the conditional install returns anyway
(callers cannot inject steps into a reusable job), so it buys indirection
rather than removing it. Revisit at the third provider.

### Rejected: `openai/codex-action`

OpenAI recommends its action over hand-rolling the CLI in GitHub Actions, and
its API-key proxy is a genuinely good idea. It does not fit here: its
credential input is `openai-api-key`, which is the billing path we reject; it
would replace our orchestrator, retry policy, redaction and normalized result
with its own; and it is a non-`actions/*` action, which this repository's
pinning policy excludes. The concern behind its proxy — keeping the credential
away from repository-controlled code — is addressed instead by scoping the
secret to the single step that runs our own reviewed, dependency-free entry
point, with the CLI install happening *before* the credential is introduced.

## 3. Runtime isolation and the invocation itself

**Chosen: environment-variable authentication inside a fresh temporary runtime
(Options C and A together).** Each invocation gets its own `HOME`, `CODEX_HOME`
(which Codex requires to already exist), temp directory and neutral working
directory, all removed afterwards. The application does not write authentication
state itself. For the pinned CLI, the ephemeral credential-store override is
intended to keep the token from being cached; this remains a version-sensitive
assumption to re-check on upgrades.

The invocation is:

```text
codex exec --json --ephemeral --skip-git-repo-check
           --sandbox read-only --ask-for-approval never
           --ignore-user-config --ignore-rules --color never
           --strict-config
           --config forced_login_method="chatgpt"
           --config cli_auth_credentials_store="ephemeral"
           --config web_search="disabled"
           --config features.shell_tool=false
           --config tools.view_image=false
           --config history.persistence="none"
           [--model <model>] -- <prompt>
```

Three notes on why this shape:

**It cannot touch the checkout.** `--sandbox read-only` forbids writes, the
working directory is a temporary one rather than the checkout, and the
currently identified shell, image-viewer and web-search capabilities are
disabled. The sandbox and neutral directory are the primary controls; the
capability overrides are defense in depth.

**`codex exec` has no turn cap.** Claude's adapter pins `--max-turns 1`; Codex
offers no equivalent. Disabling the shell, the image viewer and web search
helps bound the invocation from the other direction. The exact capability set
is version-sensitive, so the read-only sandbox and neutral directory remain
the primary controls.

**`--strict-config` is passed.** The pinned CLI is expected to reject a renamed,
removed or rejected config key before proceeding to a remote invocation. The
local CLI process already has the token in its environment, and this repository
cannot independently prove whether that rejection occurs before network
activity. The read-only sandbox, neutral directory and closed environment
remain primary controls, while the configuration overrides provide additional
hardening that must not silently disappear.

The prompt is passed last after `--`, so a prompt beginning with `-` cannot be
read as a flag. Nothing goes through a shell.

The shared process runner bounds each captured stdout/stderr stream and reports
when bytes were dropped. Codex treats either truncation flag as
`UNKNOWN_FAILURE` (`output_truncated`) because a retained prefix cannot prove
that no later error, unknown event, or terminal contradiction was emitted.

## 4. Outcome classification

Success requires exactly one ordered turn lifecycle: `turn.started`, at least
one item lifecycle containing the non-empty `agent_message` response, and a
terminal `turn.completed`. Each `item.updated` or `item.completed` must refer to
an item previously introduced by `item.started`; every started item must be
completed before the successful terminal event. It also requires no duplicate or
out-of-order known events, no unknown or untyped JSONL events, and a zero exit
code.
A zero exit code alone is not accepted: `codex exec --json` can emit `error`
and `turn.failed` events, and the run that matters is the one the stream
describes.
The converse — a completed turn with a non-zero exit — becomes
`UNKNOWN_FAILURE` (`completed_turn_nonzero_exit`) rather than a retry, because
allowance was probably already spent. Multiple completed turns and unknown or
untyped event objects become non-retryable `UNKNOWN_FAILURE` outcomes as well.

`TRANSIENT_FAILURE` remains the only retryable status. Claude can use it for
trusted pre-connection DNS/refusal evidence; Codex `0.154.0` does not emit it,
because its available CLI network failures are not exposed through a trusted
pre-connection discriminator. Codex post-connection stream failures, upstream
5xx, timeouts, streams without sufficient structured terminal evidence, generic
rate limits, and CLI-reported network prose are all `UNKNOWN_FAILURE`.
Individual non-JSON lines are protocol noise: they are tolerated and counted,
provided they occur before a terminal turn event and the JSON event stream
otherwise satisfies the success contract. Unstructured output after
`turn.completed` or `turn.failed` fails closed as `trailing_output`.
JSON-shaped malformed lines are not tolerated for success: they fail closed as
`malformed_jsonl`, because they could conceal a later error or terminal event.

The parser deliberately distinguishes protocol noise from protocol changes:
non-JSON lines are tolerated and counted as `malformedOutputLines`, while a
valid JSON object with an unknown or missing `type` fails closed as
`unknown_event_type`. Thus “clean” means one known terminal turn with no
unknown JSON events, malformed JSON lines, or lifecycle violations; it does not
require a completely noise-free pipe. If a trusted `UsageLimitExceeded` token
appears alongside a completed turn or agent response, the result is
`conflicting_terminal_evidence`
and remains a non-retryable `UNKNOWN_FAILURE` rather than a passing warning.
The same diagnostic is used when a clean completed response is accompanied by
recognized non-authentication failure evidence on stderr.
Protocol-integrity diagnostics (`unknown_event_type`, `malformed_jsonl`,
`trailing_output` and `invalid_event_sequence`) take precedence over this
conflict diagnostic because the stream itself is not trustworthy. The status remains non-retryable
`UNKNOWN_FAILURE` in either case.
The reviewed `item.*` family is represented by the known lifecycle events
`item.started`, `item.updated`, and `item.completed`; other new top-level event
types still fail closed. Item events and the agent response must occur between
the single `turn.started` and its terminal event. Item identity is tracked for
the bounded stream: an item must be started before it can be updated or
completed, each item can complete only once, and no item may remain incomplete
at a successful `turn.completed` event. A failed turn may end with a partial
item because it is already a failure outcome. Any of these conditions, a known
structured event after terminal, a terminal event before start, a duplicate turn
start, or an item outside the active turn produces `invalid_event_sequence`.

Two classification choices are worth recording:

- **Structured evidence outranks prose.** The `UsageLimitExceeded` error token
  maps straight to `USAGE_LIMIT_REACHED` only when the exact typed
  `codexErrorInfo.type` field equals that value. A substring in a message,
  item, stderr or unrelated nested field is ignored, and plan-limit prose is
  never sufficient. Credential and
  wrong-billing-path evidence is the deliberate exception: it has global
  precedence over the typed usage-limit result, so a dead credential that also
  mentions a limit fails loudly (exit 21) instead of passing as an expected
  operational outcome (exit 10). Other prose signals remain below the trusted
  typed token.
- **A rate limit is not a usage window.** `rate_limit_exceeded`, "too many
  requests" and a bare 429 become `UNKNOWN_FAILURE` with
  `provider_rate_limited`, because the output does not say which limit was
  reached. Claiming a plan usage window from a 429 would be an unsupported
  claim about state this tool cannot observe.
- **Authentication prose is failure-only fallback evidence.** A message or
  stderr match such as `Unauthorized` may produce `auth_failure` because that
  result fails the job and is never retried, but it can be a false positive if
  a CLI echoes prompt text. It cannot produce `success`,
  `usage_limit_reached`, or `transient_failure`; eliminating this false-positive
  possibility would require a structured authentication discriminator.

No new status was added. `ContextWindowExceeded`, `BadRequest` and
`SandboxError` are real Codex conditions with no provider-neutral meaning, so
they are `UNKNOWN_FAILURE` plus a specific diagnostic code.

## 5. Structural changes outside the adapter

Three small structural changes are outside `src/core/`; the only core change
is the documentation-only clarification noted above:

- `src/providers/provider-configuration-error.ts` — `ProviderConfigurationError`
  moved out of the Claude adapter so both adapters raise the one type the
  composition root maps to `ExitCode.CONFIG_ERROR`. Re-exported from its old
  location; no behaviour change.
- `src/providers/catalog.ts` — a frozen two-entry table of
  `{ id, secretEnvNames, billingCredentialPresent, billingWarning, create }`,
  plus `dryRunProvider`. This is a lookup table, not a registry: nothing
  registers at runtime, there is no capability negotiation and there is no
  container. It exists because the composition root needs four provider facts,
  and a `switch` would spread them across two branches — and because pulling
  them out of `main.ts` makes provider selection and the dry-run stub testable
  offline, which `main.ts` (which executes on import) is not.
- `src/main.ts` — now warns about the *selected* provider's usage-billed
  credential rather than Anthropic's unconditionally, and arms redaction with
  every provider's credential names regardless of which one runs.

## Security consequences

- Only `CODEX_ACCESS_TOKEN` is accepted for Codex; `CODEX_API_KEY` and
  `OPENAI_API_KEY` are never used for authentication or forwarded to the child
  process. Their values may be read by the composition root only for redaction
  and presence warnings, and Platform-key-shaped values are refused at
  construction.
- The Codex child receives an allowlisted environment (`PATH`, `LANG`,
  `LC_ALL`, `TZ`) plus isolated `HOME`, `CODEX_HOME`, temp and working
  directories, plus the access token. No other CI secret — and no Claude
  credential — is reachable from it.
- The provider process runs without a shell, read-only, outside the checkout,
  with the currently identified execution capabilities disabled, bounded output
  capture and process-group termination on abort.
- No Codex provider output is quoted in a diagnostic. Item and error-event
  payloads and stderr are untrusted; only allowlisted scalar messages and exact
  typed discriminants are used for classification. The thread id is never
  recorded, and fallback diagnostics contain fixed summaries plus known event
  type names only.
- Each provider workflow has read-only repository permissions, no
  pull-request trigger, disabled checkout credentials, a bounded job timeout,
  immutable first-party Action pins, and only its own provider's secret.

## Limitations

- Codex access tokens require a ChatGPT Business or Enterprise workspace.
- They expire after at most 90 days, so Codex operators need a calendar
  reminder whether invocations are manual or consumer-scheduled.
- Codex access tokens have a known open upstream report of `401 Unauthorized`
  against `chatgpt.com/backend-api/codex/responses`
  ([openai/codex#25246](https://github.com/openai/codex/issues/25246)). The
  adapter classifies that as `auth_failure`; it cannot work around it.
- ChatGPT workspace credit controls can pause eligible Codex activity. Whether
  that surfaces as `UsageLimitExceeded` or as something else is not documented.
- `codex exec --json` event types are documented, but individual event
  *payloads* are only shown by example. Every field the adapter reads is
  optional, and an unreadable stream fails safe.
- As with Claude, provider quota-window state is not observable. The
  application reports the invocation outcome, not whether a window started or
  reset.
