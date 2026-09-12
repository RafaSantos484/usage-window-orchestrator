# Codex CLI 0.154.0 reviewed contract

This record captures the external assumptions used by the Codex provider. It
was reviewed on **2026-09-11** against the workflow pin
`@openai/codex@0.154.0` / `rust-v0.154.0`. It is an evidence record, not a
claim that a live provider invocation was performed.

## Authentication and billing

The [official access-token documentation](https://learn.chatgpt.com/docs/enterprise/access-tokens)
states that Codex access tokens are ChatGPT workspace credentials for trusted
non-interactive local workflows, are currently supported for Business and
Enterprise workspaces, and are used for ephemeral automation by setting
`CODEX_ACCESS_TOKEN` before running `codex exec`. The same page documents Codex
scope, finite expiry, one-time display, rotation, and revocation.

The [official authentication documentation](https://learn.chatgpt.com/docs/auth)
distinguishes ChatGPT-managed access tokens from API keys. API-key runs use
standard OpenAI Platform billing; they are not interchangeable with the
workspace credential selected by this provider.

## Invocation and output

The [official non-interactive-mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
documents `codex exec` for scripts and CI, `--json` JSONL output, read-only
automation defaults, `--ephemeral`, and the event families used by the
classifier (`thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
`item.*`, and `error`).

For the pinned projection, the routine item lifecycle members exercised by the
adapter are `item.started`, `item.updated`, and `item.completed`. The parser
uses that explicit set for fail-closed top-level event handling and inspects
only `item.completed` agent-message fields for response evidence. Each item
event must carry an item id that was introduced by `item.started`; updates and
completion for unknown or already completed ids are invalid. Success also
requires the ordered lifecycle `turn.started` -> item events ->
`turn.completed`, with exactly one start and completion, no incomplete item at
the successful terminal event, and no known structured event after the terminal
event. A `turn.failed` stream may contain a partial item because it is already
a failed invocation.

The [official CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
documents the pinned command surface used by `buildArgs`: `--ephemeral`,
`--ignore-user-config`, `--ignore-rules`, `--json`, `--model`, `--sandbox`,
`--skip-git-repo-check`, `--color`, and repeatable `--config` values.

The version-pinned configuration source is the review point for the inline
hardening keys used by this repository: `forced_login_method`,
`cli_auth_credentials_store`, `web_search`, `features.shell_tool`,
`tools.view_image`, and `history.persistence`. These settings are deliberately
passed with `--strict-config`; the pinned CLI is expected to reject unsupported
or renamed keys before proceeding to a remote invocation, but this repository
does not independently prove the CLI's network-call ordering. The local CLI
process already has the token in its environment; the adapter's primary
controls are the read-only sandbox, neutral working directory, closed child
environment, and disposable runtime.

The version-pinned [Codex release](https://github.com/openai/codex/releases/tag/rust-v0.154.0)
and tagged source links below are the review points for exact implementation
details that may change independently of the public documentation:

- [`exec` CLI definition](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/cli.rs)
- [authentication manager](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/auth/manager.rs)
- [configuration schema](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/config_toml.rs)
- [JSONL event projection](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/exec/src/exec_events.rs)

## Reviewed artifact evidence

The reviewed runtime reported `codex-cli 0.154.0` for `codex --version`.
`codex exec --help` was inspected for the pinned CLI and confirmed the command
surface used by the adapter: `--json`, `--ephemeral`,
`--skip-git-repo-check`, `--sandbox`, `--ask-for-approval`,
`--ignore-user-config`, `--ignore-rules`, `--color`, `--strict-config`,
`--config`, and `--model`. This is a sanitized record of the observed help
surface, not a runtime provider test or a substitute for rechecking the
published artifact during a version bump.

Sanitized excerpt captured from that inspection:

```text
$ codex --version
codex-cli 0.154.0

$ codex exec --help
Run Codex non-interactively
Usage: codex exec [OPTIONS] [PROMPT]

  --config <key=value>
  --strict-config
  --model <MODEL>
  --sandbox <SANDBOX_MODE>
  --skip-git-repo-check
  --ephemeral
  --ignore-user-config
  --ignore-rules
  --color <COLOR>
  --json
```

The excerpt is a manually captured, sanitized observation of the pinned local
runtime. It does not prove authentication, billing, or a live provider call;
it also does not prove the CLI's network-call ordering for strict-config
failures or whether credential-store/history settings prevent every internal
write. Repeat the inspection and re-check those runtime behaviours when
upgrading the runtime.

## Installation policy

The provider workflow installs the literal `@openai/codex@0.154.0` package with
`--no-audit --no-fund`, before `CODEX_ACCESS_TOKEN` is introduced. Lifecycle
scripts are intentionally not disabled with `--ignore-scripts`: the published
package may rely on them for platform setup. This leaves registry and install-
script integrity as a residual supply-chain risk; review the exact published
artifact and its install behavior again whenever the version changes.

## Review procedure for a version bump

Before changing the literal Codex package version in
`.github/workflows/usage-window-trigger-codex.yml`:

1. Read the current official access-token, non-interactive, and CLI command
   references above.
2. Compare the tagged source and `codex exec --help` for every flag and config
   key used by `src/providers/codex/codex-cli-provider.ts`.
3. Compare the JSONL event projection with
   `src/providers/codex/classify.ts`, preserving fail-closed handling for
   unknown objects and the single-response success contract.
4. Run `npm run typecheck`, `npm test`, and `git diff --check` before merging.

No API key, browser session, persisted login directory, or live provider call
is part of this evidence record.

## Retry limitation

The pinned `codex exec --json` projection does not provide a trusted
pre-connection discriminator that this adapter can use for `TRANSIENT_FAILURE`.
Accordingly, Codex `0.154.0` never retries CLI-reported DNS or connection
errors: prose is treated as ambiguous `UNKNOWN_FAILURE`. This is deliberate;
do not restore a retryable path from stderr or free-form error messages without
first reviewing a structured provider signal.
